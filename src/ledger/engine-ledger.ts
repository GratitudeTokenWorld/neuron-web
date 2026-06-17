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
import { ValidatorRegistry } from '../engine/consensus/validators.js';
import { EpochSeeds } from '../engine/consensus/seed.js';
import { CommitteeFinality, type CommitteeVote, type WeightSource } from '../engine/consensus/finality.js';
import { hashHex, utf8ToBytes, type Hex } from '../engine/core/hash.js';

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

/**
 * Target per-shard committee size for VRF self-sortition (Phase 2 step 2). A block
 * is `final` once votes covering ⌈2/3 × this⌉ committee seats back it. Tunable;
 * larger = stronger finality, more votes per shard (still O(committee), not
 * O(network)).
 */
export const DEFAULT_COMMITTEE_SIZE = 64;

/** How many past epochs of validator-weight snapshots to retain (bounds late-vote verification). */
export const EPOCH_WEIGHT_RETAIN = 4;

/**
 * Independent personhood attesters required to OPEN an account (attester-#2 /
 * k-of-N Sybil resistance — removes the single-attester SPOF that consensus
 * security reduces to). Only gates NEW account creation; existing accounts replay
 * via addBlock (which doesn't re-check the quorum), so there's no migration break.
 * Availability cost: that many attester relays must be reachable to create an
 * account. Tunable — dial to 1 if a cross-relay attestation path is unavailable.
 */
export const REQUIRED_ATTESTERS = 2;

export class EngineLedger extends EventEmitter {
  private readonly held = new Map<string, Held>();
  private readonly accountsByPub = new Map<string, LedgerAccount>();
  private readonly usernameToPub = new Map<string, string>();
  private readonly identity = new InMemoryIdentityRegistry();
  /** sendBlockHash → unclaimed send, mirroring DAGLedger.unclaimedSends. */
  readonly unclaimedSends = new Map<string, { fromPub: string; toPub: string; amount: number }>();
  /**
   * Native NFTs (Bucket B). An NFT is a small ownership key, transferred on the
   * block-lattice exactly like a payment. `nftOwner` is the ownership index
   * (tokenId → current owner pub); `nftInfo` holds immutable token data (minter +
   * content CID + metadata); `unclaimedNftTransfers` mirrors `unclaimedSends` for
   * in-flight transfers; `burnedNfts` are permanently destroyed.
   */
  private readonly nftOwner = new Map<string, string>();
  private readonly nftInfo = new Map<string, { minter: string; contentRef: string; meta: Record<string, string> }>();
  private readonly unclaimedNftTransfers = new Map<string, { tokenId: string; fromPub: string; toPub: string }>();
  private readonly burnedNfts = new Set<string>();
  /**
   * Phase 2 (fraud-proof safety): accounts proven to have equivocated
   * (double-spent). Their chains are frozen — every block is `rejected` and the
   * balance is void. Evidence is self-verifying (see fraud.ts), so it freezes the
   * account on every node that sees it, with no committee/vote.
   */
  private readonly equivocated = new Map<string, DoubleSpendEvidence>();
  /** hash → local apply time, for foreign blocks within the challenge window. Pruned once settled. */
  private readonly appliedAt = new Map<string, number>();
  /**
   * Phase 2 step 2 (committee voting): validator set + epoch randomness. Bonding
   * the free mint (opt-in, locked while bonded) makes an account a shard validator;
   * its age-weighted weight feeds VRF self-sortition. The epoch seed accumulates
   * from committee VRF betas — no beacon. Both are recreated on `reset()`.
   */
  // Cap bonding at the ledger's actual mint (milli-UNIT scale). The engine's
  // votingWeight still saturates its √-stake term at the engine-native STAKE_CAP,
  // so every full-mint validator lands in the flat region with equal stake weight
  // and AGE is the differentiator — exactly the intended "one human, one
  // age-weighted vote" shape.
  private validatorRegistry = new ValidatorRegistry(MINT);
  private seeds = new EpochSeeds();
  private epoch = 0;
  /** Committee finality (V5): fast `final` status above optimistic `confirmed`. */
  private committee = this.makeCommittee();
  /**
   * Per-epoch validator-weight snapshots (id→weight + total), captured at each
   * epoch boundary so a vote verifies against the weights its sortition used —
   * deterministic across nodes, and correct for late cross-epoch votes. Epoch 0
   * (genesis/bootstrap, validators still bonding) falls back to live weights;
   * snapshots older than the retention window are pruned.
   */
  private epochWeightSnapshots = new Map<number, { total: number; byId: Map<string, number> }>();

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
  async openAccount(pub: string, keys: SignerKeys, identity: OpenIdentity, opts?: { bond?: boolean }): Promise<Block> {
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
    // Opt-in: bond the free mint to become a shard validator (capped at the mint,
    // locked while bonded — secures the network instead of being spendable).
    if (opts?.bond) this.bondStake(pub, MINT);
    return block;
  }

