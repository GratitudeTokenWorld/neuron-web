import type { Hex } from '../core/hash.js';

/**
 * Optimistic + conflict-only voting, weighted by age-weighted-personhood weight.
 *
 * Adapted from the original block-lattice model (which is good): a block confirms
 * INSTANTLY on local validation; voting fires ONLY when two blocks share the same
 * (accountId, previousHash) — a double-spend fork. Then committee members vote,
 * weighted by {@link votingWeight}, and a 2/3-of-participating-weight threshold (or
 * a timeout) resolves the winner.
 *
 * Two changes from the original make it scale-safe (see docs/ARCHITECTURE.md):
 *   - weight is injected (age-weighted personhood), not raw balance;
 *   - the resolver detects EQUIVOCATION — a voter backing two blocks in the same
 *     conflict — and surfaces it as slashable evidence.
 *
 * This type is transport-agnostic: in production these calls are driven by votes
 * gossiped on the per-shard vote topic and weighed against the shard committee.
 */

export interface WeightedVote {
  blockHash: Hex;
  voterId: Hex;
  weight: number;
}

export interface Equivocation {
  voterId: Hex;
  groupKey: string;
  blockA: Hex;
  blockB: Hex;
}

export interface VoteOutcome {
  counted: boolean;
  equivocation?: Equivocation;
}

export interface ResolveOptions {
  /** Fraction of participating weight to finalize early (default 2/3). */
  threshold?: number;
  /** Force resolution (timeout): the highest-weight block wins. */
  timedOut?: boolean;
}

export type BlockStatus = 'confirmed' | 'rejected' | 'conflict' | 'pending';

const DEFAULT_THRESHOLD = 2 / 3;

interface Group {
  blocks: Set<Hex>;
  tally: Map<Hex, number>;
  voterChoice: Map<Hex, Hex>;
}

export class ConflictResolver {
  private readonly confirmed = new Set<Hex>();
  private readonly rejected = new Set<Hex>();
  private readonly blockGroup = new Map<Hex, string>();
  private readonly groups = new Map<string, Group>();
  private readonly equivocs: Equivocation[] = [];

  /** Register a block. Optimistically confirmed unless it forks an existing one. */
  register(blockHash: Hex, accountId: Hex, previousHash: Hex): 'confirmed' | 'conflict' {
    if (this.confirmed.has(blockHash)) return 'confirmed';
    if (this.rejected.has(blockHash)) return 'conflict';

    const key = `${accountId}:${previousHash}`;
    this.blockGroup.set(blockHash, key);
    let g = this.groups.get(key);
    if (!g) {
      g = { blocks: new Set(), tally: new Map(), voterChoice: new Map() };
      this.groups.set(key, g);
    }
    g.blocks.add(blockHash);

    if (g.blocks.size === 1) {
      this.confirmed.add(blockHash);
      return 'confirmed';
    }
    // Fork: revoke optimistic confirmations; everyone now needs votes.
    for (const h of g.blocks) {
      this.confirmed.delete(h);
      if (!g.tally.has(h)) g.tally.set(h, 0);
    }
    return 'conflict';
  }

  /** Cast a weighted vote. Only matters for blocks currently in conflict. */
  vote(v: WeightedVote): VoteOutcome {
    const key = this.blockGroup.get(v.blockHash);
    if (!key) return { counted: false };
    const g = this.groups.get(key)!;
    if (g.blocks.size < 2) return { counted: false }; // no conflict → no vote needed

    const prev = g.voterChoice.get(v.voterId);
    if (prev !== undefined) {
      if (prev === v.blockHash) return { counted: false }; // duplicate
      const equivocation: Equivocation = { voterId: v.voterId, groupKey: key, blockA: prev, blockB: v.blockHash };
      this.equivocs.push(equivocation);
      return { counted: false, equivocation };
    }
    g.voterChoice.set(v.voterId, v.blockHash);
    g.tally.set(v.blockHash, (g.tally.get(v.blockHash) ?? 0) + v.weight);
    return { counted: true };
  }

  /** Resolve every conflict that has met threshold (or, if timed out, has any votes). */
  resolve(opts: ResolveOptions = {}): { confirmed: Hex[]; rejected: Hex[] } {
    const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    const confirmed: Hex[] = [];
    const rejected: Hex[] = [];

    for (const [key, g] of [...this.groups]) {
      if (g.blocks.size < 2) continue;
      let winner = '';
      let best = -1;
      let total = 0;
      for (const [h, w] of g.tally) {
        total += w;
        if (w > best) {
          best = w;
          winner = h;
        }
      }
      const thresholdMet = total > 0 && best / total >= threshold;
      const resolvedByTimeout = !!opts.timedOut && best > 0;
      if (!thresholdMet && !resolvedByTimeout) continue;

      this.confirmed.add(winner);
      confirmed.push(winner);
      for (const h of g.blocks) {
        if (h !== winner) {
          this.rejected.add(h);
          rejected.push(h);
        }
      }
      this.groups.delete(key);
    }
    return { confirmed, rejected };
  }

  status(blockHash: Hex): BlockStatus {
    if (this.confirmed.has(blockHash)) return 'confirmed';
    if (this.rejected.has(blockHash)) return 'rejected';
    const key = this.blockGroup.get(blockHash);
    if (key && (this.groups.get(key)?.blocks.size ?? 0) > 1) return 'conflict';
    return 'pending';
  }

  equivocations(): readonly Equivocation[] {
    return this.equivocs;
  }
}
