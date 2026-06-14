import { EventEmitter } from '../core/events.js';
import { VERIFICATION_MINT_AMOUNT } from '../core/dag-block.js';
import {
  createOpenBlock,
  createBlock,
  computeContentHash,
  verifyBlockSignature,
  GENESIS_PREV,
  type Block,
} from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';
import { checkQuorum, type TypedAttestation, type QuorumPolicy } from '../engine/core/attestation.js';
import { InMemoryIdentityRegistry, deriveCommitment, type Nullifier } from '../engine/core/identity.js';
import { getShard, DEFAULT_NUM_SHARDS } from '../engine/core/partition.js';
import { proveDoubleSpend, verifyDoubleSpend, type DoubleSpendEvidence } from '../engine/consensus/fraud.js';

/**
 * Minimal signer shape the engine block builders need (compressed P-256 pub +
 * 32-byte priv, both hex). NOTE: the app's existing accounts use WebCrypto ECDSA
 * (CryptoKey / base64) for face+PIN recovery — those are NOT engine keys. Wiring
 * real accounts requires reconciling the key systems (give accounts an engine
 * keypair, or back the engine signer with the app's WebCrypto signData). Flagged
 * in the incompatibility report.
 */
export interface SignerKeys {
  pub: string;
  priv: string;
}

/**
 * EngineLedger — the app-facing ledger, implemented on the new scalable engine.
 *
 * This is the core-first vertical slice: account creation (identity-attested,
 * globally deduped) and payments (send/receive/balance) execute on the engine's
 * light-verifiable, shard-tagged account-chain blocks — the same block-lattice
 * semantics the old DAGLedger used, but on the new format and with the new
 * identity model (typed attestations + nullifier dedup).
 *
 * Deliberately NOT included (see incompatibility report / dApp phase): smart
 * contracts, the storage-provider economy, and sharded committee consensus
 * (optimistic confirmation is used here; fork-voting needs staking + transport).
 *
 * Balances are kept as bigint internally (exact) and exposed as `number` in the
 * same milli-UNIT scale the UI already uses.
 */

export interface LedgerAccount {
  username: string;
  pub: string;
}

export interface OpenIdentity {
  nullifier: Nullifier;
  attestations: TypedAttestation[];
}

interface Held {
  chain: Block[];
  acc: AccountAccumulator;
}

const MINT = BigInt(VERIFICATION_MINT_AMOUNT);

/**
 * Recipient-witnessed finality (Phase 2.2): a block received from the network is
 * `pending` for this long after we apply it, then `confirmed` — unless its account
 * is frozen by a double-spend proof first (→ `rejected`). Auto-receive also waits
 * this window before finalizing. Tunable; latency only, no bandwidth cost.
 */
export const CHALLENGE_WINDOW_MS = 5_000;

export class EngineLedger extends EventEmitter {
  private readonly held = new Map<string, Held>();
  private readonly accountsByPub = new Map<string, LedgerAccount>();
  private readonly usernameToPub = new Map<string, string>();
  private readonly identity = new InMemoryIdentityRegistry();
  /** sendBlockHash → unclaimed send, mirroring DAGLedger.unclaimedSends. */
  readonly unclaimedSends = new Map<string, { fromPub: string; toPub: string; amount: number }>();
  /**
   * Phase 2 (fraud-proof safety): accounts proven to have equivocated
   * (double-spent). Their chains are frozen — every block is `rejected` and the
   * balance is void. Evidence is self-verifying (see fraud.ts), so it freezes the
   * account on every node that sees it, with no committee/vote.
   */
  private readonly equivocated = new Map<string, DoubleSpendEvidence>();
  /** hash → local apply time, for foreign blocks within the challenge window. Pruned once settled. */
  private readonly appliedAt = new Map<string, number>();

  constructor(
    readonly network: 'mainnet' | 'testnet' = 'testnet',
    private readonly numShards: number = DEFAULT_NUM_SHARDS,
    /** Identity quorum required on an open block (default: ≥1 personhood attestation). */
    private readonly identityPolicy: QuorumPolicy = { min: 1, requiredTypes: ['personhood'] },
  ) {
    super();
  }

  // ── Accounts / lookup ───────────────────────────────────────────────────────

  registerAccount(account: LedgerAccount): void {
    if (!this.accountsByPub.has(account.pub)) {
      this.accountsByPub.set(account.pub, account);
      if (account.username) this.usernameToPub.set(account.username, account.pub);
      this.emit('account:created', account);
    }
  }

