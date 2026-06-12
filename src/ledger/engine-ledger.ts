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

export class EngineLedger extends EventEmitter {
  private readonly held = new Map<string, Held>();
  private readonly accountsByPub = new Map<string, LedgerAccount>();
  private readonly usernameToPub = new Map<string, string>();
  private readonly identity = new InMemoryIdentityRegistry();
  /** sendBlockHash → unclaimed send, mirroring DAGLedger.unclaimedSends. */
  readonly unclaimedSends = new Map<string, { fromPub: string; toPub: string; amount: number }>();

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

    let h = this.held.get(block.accountId);
    if (block.index === 0) {
      if (block.type !== 'open' || block.previousHash !== GENESIS_PREV) return { success: false, error: 'bad genesis' };
      if (h) return h.chain[0]?.hash === block.hash ? { success: true } : { success: false, error: 'conflicting open' };
      h = { chain: [], acc: new AccountAccumulator() };
      this.held.set(block.accountId, h);
    } else {
      if (!h) return { success: false, error: 'missing prior chain' };
      const head = h.chain[h.chain.length - 1]!;
      if (block.index <= head.index) return h.chain[block.index]?.hash === block.hash ? { success: true } : { success: false, error: 'stale/conflicting' };
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
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { success: true };
  }

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

  getStats(): { accounts: number; blocks: number; network: string } {
    let blocks = 0;
    for (const h of this.held.values()) blocks += h.chain.length;
    return { accounts: this.accountsByPub.size, blocks, network: this.network };
  }
}
