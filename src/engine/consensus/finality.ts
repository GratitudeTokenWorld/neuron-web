import { type Hex } from '../core/hash.js';
import { sign as engineSign, verify as engineVerify } from '../core/keys.js';
import { proveSortition, verifySortition } from './sortition.js';

/**
 * Committee finality — fast, Byzantine-safe finalization on top of optimistic
 * confirmation, using V1–V4 (VRF self-sortition + age-weighted validator state).
 *
 * Each epoch, validators self-sort into per-shard committees ({@link ./sortition}).
 * A committee member signs a vote for the block it sees at a given chain position;
 * the vote carries its VRF sortition proof, so anyone can verify the member's seat
 * count without a coordinator. A block becomes **final** once votes covering
 * `threshold × committeeSize` seats back it — an ABSOLUTE quorum of the expected
 * committee, NOT a fraction of whoever happened to show up. That closes the
 * "one voter wins on timeout" weakness in the threat model: suppressing honest
 * votes can stall finality (the fraud-proof challenge window + recipient witnessing
 * remain the backstop) but cannot manufacture it.
 *
 * On a fork (two blocks at the same accountId:previousHash) the committee's votes
 * are tallied per block; the first to reach quorum wins and its siblings are
 * rejected. A member that votes for two siblings in one conflict equivocates —
 * surfaced here as slashable evidence (the bond is burned via the ledger). The
 * fraud-proof double-spend layer slashes the block author independently, so a
 * captured committee still cannot make a double-spend pay.
 *
 * Performance: votes ride per-shard topics (O(committee), never O(network)); a
 * verify is a handful of P-256 ops; the optimistic path is untouched — finality is
 * an ADDITIVE upgrade, not a new per-block cost.
 */

export interface CommitteeVote {
  /** The block this committee member is voting to finalize. */
  blockHash: Hex;
  /** Voter = committee member's account id (compressed P-256 pub, hex). */
  accountId: Hex;
  shard: number;
  epoch: number;
  /** Seats won (must equal the count the VRF proof verifies to). */
  seats: number;
  /** VRF sortition proof for (seed ‖ epoch ‖ shard). */
  pi: Hex;
  /** Member's signature over (epoch, shard, blockHash) — binds the block choice. */
  sig: Hex;
}

export interface CommitteeParams {
  committeeSize: number;
  /** Fraction of committee seats required to finalize (default 2/3). */
  threshold?: number;
}

/** Current age-weighted validator weights (the sortition denominator source). */
export interface WeightSource {
  weightOf(id: Hex): number;
  totalWeight(): number;
}

export interface VoteResult {
  accepted: boolean;
  reason?: string;
  /** blockHash that just reached quorum (became final) as a result of this vote. */
  finalized?: Hex;
  /** sibling blockHashes rejected because a competitor finalized. */
  rejected?: Hex[];
  /** present iff this voter equivocated (voted two siblings) — slashable. */
  equivocation?: { voterId: Hex; blockA: Hex; blockB: Hex };
}

export type FinalityStatus = 'final' | 'rejected' | 'pending' | 'unknown';

function voteMessage(epoch: number, shard: number, blockHash: Hex): string {
  return `engine-vote:${epoch}:${shard}:${blockHash}`;
}

/** Absolute seat quorum required to finalize. */
export function seatQuorum(params: CommitteeParams): number {
  return Math.max(1, Math.ceil((params.threshold ?? 2 / 3) * params.committeeSize));
}

/**
 * Cast this validator's committee vote for `block`, if it won any seats this epoch.
 * Returns null when not selected (seats === 0) — a non-member simply doesn't vote.
 * Pure: combines VRF self-sortition with a signature binding the block choice.
 */
export function castCommitteeVote(
  privHex: Hex,
  pub: Hex,
  block: { hash: Hex; shard: number },
  seed: string,
  epoch: number,
  weight: number,
  totalWeight: number,
  committeeSize: number,
): CommitteeVote | null {
  const { seats, pi } = proveSortition(privHex, seed, epoch, block.shard, weight, totalWeight, committeeSize);
  if (seats <= 0) return null;
  const sig = engineSign(voteMessage(epoch, block.shard, block.hash), privHex);
  return { blockHash: block.hash, accountId: pub, shard: block.shard, epoch, seats, pi, sig };
}

interface Group {
  blocks: Set<Hex>; // competing blockHashes at this accountId:previousHash
  seatsByBlock: Map<Hex, number>; // blockHash → total seats backing it
  voterChoice: Map<Hex, Hex>; // voterId → chosen blockHash (equivocation guard)
  final?: Hex;
}

export class CommitteeFinality {
  private readonly groupOf = new Map<Hex, string>(); // blockHash → group key
  private readonly groups = new Map<string, Group>();
  private readonly groupEpoch = new Map<string, number>(); // group key → latest vote epoch (for stale pruning)
  private readonly finalBlocks = new Set<Hex>();
  private readonly rejectedBlocks = new Set<Hex>();
  private readonly equivocs: { voterId: Hex; blockA: Hex; blockB: Hex }[] = [];

