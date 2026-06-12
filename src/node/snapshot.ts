import type { AccountStore } from './account-store.js';
import { getShard, DEFAULT_NUM_SHARDS } from '../core/partition.js';
import { verifyAccountHead, type AccountHeadProof } from '../core/light-verify.js';
import type { QuorumPolicy } from '../core/attestation.js';
import type { Block } from '../core/block.js';
import type { Hex } from '../core/hash.js';

/**
 * Per-shard snapshots — fast bootstrap.
 *
 * A snapshot of a shard is just the set of light-verifiable head proofs for the
 * accounts in that shard (open block + head + inclusion proof). A node joining (or
 * a light client picking up a shard it now follows) can establish trusted heads by
 * verifying each proof independently — no chain replay. This reuses the Phase 0
 * light-verification primitive directly; the only new thing is scoping it to a
 * shard and shipping the proofs as a unit.
 */

export interface ShardSnapshot {
  shard: number;
  numShards: number;
  accounts: AccountHeadProof[];
}

/** Build a snapshot of every account in `shard` held by `source`. */
export function createShardSnapshot(
  source: AccountStore,
  shard: number,
  numShards: number = DEFAULT_NUM_SHARDS,
): ShardSnapshot {
  const accounts: AccountHeadProof[] = [];
  for (const id of source.accountIds()) {
    if (getShard(id, numShards) !== shard) continue;
    const proof = source.headProof(id);
    if (proof) accounts.push(proof);
  }
  return { shard, numShards, accounts };
}

export interface TrustedHead {
  accountId: Hex;
  head: Block;
  balance: bigint;
}

export interface ApplySnapshotResult {
  trusted: TrustedHead[];
  rejected: number;
}

/**
 * Consume a snapshot: independently verify each account head against the identity
 * quorum policy and the accumulator inclusion proof. Returns the trusted heads;
 * anything that fails verification is rejected (count returned).
 */
export function applyShardSnapshot(snapshot: ShardSnapshot, identityPolicy: QuorumPolicy): ApplySnapshotResult {
  const trusted: TrustedHead[] = [];
  let rejected = 0;
  for (const proof of snapshot.accounts) {
    const r = verifyAccountHead(proof, identityPolicy);
    if (r.ok) trusted.push({ accountId: r.accountId!, head: proof.headBlock, balance: r.balance! });
    else rejected++;
  }
  return { trusted, rejected };
}
