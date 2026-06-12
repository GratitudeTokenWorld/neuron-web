import { hash, utf8ToBytes, type Hex } from './hash.js';

/**
 * Data partitioning (shards / "synapses").
 *
 * The global account space is split into a large, fixed number of shards. A node
 * holds only the shards it cares about (its own accounts + followed accounts +,
 * for super-nodes, assigned shards), which is what keeps per-node cost O(own +
 * followed) instead of O(network).
 *
 * SECURITY NOTE — account→shard placement is intentionally DETERMINISTIC: every
 * node must be able to compute which shard holds an account without coordination.
 * That is safe on its own. What must NOT be grindable is validator→committee
 * assignment, which the roadmap derives from an unbiasable epoch randomness
 * beacon / VRF (Phase 2). Placing your own account in a chosen shard buys an
 * attacker nothing unless they also control that shard's (randomly sampled)
 * committee. Keep these two mappings separate.
 */

/** Default shard count. 4096 = 2^12 — large enough to spread 1B accounts, small
 *  enough that a committee per shard is populated. Tunable per network. */
export const DEFAULT_NUM_SHARDS = 4096;

/**
 * Map an accountId (or any stable key) to its shard index in `[0, numShards)`.
 * Uses the full 32-byte SHA-256 reduced mod numShards to avoid the modulo bias
 * of taking only the low bytes.
 */
export function getShard(accountId: Hex | string, numShards: number = DEFAULT_NUM_SHARDS): number {
  if (!Number.isInteger(numShards) || numShards <= 0) {
    throw new RangeError(`numShards must be a positive integer, got ${numShards}`);
  }
  if (numShards === 1) return 0;
  const digest = hash(utf8ToBytes(accountId));
  // Reduce the 256-bit digest mod numShards via Horner's method over bytes.
  let rem = 0;
  for (const byte of digest) {
    rem = (rem * 256 + byte) % numShards;
  }
  return rem;
}

/** True if `accountId` lives in one of the shards this node subscribes to. */
export function isInSubscribedShards(
  accountId: Hex | string,
  subscribed: ReadonlySet<number>,
  numShards: number = DEFAULT_NUM_SHARDS,
): boolean {
  return subscribed.has(getShard(accountId, numShards));
}