  getAccountByUsername(username: string): LedgerAccount | undefined {
    const pub = this.usernameToPub.get(username);
    return pub ? this.accountsByPub.get(pub) : undefined;
  }

  resolveToPublicKey(identifier: string): string | null {
    if (this.accountsByPub.has(identifier)) return identifier;
    return this.usernameToPub.get(identifier) ?? null;
  }

  // ── Chain state ──────────────────────────────────────────────────────────────

  getAccountHead(pub: string): Block | null {
    const h = this.held.get(pub);
    return h && h.chain.length ? h.chain[h.chain.length - 1]! : null;
  }

  getAccountBalance(pub: string): number {
    if (this.equivocated.has(pub)) return 0;  // frozen: balance void
    const head = this.getAccountHead(pub);
    return head ? Number(head.balance) : 0;
  }

  getAccountChain(pub: string): readonly Block[] {
    return this.held.get(pub)?.chain ?? [];
  }

  getShardOf(pub: string): number {
    return getShard(pub, this.numShards);
  }

  // ── Block creation (owner-signed) ────────────────────────────────────────────

  /**
   * Open an account on the engine. Enforces global one-human-one-account dedup via
   * the nullifier and an attestation quorum, then mints the genesis open block.
   */
  async openAccount(pub: string, keys: SignerKeys, identity: OpenIdentity): Promise<Block> {
    if (this.held.has(pub)) throw new Error('Account already opened');

    const commitment = deriveCommitment(identity.nullifier, pub);
    const quorum = checkQuorum(identity.attestations, commitment, this.identityPolicy);
    if (!quorum.ok) throw new Error(`Identity quorum failed: ${quorum.reason}`);

    const reg = this.identity.register(identity.nullifier, commitment, pub);
    if (!reg.ok) throw new Error(reg.reason ?? 'Identity already used');

    const acc = new AccountAccumulator();
    const block = createOpenBlock(
      {
        accountId: pub,
        identityCommitment: commitment,
        attestations: identity.attestations,
        timestamp: Date.now(),
        balance: MINT,
        numShards: this.numShards,
      },
      keys.priv,
      acc,
    );
    this.held.set(pub, { chain: [block], acc });
    this.allBlocks.set(block.hash, block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block); // optimistic
    return block;
  }