  async createSend(senderPub: string, recipientIdentifier: string, amount: number, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const recipientPub = this.resolveToPublicKey(recipientIdentifier);
    if (!recipientPub) return { error: 'Recipient not found' };
    const head = this.getAccountHead(senderPub);
    if (!head) return { error: 'Account not opened' };
    if (amount <= 0) return { error: 'Amount must be positive' };
    const amt = BigInt(Math.round(amount));
    // Bonded stake is locked: only the free (un-bonded) balance is spendable.
    const available = head.balance - this.validatorRegistry.bondedOf(senderPub);
    if (available < amt) return { error: 'Insufficient balance' };

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
        recipientName: this.accountsByPub.get(recipientPub)?.username,
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
        senderPub: unclaimed.fromPub,
        senderName: this.accountsByPub.get(unclaimed.fromPub)?.username,
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

  /**
   * Append a signed account-update block: a metadata patch (username, profile,
   * linkedAnchor, pqPub, …) committed on the account's own chain. Balance is
   * unchanged, so the update is verifiable + ordered like any other block — this is
   * the on-chain replacement for the off-chain `account:synced` record write.
   */
  async createUpdate(pub: string, updates: Record<string, string>, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    if (this.equivocated.has(pub)) return { error: 'Account frozen' };
    if (!updates || Object.keys(updates).length === 0) return { error: 'No updates provided' };

    const h = this.held.get(pub)!;
    const block = createBlock(
      {
        accountId: pub,
        index: head.index + 1,
        type: 'update',
        previousHash: head.hash,
        shard: head.shard,
        timestamp: Date.now(),
        balance: head.balance, // updates never move balance
        updates,
      },
      keys.priv,
      h.acc,
    );
    h.chain.push(block);
    this.allBlocks.set(block.hash, block);
    this.applyAccountUpdate(pub, updates);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  /** Apply a metadata patch to the local account record (username re-indexed). */
  private applyAccountUpdate(pub: string, updates: Record<string, string>): void {
    const acc = this.accountsByPub.get(pub);
    if (acc && typeof updates.username === 'string' && updates.username && updates.username !== acc.username) {
      this.usernameToPub.delete(acc.username);
      acc.username = updates.username;
      this.usernameToPub.set(updates.username, pub);
    }
    this.emit('account:updated', { pub, updates });
  }

  // ── Native NFTs (Bucket B) ───────────────────────────────────────────────────

  /** Deterministic, collision-free token id: unique per (minter, chain index, content). */
  private nftTokenId(minter: string, index: number, contentRef: string): Hex {
    return hashHex(utf8ToBytes(`nft:${minter}:${index}:${contentRef}`));
  }

  /** Mint a new NFT bound to `contentRef` (a content CID) + metadata; owner = minter. */
  async createMintNft(pub: string, contentRef: string, meta: Record<string, string>, keys: SignerKeys): Promise<{ block?: Block; tokenId?: string; error?: string }> {
    const head = this.getAccountHead(pub);
    if (!head) return { error: 'Account not opened' };
    if (this.equivocated.has(pub)) return { error: 'Account frozen' };
    if (!contentRef) return { error: 'contentRef required' };
    const h = this.held.get(pub)!;
    const index = head.index + 1;
    const tokenId = this.nftTokenId(pub, index, contentRef);
    const block = createBlock(
      { accountId: pub, index, type: 'nft-mint', previousHash: head.hash, shard: head.shard,
        timestamp: Date.now(), balance: head.balance, tokenId, contentRef, nftMeta: meta },
      keys.priv, h.acc,
    );
    h.chain.push(block);
    this.allBlocks.set(block.hash, block);
    this.applyNftMint(block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block, tokenId };
  }

  /** Transfer an owned NFT to a recipient — claimable by them via {@link createReceiveNft}. */
  async createTransferNft(pub: string, tokenId: string, recipientIdentifier: string, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const recipientPub = this.resolveToPublicKey(recipientIdentifier);
    if (!recipientPub) return { error: 'Recipient not found' };
    if (this.equivocated.has(pub)) return { error: 'Account frozen' };
    if (this.nftOwner.get(tokenId) !== pub) return { error: 'You do not own this NFT' };
    const head = this.getAccountHead(pub)!;
    const h = this.held.get(pub)!;
    const block = createBlock(
      { accountId: pub, index: head.index + 1, type: 'nft-send', previousHash: head.hash, shard: head.shard,
        timestamp: Date.now(), balance: head.balance, tokenId, recipient: recipientPub,
        recipientName: this.accountsByPub.get(recipientPub)?.username },
      keys.priv, h.acc,
    );
    h.chain.push(block);
    this.allBlocks.set(block.hash, block);
    this.applyNftSend(block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  /** Claim an incoming NFT transfer — the recipient becomes the owner. */
  async createReceiveNft(recipientPub: string, nftSendHash: string, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    const unclaimed = this.unclaimedNftTransfers.get(nftSendHash);
    if (!unclaimed) return { error: 'NFT transfer not found or already claimed' };
    if (unclaimed.toPub !== recipientPub) return { error: 'This NFT is not addressed to you' };
    const head = this.getAccountHead(recipientPub);
    if (!head) return { error: 'Account not opened' };
    const h = this.held.get(recipientPub)!;
    const block = createBlock(
      { accountId: recipientPub, index: head.index + 1, type: 'nft-receive', previousHash: head.hash, shard: head.shard,
        timestamp: Date.now(), balance: head.balance, tokenId: unclaimed.tokenId, sourceHash: nftSendHash,
        senderPub: unclaimed.fromPub, senderName: this.accountsByPub.get(unclaimed.fromPub)?.username },
      keys.priv, h.acc,
    );
    h.chain.push(block);
    this.allBlocks.set(block.hash, block);
    this.applyNftReceive(block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  /** Permanently destroy an owned NFT. */
  async createBurnNft(pub: string, tokenId: string, keys: SignerKeys): Promise<{ block?: Block; error?: string }> {
    if (this.equivocated.has(pub)) return { error: 'Account frozen' };
    if (this.nftOwner.get(tokenId) !== pub) return { error: 'You do not own this NFT' };
    const head = this.getAccountHead(pub)!;
    const h = this.held.get(pub)!;
    const block = createBlock(
      { accountId: pub, index: head.index + 1, type: 'nft-burn', previousHash: head.hash, shard: head.shard,
        timestamp: Date.now(), balance: head.balance, tokenId },
      keys.priv, h.acc,
    );
    h.chain.push(block);
    this.allBlocks.set(block.hash, block);
    this.applyNftBurn(block);
    this.emit('block:added', block);
    this.emit('block:confirmed', block);
    return { block };
  }

  // Apply helpers — shared by local create + foreign addBlock so both paths agree.
  private applyNftMint(b: Block): void {
    if (!b.tokenId || !b.contentRef) return;
    this.nftOwner.set(b.tokenId, b.accountId);
    this.nftInfo.set(b.tokenId, { minter: b.accountId, contentRef: b.contentRef, meta: b.nftMeta ?? {} });
    this.emit('nft:minted', { tokenId: b.tokenId, owner: b.accountId });
  }
  private applyNftSend(b: Block): void {
    if (!b.tokenId || !b.recipient) return;
    this.nftOwner.delete(b.tokenId); // in flight until the recipient claims it
    this.unclaimedNftTransfers.set(b.hash, { tokenId: b.tokenId, fromPub: b.accountId, toPub: b.recipient });
  }
  private applyNftReceive(b: Block): void {
    if (!b.tokenId) return;
    if (b.sourceHash) this.unclaimedNftTransfers.delete(b.sourceHash);
    this.nftOwner.set(b.tokenId, b.accountId);
    this.emit('nft:transferred', { tokenId: b.tokenId, owner: b.accountId });
  }
  private applyNftBurn(b: Block): void {
    if (!b.tokenId) return;
    this.burnedNfts.add(b.tokenId);
    this.nftOwner.delete(b.tokenId);
    this.emit('nft:burned', { tokenId: b.tokenId });
  }

  getNftOwner(tokenId: string): string | undefined { return this.nftOwner.get(tokenId); }
  getNftInfo(tokenId: string): { minter: string; contentRef: string; meta: Record<string, string> } | undefined { return this.nftInfo.get(tokenId); }
  isNftBurned(tokenId: string): boolean { return this.burnedNfts.has(tokenId); }
  /** All NFTs currently owned by `pub` (with their content + metadata). */
  getNftsOwnedBy(pub: string): { tokenId: string; contentRef: string; meta: Record<string, string>; minter: string }[] {
    const out: { tokenId: string; contentRef: string; meta: Record<string, string>; minter: string }[] = [];
    for (const [tokenId, owner] of this.nftOwner) {
      if (owner !== pub) continue;
      const info = this.nftInfo.get(tokenId);
      if (info) out.push({ tokenId, contentRef: info.contentRef, meta: info.meta, minter: info.minter });
    }
    return out;
  }
  /** Incoming NFT transfers addressed to `pub` that haven't been claimed yet. */
  getUnclaimedNftsForAccount(pub: string): { nftSendHash: string; tokenId: string; fromPub: string }[] {
    const out: { nftSendHash: string; tokenId: string; fromPub: string }[] = [];
    for (const [hash, t] of this.unclaimedNftTransfers) if (t.toPub === pub) out.push({ nftSendHash: hash, tokenId: t.tokenId, fromPub: t.fromPub });
    return out;
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
      // Balance conservation: an open mints EXACTLY the genesis amount, no more.
      if (block.balance !== MINT) return { success: false, error: 'open must mint exactly the genesis amount' };
      if (h) {
        if (h.chain[0]?.hash === block.hash) return { success: true };
        this.flagEquivocation(h.chain[0], block);   // two different opens, same account
        this.allBlocks.set(block.hash, block);       // retain the sibling so committees can tally the fork
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
        if (existing) {
          this.flagEquivocation(existing, block);   // fork at the same height = double-spend
          this.allBlocks.set(block.hash, block);     // retain the sibling so committees can tally the fork
        }
        return { success: false, error: 'stale/conflicting' };
      }
      if (block.index !== head.index + 1) return { success: false, error: 'non-sequential' };
      if (block.previousHash !== head.hash) return { success: false, error: 'previousHash mismatch' };
      // Balance conservation — without this, a self-signed block could mint money
      // (the signature/hash/linkage all pass; only the arithmetic catches it). The
      // fraud-proof + committee layers do NOT cover this (it's a single valid chain).
      if (block.type === 'update' && block.balance !== head.balance) {
        return { success: false, error: 'update must preserve balance' };
      }
      if (block.type === 'send') {
        if (block.amount === undefined || block.amount <= 0n) return { success: false, error: 'send amount must be positive' };
        if (block.balance < 0n || block.balance !== head.balance - block.amount) return { success: false, error: 'send balance inconsistent' };
      }
      if (block.type === 'receive') {
        if (block.amount === undefined || block.amount <= 0n) return { success: false, error: 'receive amount must be positive' };
        if (block.balance !== head.balance + block.amount) return { success: false, error: 'receive balance inconsistent' };
        // When we hold the source send, the claimed amount must match it (catches an
        // over-claimed receive). If we don't hold it yet, the self-consistent delta
        // above still bounds the damage; full cross-account proof is the source send.
        const src = block.sourceHash ? this.allBlocks.get(block.sourceHash) : undefined;
        if (src && (src.type !== 'send' || src.recipient !== block.accountId || src.amount !== block.amount)) {
          return { success: false, error: 'receive does not match source send' };
        }
      }
      // NFT blocks never move balance, and each has its own ownership invariant.
      if (block.type === 'nft-mint') {
        if (block.balance !== head.balance) return { success: false, error: 'nft-mint must preserve balance' };
        if (!block.tokenId || !block.contentRef) return { success: false, error: 'nft-mint missing token/content' };
        if (this.nftOwner.has(block.tokenId) || this.nftInfo.has(block.tokenId) || this.burnedNfts.has(block.tokenId)) {
          return { success: false, error: 'nft tokenId already exists' };
        }
      }
      if (block.type === 'nft-send') {
        if (block.balance !== head.balance) return { success: false, error: 'nft-send must preserve balance' };
        if (!block.tokenId || !block.recipient) return { success: false, error: 'nft-send missing token/recipient' };
        if (this.nftOwner.get(block.tokenId) !== block.accountId) return { success: false, error: 'nft-send: not the owner' };
      }
      if (block.type === 'nft-receive') {
        if (block.balance !== head.balance) return { success: false, error: 'nft-receive must preserve balance' };
        if (!block.tokenId || !block.sourceHash) return { success: false, error: 'nft-receive missing token/source' };
        // Validate against the source nft-send when we hold it (catches a forged
        // claim). If absent (cross-account ordering), apply optimistically — the
        // recipient's own node always holds the source; other nodes converge as it
        // propagates, and a holder of the source rejects any forgery.
        const src = this.allBlocks.get(block.sourceHash);
        if (src && (src.type !== 'nft-send' || src.recipient !== block.accountId || src.tokenId !== block.tokenId)) {
          return { success: false, error: 'nft-receive does not match source' };
        }
      }
      if (block.type === 'nft-burn') {
        if (block.balance !== head.balance) return { success: false, error: 'nft-burn must preserve balance' };
        if (!block.tokenId) return { success: false, error: 'nft-burn missing token' };
        if (this.nftOwner.get(block.tokenId) !== block.accountId) return { success: false, error: 'nft-burn: not the owner' };
      }
    }
    if (h.acc.rootWithHex(block.hash) !== block.accumulatorRoot) return { success: false, error: 'accumulator root mismatch' };
    h.acc.append(block.hash);
    h.chain.push(block);

    if (block.type === 'send' && block.recipient && block.amount !== undefined) {
      this.unclaimedSends.set(block.hash, { fromPub: block.accountId, toPub: block.recipient, amount: Number(block.amount) });
    } else if (block.type === 'receive' && block.sourceHash) {
      this.unclaimedSends.delete(block.sourceHash);
    } else if (block.type === 'update' && block.updates) {
      this.applyAccountUpdate(block.accountId, block.updates);
    } else if (block.type === 'nft-mint') {
      this.applyNftMint(block);
    } else if (block.type === 'nft-send') {
      this.applyNftSend(block);
    } else if (block.type === 'nft-receive') {
      this.applyNftReceive(block);
    } else if (block.type === 'nft-burn') {
      this.applyNftBurn(block);
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
    // Void the account's unclaimed sends + NFT transfers so nothing can still be claimed.
    for (const [hash, s] of this.unclaimedSends) if (s.fromPub === ev.accountId) this.unclaimedSends.delete(hash);
    for (const [hash, t] of this.unclaimedNftTransfers) if (t.fromPub === ev.accountId) this.unclaimedNftTransfers.delete(hash);
    // Slashing: a double-spending validator forfeits its bond (skin in the game).
    const burned = this.validatorRegistry.slash(ev.accountId);
    if (burned > 0n) this.emit('validator:slashed', { id: ev.accountId, burned, reason: 'double-spend' });
    this.emit('account:equivocated', ev);
    return true;
  }

  isEquivocated(pub: string): boolean { return this.equivocated.has(pub); }
  getEquivocationEvidence(pub: string): DoubleSpendEvidence | undefined { return this.equivocated.get(pub); }
  allEquivocationEvidence(): DoubleSpendEvidence[] { return [...this.equivocated.values()]; }

  // ── Validator state + epochs (Phase 2 step 2: committee voting) ───────────────

  /**
   * Bond stake to become / strengthen a shard validator. Bonded amount is locked
   * (not spendable via {@link createSend}) and capped at the free mint. Default
   * amount bonds all currently-free balance up to the cap.
   */
  bondStake(pub: string, amount?: bigint): { ok: boolean; reason?: string } {
    const head = this.getAccountHead(pub);
    if (!head) return { ok: false, reason: 'account not opened' };
    if (this.equivocated.has(pub)) return { ok: false, reason: 'account frozen' };
    const free = head.balance - this.validatorRegistry.bondedOf(pub);
    const amt = amount ?? free;
    if (amt <= 0n) return { ok: false, reason: 'nothing to bond' };
    if (amt > free) return { ok: false, reason: 'amount exceeds free balance' };
    const r = this.validatorRegistry.bond(pub, amt);
    if (r.ok) this.emit('validator:bonded', { id: pub, amount: amt, bonded: this.validatorRegistry.bondedOf(pub) });
    return r;
  }

  isValidator(pub: string): boolean { return this.validatorRegistry.isValidator(pub); }
  isSlashed(pub: string): boolean { return this.validatorRegistry.isSlashed(pub); }
  bondedOf(pub: string): bigint { return this.validatorRegistry.bondedOf(pub); }
  /** This account's current age-weighted voting weight (0 if not a validator). */
  validatorWeight(pub: string): number { return this.validatorRegistry.weightOf(pub); }
  /** Summed validator weight — the sortition denominator (`totalWeight`). */
  totalValidatorWeight(): number { return this.validatorRegistry.totalWeight(); }
  /** All currently-eligible validators (for committee sortition over the global pool). */
  validatorSet(): Hex[] { return this.validatorRegistry.validators(); }

  get currentEpoch(): number { return this.epoch; }
  /** The seed driving sortition for the current epoch. */
  currentSeed(): Hex { return this.seeds.seedFor(this.epoch)!; }
  seedFor(epoch: number): Hex | undefined { return this.seeds.seedFor(epoch); }
  get committeeSize(): number { return DEFAULT_COMMITTEE_SIZE; }

  private makeCommittee(): CommitteeFinality {
    // Weight + seed are read live (closures) so the committee tracks the current
    // validator set even after reset() swaps the registry. Past epochs resolve
    // against the frozen snapshot; the current/genesis epoch falls back to live.
    const weights: WeightSource = {
      weightOf: (id, epoch) => {
        const snap = this.epochWeightSnapshots.get(epoch);
        return snap ? (snap.byId.get(id) ?? 0) : this.validatorRegistry.weightOf(id);
      },
      totalWeight: (epoch) => {
        const snap = this.epochWeightSnapshots.get(epoch);
        return snap ? snap.total : this.validatorRegistry.totalWeight();
      },
    };
    return new CommitteeFinality(
      { committeeSize: DEFAULT_COMMITTEE_SIZE },
      weights,
      (epoch) => this.seeds.seedFor(epoch),
    );
  }

  private snapshotWeights(): { total: number; byId: Map<string, number> } {
    const byId = new Map<string, number>();
    let total = 0;
    for (const id of this.validatorRegistry.validators()) {
      const w = this.validatorRegistry.weightOf(id);
      byId.set(id, w);
      total += w;
    }
    return { total, byId };
  }

  /**
   * Apply a committee member's vote toward finalizing a block (V5). Verifies the
   * VRF sortition proof + signature, tallies seats, and on an absolute 2/3-seat
   * quorum marks the block `final` (rejecting fork siblings). A voter that
   * equivocates (votes two siblings) is slashed via the fraud path. Idempotent;
   * returns whether the vote was counted and any finalization.
   */
  applyCommitteeVote(vote: CommitteeVote): { accepted: boolean; finalized?: string; reason?: string } {
    // Self-register the voted block on demand (bounded by committee activity, not
    // total blocks) so finality memory stays O(blocks under active voting).
    const block = this.allBlocks.get(vote.blockHash);
    if (block) this.committee.registerBlock(block);

    const r = this.committee.applyVote(vote);
    if (r.equivocation) {
      // A committee member double-voting is slashable evidence (no bond ⇒ no-op).
      const burned = this.validatorRegistry.slash(r.equivocation.voterId);
      if (burned > 0n) this.emit('validator:slashed', { id: r.equivocation.voterId, burned, reason: 'vote-equivocation' });
    }
    if (r.finalized) {
      this.emit('block:final', { hash: r.finalized });
      for (const h of r.rejected ?? []) this.emit('block:rejected', { hash: h });
    }
    return { accepted: r.accepted, finalized: r.finalized, reason: r.reason };
  }

  /** Is this block committee-finalized (the strongest status)? */
  isFinal(hash: string): boolean { return this.committee.isFinal(hash); }

  /**
   * Close the current epoch: fold this epoch's committee VRF `betas` into the seed
   * chain (→ next epoch's seed) and credit one activity-epoch to each validator that
   * participated. `activeValidators` defaults to the whole set; the vote layer (V5)
   * passes only the validators that actually voted so age stays participation-based.
   */
  advanceEpoch(betas: readonly Hex[] = [], activeValidators: Iterable<string> = this.validatorRegistry.validators()): number {
    this.seeds.commit(this.epoch, betas);
    this.epoch += 1;
    for (const id of activeValidators) this.validatorRegistry.creditActivity(id, 1);
    // Freeze the new epoch's weights so its committee is fixed (votes verify against
    // these, not later drift); prune snapshots beyond the retention window.
    this.epochWeightSnapshots.set(this.epoch, this.snapshotWeights());
    for (const e of this.epochWeightSnapshots.keys()) {
      if (e < this.epoch - EPOCH_WEIGHT_RETAIN) this.epochWeightSnapshots.delete(e);
    }
    this.committee.pruneStale(this.epoch); // bound finality memory: drop stalled fork tallies
    this.emit('epoch:advanced', { epoch: this.epoch, seed: this.seeds.seedFor(this.epoch)! });
    return this.epoch;
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
  getBlockStatus(hash: string): 'final' | 'confirmed' | 'rejected' | 'pending' | 'unknown' {
    const b = this.allBlocks.get(hash);
    if (!b) return 'unknown';
    if (this.equivocated.has(b.accountId)) return 'rejected';  // frozen by fraud proof
    if (this.committee.isFinal(hash)) return 'final';          // committee-finalized (V5)
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
    this.nftOwner.clear();
    this.nftInfo.clear();
    this.unclaimedNftTransfers.clear();
    this.burnedNfts.clear();
    this.allBlocks.clear();
    this.equivocated.clear();
    this.appliedAt.clear();
    this.validatorRegistry = new ValidatorRegistry(MINT);
    this.seeds = new EpochSeeds();
    this.epoch = 0;
    this.epochWeightSnapshots.clear();
    this.committee = this.makeCommittee();
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