  constructor(
    private readonly params: CommitteeParams,
    private readonly weights: WeightSource,
    /** Returns the epoch seed (so historical-epoch votes verify against the right seed). */
    private readonly seedFor: (epoch: number) => string | undefined,
  ) {}

  /** Register a block so its votes have a conflict group. Idempotent. */
  registerBlock(block: { hash: Hex; accountId: Hex; previousHash: Hex }): void {
    if (this.groupOf.has(block.hash)) return;
    const key = `${block.accountId}:${block.previousHash}`;
    this.groupOf.set(block.hash, key);
    let g = this.groups.get(key);
    if (!g) {
      g = { blocks: new Set(), seatsByBlock: new Map(), voterChoice: new Map() };
      this.groups.set(key, g);
    }
    g.blocks.add(block.hash);
  }

  /** Verify + tally a committee vote. Never throws. */
  applyVote(v: CommitteeVote): VoteResult {
    const key = this.groupOf.get(v.blockHash);
    if (!key) return { accepted: false, reason: 'unknown block' };
    const g = this.groups.get(key)!;
    if (g.final) return { accepted: false, reason: 'group already final' };

    // 1. Authenticate the block choice.
    if (!engineVerify(v.sig, voteMessage(v.epoch, v.shard, v.blockHash), v.accountId)) {
      return { accepted: false, reason: 'bad signature' };
    }
    // 2. Verify VRF self-sortition (seat count is self-proving).
    const seed = this.seedFor(v.epoch);
    if (seed === undefined) return { accepted: false, reason: 'unknown epoch seed' };
    const weight = this.weights.weightOf(v.accountId);
    const total = this.weights.totalWeight();
    const seats = verifySortition(v.accountId, seed, v.epoch, v.shard, weight, total, this.params.committeeSize, v.pi);
    if (seats === null) return { accepted: false, reason: 'invalid sortition proof' };
    if (seats <= 0 || seats !== v.seats) return { accepted: false, reason: 'seat count mismatch' };

    // 3. Equivocation guard: a member backing two siblings in one conflict is slashable.
    const prior = g.voterChoice.get(v.accountId);
    if (prior !== undefined) {
      if (prior === v.blockHash) return { accepted: false, reason: 'duplicate vote' };
      const equivocation = { voterId: v.accountId, blockA: prior, blockB: v.blockHash };
      this.equivocs.push(equivocation);
      return { accepted: false, reason: 'equivocation', equivocation };
    }

    // 4. Tally.
    g.voterChoice.set(v.accountId, v.blockHash);
    g.seatsByBlock.set(v.blockHash, (g.seatsByBlock.get(v.blockHash) ?? 0) + seats);
    this.groupEpoch.set(key, Math.max(this.groupEpoch.get(key) ?? v.epoch, v.epoch));

    // 5. Finalize on absolute quorum.
    if ((g.seatsByBlock.get(v.blockHash) ?? 0) >= seatQuorum(this.params)) {
      g.final = v.blockHash;
      this.finalBlocks.add(v.blockHash);
      const rejected: Hex[] = [];
      for (const h of g.blocks) {
        if (h !== v.blockHash) {
          this.rejectedBlocks.add(h);
          rejected.push(h);
        }
      }
      // Free the per-voter tally detail (scales with vote volume); keep a tiny
      // tombstone (g.final + g.blocks) so late votes still short-circuit and
      // status() stays correct.
      g.voterChoice.clear();
      g.seatsByBlock.clear();
      this.groupEpoch.delete(key);
      return { accepted: true, finalized: v.blockHash, rejected };
    }
    return { accepted: true };
  }

  /**
   * Drop UNDECIDED groups whose latest vote predates the retention window — a stalled
   * fork that never reached quorum is governed by optimistic confirmation + the
   * recipient challenge window, not committee finality, so its vote detail is dead
   * weight. Decided groups keep their tiny tombstone. Returns the count dropped.
   * Call once per epoch (the ledger drives this from `advanceEpoch`).
   */
  pruneStale(currentEpoch: number, retainEpochs = 2): number {
    let dropped = 0;
    for (const [key, g] of this.groups) {
      if (g.final) continue; // decided: keep the tombstone (cost is O(1) per group)
      const epoch = this.groupEpoch.get(key) ?? currentEpoch;
      if (epoch < currentEpoch - retainEpochs) {
        for (const h of g.blocks) this.groupOf.delete(h);
        this.groups.delete(key);
        this.groupEpoch.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  status(blockHash: Hex): FinalityStatus {
    if (this.finalBlocks.has(blockHash)) return 'final';
    if (this.rejectedBlocks.has(blockHash)) return 'rejected';
    if (this.groupOf.has(blockHash)) return 'pending';
    return 'unknown';
  }

  isFinal(blockHash: Hex): boolean {
    return this.finalBlocks.has(blockHash);
  }

  /** Seats backing a block so far (diagnostic). */
  seatsFor(blockHash: Hex): number {
    const key = this.groupOf.get(blockHash);
    return key ? (this.groups.get(key)?.seatsByBlock.get(blockHash) ?? 0) : 0;
  }

  equivocations(): readonly { voterId: Hex; blockA: Hex; blockB: Hex }[] {
    return this.equivocs;
  }
}
