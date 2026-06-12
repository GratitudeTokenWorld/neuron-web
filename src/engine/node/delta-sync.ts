import type { Block } from '../core/block.js';
import type { AccountStore } from './account-store.js';
import type { Hex } from '../core/hash.js';

/**
 * Account-scoped delta sync.
 *
 * Because each account is an independent append-only chain, a node can catch up
 * on a single followed account by fetching only that account's tail — never the
 * whole network's history. This is what makes "follow N accounts" cost O(N) to
 * sync, and what lets a light client join late and still be cheap.
 */

export interface DeltaRequest {
  accountId: Hex;
  /** Highest block index already held (-1 if the account is unknown). */
  haveIndex: number;
}

/** What a destination should ask for to catch up one account. */
export function deltaRequestFor(dest: AccountStore, accountId: Hex): DeltaRequest {
  const head = dest.head(accountId);
  return { accountId, haveIndex: head ? head.index : -1 };
}

/**
 * Serve a delta from a source store: only the requested account's blocks with
 * index > haveIndex. Reads a single account — cost is O(tail), not O(store).
 */
export function serveDelta(source: AccountStore, req: DeltaRequest): Block[] {
  const chain = source.chain(req.accountId);
  const from = Math.max(0, req.haveIndex + 1);
  return chain.slice(from) as Block[];
}

export interface ApplyDeltaResult {
  applied: number;
  reason?: string;
}

/** Apply a delta in order, stopping (and reporting) on the first invalid block. */
export function applyDelta(dest: AccountStore, blocks: readonly Block[]): ApplyDeltaResult {
  let applied = 0;
  for (const b of blocks) {
    const r = dest.apply(b);
    if (!r.ok) return { applied, reason: r.reason };
    applied++;
  }
  return { applied };
}

/** One-shot helper: sync `accountId` from `source` into `dest`. */
export function syncAccount(dest: AccountStore, source: AccountStore, accountId: Hex): ApplyDeltaResult {
  return applyDelta(dest, serveDelta(source, deltaRequestFor(dest, accountId)));
}
