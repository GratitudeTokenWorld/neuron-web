import { getShard, DEFAULT_NUM_SHARDS } from '../core/partition.js';
import type { Hex } from '../core/hash.js';

/**
 * A node's interest set — the heart of partial replication.
 *
 * A node receives and stores an account's blocks only if it `wants` that account.
 * Two roles:
 *   - LIGHT CLIENT (browser/mobile): wants = own accounts + followed accounts.
 *     Cost is O(own + followed) — flat as the network grows. This is the common case.
 *   - SUPER-NODE (server): additionally subscribes to whole shards, holding every
 *     account in them. Cost is O(accounts-in-shard) ≈ O(N / numShards) — bounded
 *     per node by choosing enough shards, and spread across many super-nodes.
 *
 * Light clients deliberately do NOT subscribe to their own shard wholesale (that
 * would pull in every co-resident account and reintroduce O(N) growth); they
 * follow specific accounts instead.
 */
export class Subscription {
  readonly ownAccounts = new Set<Hex>();
  readonly followed = new Set<Hex>();
  readonly shards = new Set<number>();

  constructor(readonly numShards: number = DEFAULT_NUM_SHARDS) {}

  /** Register an account this node owns (followed implicitly). */
  own(accountId: Hex): this {
    this.ownAccounts.add(accountId);
    return this;
  }

  /** Follow another account's chain (interest-based replication). */
  follow(accountId: Hex): this {
    this.followed.add(accountId);
    return this;
  }

  unfollow(accountId: Hex): this {
    this.followed.delete(accountId);
    return this;
  }

  /** Super-node only: subscribe to an entire shard. */
  subscribeShard(shard: number): this {
    this.shards.add(shard);
    return this;
  }

  /** True if this node wants to receive/hold `accountId`'s blocks. */
  wants(accountId: Hex): boolean {
    if (this.ownAccounts.has(accountId) || this.followed.has(accountId)) return true;
    if (this.shards.size > 0 && this.shards.has(getShard(accountId, this.numShards))) return true;
    return false;
  }

  /** Number of distinct accounts this light client tracks by interest (own + followed). */
  interestSize(): number {
    const ids = new Set<Hex>([...this.ownAccounts, ...this.followed]);
    return ids.size;
  }
}
