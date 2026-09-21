/**
 * Fixed-window rate-limit bookkeeping, and the sweep that keeps it bounded.
 *
 * ## Why this exists
 *
 * A per-IP rate limiter is a `Map` keyed by something the CALLER chooses. That
 * is fine for the counting and fatal for the memory: the relay's three IP logs
 * (`ipVerifyLog`, `ipReleaseLog`, `ipBlobLog`) created an entry per distinct
 * source address and never removed one, so their size was
 * `O(distinct addresses ever seen)` — a number an outsider picks. With IPv6 a
 * single /64 hands an attacker 2^64 addresses, which turns the anti-abuse
 * control into the thing being abused.
 *
 * The same shape had already bitten `BackfillLimiter`, which forgot to drop the
 * keys nothing ever answered. **Limiter bookkeeping is itself state an attacker
 * grows**, and it has to be swept like any other cache.
 *
 * ## Why sweeping is free
 *
 * `checkAndRecordIp` treats an entry whose window has fully elapsed exactly as
 * it treats a missing one: it starts a new window. So deleting expired entries
 * cannot change a single decision the limiter makes — it is a pure memory
 * reclaim, which is the reason it can be applied without re-reasoning about the
 * limits themselves. `sweepIsDecisionPreserving` in the tests pins that.
 */

/** One fixed window: how many requests, and when the window opened. */
export interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * Is this entry still meaningful, or has its window fully elapsed?
 *
 * The same predicate the limiter itself applies, exported so the sweep and the
 * decision can never drift apart — the rule this codebase learned the hard way
 * when a signer and a verifier lived in different files.
 */
export function windowExpired(entry: WindowEntry | undefined, windowMs: number, now: number): boolean {
  if (!entry) return true;
  return now - entry.windowStart > windowMs;
}

/**
 * Drop every entry whose window has fully elapsed. Returns how many went.
 *
 * Safe to call at any cadence: it removes only entries the limiter already
 * ignores. Call it on a timer rather than per request — per request it would be
 * `O(entries)` work on the hot path to save memory that is not yet a problem.
 */
export function sweepExpiredWindows(
  log: Map<string, WindowEntry>,
  windowMs: number,
  now = Date.now(),
): number {
  let dropped = 0;
  for (const [key, entry] of log) {
    if (windowExpired(entry, windowMs, now)) {
      log.delete(key);
      dropped++;
    }
  }
  return dropped;
}