  async createSend(senderPub: string, recipientIdentifier: string, amount: number, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const recipientPub = this.resolveToPublicKey(recipientIdentifier);
    if (!recipientPub) return { error: 'Recipient not found' };
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    if (amount <= 0) return { error: 'Amount must be positive' };
    const amt = BigInt(Math.round(amount));
    if (head.balance < amt) return { error: 'Insufficient balance' };

    const h = this.held.get(senderPub)!;
    const block = createBlock(
      {
        accountId: senderPub,
        index: head.index + 1,
        type: 'send',
        previousHash: head.hash,
        shard: head.shard,
        timestamp: Date.now(),
        balance: head.balance - amt,
        recipient: recipientPub,
        amount: amt,
      },
      keys.priv,
      h.acc,
    );
    h.chain.push(block);
    this.unclaimedSends.set(block.hash, { fromPub: senderPub, toPub: recipientPub, amount });
    this.allBlocks.set(block.hash, block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  async createReceive(recipientPub: string, sendBlockHash: string, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const unclaimed = this.unclaimedSends.get(sendBlockHash);
    if (!unclaimed) return { error: 'Send block not found or already claimed' };
    if (unclaimed.toPub !== recipientPub) return { error: 'This send is not addressed to you' };
    const head = this.getAccountHead(recipientPub);
    if (!head) return { error: 'Account not opened' };

    const h = this.held.get(recipientPub)!;
    const block = createBlock(
      {
        accountId: recipientPub,
        index: head.index + 1,
        type: 'receive',
        previousHash: head.hash,
        shard: head.shard,
        timestamp: Date.now(),
        balance: head.balance + BigInt(Math.round(unclaimed.amount)),
        sourceHash: sendBlockHash,
        amount: BigInt(Math.round(unclaimed.amount)),
      },
      keys.priv,
      h.acc,
    );
    h.chain.push(block);
    this.unclaimedSends.delete(sendBlockHash);
    this.allBlocks.set(block.hash, block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  // ── Applying remote blocks (from the network) ────────────────────────────────

  /**
   * Apply a block received from a peer: full validation (content hash, signature,
   * index/previousHash linkage, accumulator root) then optimistic confirmation.
   */
  addBlock(block: Block): { success: boolean; error?: string } {
    if (computeContentHash(block) !== block.hash) return { success: false, error: 'content hash mismatch' };
    if (!verifyBlockSignature(block)) return { success: false, error: 'invalid signature' };
    // Frozen: an equivocating account's chain is rejected outright.
    if (this.equivocated.has(block.accountId)) return { success: false, error: 'account equivocated' };

    let h = this.held.get(block.accountId);
    if (block.index === 0) {
      if (block.type !== 'open' || block.previousHash !== GENESIS_PREV) return { success: false, error: 'bad genesis' };
      if (h) {
        if (h.chain[0]?.hash === block.hash) return { success: true };
        this.flagEquivocation(h.chain[0], block);   // two different opens, same account
        return { success: false, error: 'conflicting open' };
      }
      h = { chain: [], acc: new AccountAccumulator() };
      this.held.set(block.accountId, h);
    } else {
      if (!h) return { success: false, error: 'missing prior chain' };
      const head = h.chain[h.chain.length - 1]!;
      if (block.index <= head.index) {
        const existing = h.chain[block.index];
        if (existing?.hash === block.hash) return { success: true };
        if (existing) this.flagEquivocation(existing, block);   // fork at the same height = double-spend
        return { success: false, error: 'stale/conflicting' };
      }
      if (block.index !== head.index + 1) return { success: false, error: 'non-sequential' };
      if (block.previousHash !== head.hash) return { success: false, error: 'previousHash mismatch' };
    }
    if (h.acc.rootWithHex(block.hash) !== block.accumulatorRoot) return { success: false, error: 'accumulator root mismatch' };
    h.acc.append(block.hash);
    h.chain.push(block);

    if (block.type === 'send' && block.recipient && block.amount !== undefined) {
      this.unclaimedSends.set(block.hash, { fromPub: block.accountId, toPub: block.recipient, amount: Number(block.amount) });
    } else if (block.type === 'receive' && block.sourceHash) {
      this.unclaimedSends.delete(block.sourceHash);
    }
    this.allBlocks.set(block.hash, block);
    this.appliedAt.set(block.hash, Date.now());  // foreign block enters the challenge window
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { success: true };
  }

  // ── Fraud-proof conflict safety (Phase 2) ────────────────────────────────────

  /** Locally-detected fork: build self-incriminating evidence and freeze the account. */
  private flagEquivocation(a: Block, b: Block): void {
    const ev = proveDoubleSpend(a, b);
    if (ev) this.freezeEquivocator(ev);  // null if not a genuine same-height fork
  }

  /**
   * Apply double-spend evidence received from the network. Verifies the evidence
   * (both blocks valid + genuinely conflicting) before freezing — never trust a
   * peer's claim. Idempotent; returns true if this newly froze the account.
   */
  applyEvidence(ev: DoubleSpendEvidence): boolean {
    return verifyDoubleSpend(ev) && this.freezeEquivocator(ev);
  }

  /** Apply evidence from two received blocks (node receive path); verifies before freezing. */
  applyEvidenceFromBlocks(a: Block, b: Block): boolean {
    const ev = proveDoubleSpend(a, b);
    return ev ? this.applyEvidence(ev) : false;
  }

  private freezeEquivocator(ev: DoubleSpendEvidence): boolean {
    if (this.equivocated.has(ev.accountId)) return false;  // already frozen
    this.equivocated.set(ev.accountId, ev);
    // Void the account's unclaimed sends so no recipient can still claim them.
    for (const [hash, s] of this.unclaimedSends) if (s.fromPub === ev.accountId) this.unclaimedSends.delete(hash);
    this.emit('account:equivocated', ev);
    return true;
  }

  isEquivocated(pub: string): boolean { return this.equivocated.has(pub); }
  getEquivocationEvidence(pub: string): DoubleSpendEvidence | undefined { return this.equivocated.get(pub); }
  allEquivocationEvidence(): DoubleSpendEvidence[] { return [...this.equivocated.values()]; }

  getUnclaimedForAccount(pub: string): { sendBlockHash: string; fromPub: string; amount: number }[] {
    const out: { sendBlockHash: string; fromPub: string; amount: number }[] = [];
    for (const [hash, s] of this.unclaimedSends) if (s.toPub === pub) out.push({ sendBlockHash: hash, fromPub: s.fromPub, amount: s.amount });
    return out;
  }

  // ── Stats / explorer ─────────────────────────────────────────────────────────

  getAllBlocks(): Block[] {
    const all: Block[] = [];
    for (const h of this.held.values()) all.push(...h.chain);
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  getStats(): {
    network: string; totalAccounts: number; totalBlocks: number; confirmedBlocks: number;
    pendingBlocks: number; tps: number; accounts: number; blocks: number;
  } {
    let blocks = 0;
    for (const h of this.held.values()) blocks += h.chain.length;
    // Accounts we have any state for: registered records ∪ held chains (a remote
    // account synced via its open block lives in `held` before its record arrives).
    const totalAccounts = new Set<string>([...this.accountsByPub.keys(), ...this.held.keys()]).size;
    // Optimistic confirmation: every applied block is confirmed; no fork voting in this slice.
    return {
      network: this.network,
      totalAccounts, totalBlocks: blocks, confirmedBlocks: blocks, pendingBlocks: 0, tps: 0,
      accounts: totalAccounts, blocks,
    };
  }

  // ── Drop-in surface for the app (DAGLedger compatibility) ─────────────────────
  // These let node.ts / main.ts treat EngineLedger like the old ledger. Features
  // not in this slice (contracts, storage-provider economy, fork voting) are
  // stubbed empty/no-op and reshaped in the dApp phase.

  /** All blocks by hash, maintained as blocks are added/applied. */
  readonly allBlocks = new Map<string, Block>();
  /** Accounts by pub (DAGLedger-compatible view; iterated by publishLocalData/UI). */
  get accounts(): Map<string, LedgerAccount> {
    return this.accountsByPub;
  }
  /** Deferred: storage-provider economy. */
  readonly storageProviders = new Map<string, unknown>();
  /** Deferred: smart contracts. */
  readonly contracts = new Map<string, unknown>();
  /** Deferred: fork voting (optimistic confirmation is used). */
  readonly votes = { registerBlock: () => 'confirmed' as const, getStatus: () => 'confirmed' as const };

  getAccountByPub(pub: string): LedgerAccount | undefined {
    return this.accountsByPub.get(pub);
  }
  getBlock(hash: string): Block | undefined {
    return this.allBlocks.get(hash);
  }
  getBlockStatus(hash: string): 'confirmed' | 'rejected' | 'pending' | 'unknown' {
    const b = this.allBlocks.get(hash);
    if (!b) return 'unknown';
    if (this.equivocated.has(b.accountId)) return 'rejected';  // frozen by fraud proof
    const at = this.appliedAt.get(hash);
    if (at !== undefined) {
      if (Date.now() - at < CHALLENGE_WINDOW_MS) return 'pending';  // recipient-witnessed window
      this.appliedAt.delete(hash);  // settled — free the entry (keeps the map bounded to in-window blocks)
    }
    return 'confirmed';
  }
  getStorageProviders(): unknown[] {
    return [];
  }
  getMaxAccountsPerFace(): number {
    return this.network === 'mainnet' ? 1 : 3;
  }
  getFaceAccountCount(): number {
    return 0; // dedup is by nullifier now, not faceMapHash
  }
  estimateBlockchainSizeBytes(): number {
    return this.allBlocks.size * 600;
  }
  countHeartbeatsLast24h(): number {
    return 0;
  }
  getBlocksSince(): Block[] {
    return [];
  }
  checkPublishFeasibility(): { feasible: boolean; reason?: string } {
    return { feasible: true };
  }
  castVote(): void {
    /* optimistic confirmation — no fork voting in this slice */
  }
  processConflicts(): void {}
  refreshHeartbeatCounts(): void {}
  updateProviderScore(): void {}
  purgeAccount(pub: string): void {
    this.held.delete(pub);
    const acc = this.accountsByPub.get(pub);
    if (acc) this.usernameToPub.delete(acc.username);
    this.accountsByPub.delete(pub);
  }
  reset(): void {
    this.held.clear();
    this.accountsByPub.clear();
    this.usernameToPub.clear();
    this.unclaimedSends.clear();
    this.allBlocks.clear();
  }
  private deferred(feature: string): { error: string } {
    return { error: `${feature} is not available in the engine slice (dApp phase)` };
  }
  createDeploy(): { error: string } {
    return this.deferred('Contracts');
  }
  createCall(): { error: string } {
    return this.deferred('Contracts');
  }
  createUpdate(): { error: string } {
    return this.deferred('Account update');
  }
  createStorageRegister(): { error: string } {
    return this.deferred('Storage providers');
  }
  createStorageDeregister(): { error: string } {
    return this.deferred('Storage providers');
  }
  createStorageHeartbeat(): { error: string } {
    return this.deferred('Storage providers');
  }
  createStorageReward(): { error: string } {
    return this.deferred('Storage providers');
  }
}
