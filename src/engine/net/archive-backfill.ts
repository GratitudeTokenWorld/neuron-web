/**
 * Archive backfill: what a relay may ask its peers for, and how often.
 *
 * ## The gap this closes
 *
 * A relay that was down when a block was gossiped never learns it. The
 * peer-relay poll syncs only the reset *generation*, so anything from an outage
 * window — sends, mints, account records, storage departures — is simply
 * missing from that archive forever. It is bounded rather than dangerous
 * (clients verify every answer and take the UNION across relays, and a client's
 * next full publish re-seeds whatever a relay missed), but a relay that answers
 * "I don't have it" for state the network holds is a hole in the directory.
 *
 * ## Why demand-driven, and never a sync-on-rejoin
 *
 * The obvious fix — a relay syncs its whole archive on restart — is `O(archive)`
 * on the ANSWERING side, which is the scale invariant violated at exactly the
 * place this project keeps violating it (ARCHITECTURE.md → Fan-IN). Instead a
 * relay asks only for what it was actually asked for and did not have:
 * `O(actual queries)`. It is the same "verify and repair on USE, not by
 * watching" shape as content repair — a miss is the cheapest possible evidence
 * that this archive is behind, and it was going to happen anyway.
 *
 * ## Why this module is a LIMITER and not just a "go ask"
 *
 * The common miss is not a relay being behind — it is a query for something
 * that does not exist: a typo, a probe, a scan. Asking peers for every one of
 * those turns a stranger's HTTP request into gossip traffic across the
 * federation, i.e. an amplifier pointed at the network by anyone who can spell
 * a URL. So the request is rate-limited per key, capped in flight, capped
 * globally, and backed off for keys that keep coming back empty.
 *
 * Pure and dependency-free on purpose: `relay/server.ts` is covered by neither
 * the typecheck nor any test, so every rule that can live here does.
 */

/** Why a backfill request was or was not made. Never silent. */
export type BackfillDecision =
  | { ask: true; reason: 'first miss' | 'cooldown elapsed' }
  | { ask: false; reason: 'already in flight' | 'cooling down' | 'too many in flight' | 'rate ceiling' | 'giving up on this key' };

export interface BackfillPolicy {
  /** Minimum gap between requests for the SAME key, before backoff. */
  cooldownMs: number;
  /** Outstanding requests allowed at once. */
  maxInFlight: number;
  /** How long a request counts as outstanding before the slot is reclaimed. */
  inFlightTtlMs: number;
  /** Ceiling across all keys, per rolling minute. */
  maxPerMinute: number;
  /** Consecutive unanswered attempts before a key is abandoned. */
  maxAttempts: number;
  /**
   * How long a key is remembered after its last ask.
   *
   * Without this the map grows by one entry per distinct key ever asked about
   * and never healed — `settle` deletes the ones that WORKED, and an abandoned
   * key was kept forever. At 60 asks a minute that is ~86k permanent entries a
   * day for anyone scanning URLs: `O(queries)` memory with a remote trigger,
   * which is the invariant this module exists to protect, violated by its own
   * bookkeeping.
   *
   * Forgetting is also the correct BEHAVIOUR. "Nothing has this account" is a
   * statement about a moment, not forever: an account that did not exist an
   * hour ago may exist now, and a permanently abandoned key could never learn
   * that.
   */
  forgetAfterMs: number;
}

/**
 * Deliberately conservative. A backfill is an optimisation — the client asked
 * several relays and verifies every answer — so being slow to heal costs a
 * second query, while being eager costs the federation bandwidth on behalf of
 * whoever is scanning us.
 */
export const DEFAULT_BACKFILL_POLICY: BackfillPolicy = {
  cooldownMs: 60_000,
  maxInFlight: 8,
  inFlightTtlMs: 15_000,
  maxPerMinute: 60,
  maxAttempts: 3,
  forgetAfterMs: 3_600_000,
};

interface KeyState {
  /** When the last request went out. */
  lastAskedAt: number;
  /** Consecutive requests that produced nothing. */
  attempts: number;
  /** Set while a request is outstanding; cleared by `settle`. */
  inFlightSince?: number;
}

/**
 * Decides whether to ask peers for an account's blocks, and remembers enough to
 * stop asking.
 *
 * Keys are caller-chosen strings — `${network}:${accountId}` in the relay — so
 * this module needs to know nothing about either.
 */
export class BackfillLimiter {
  private readonly policy: BackfillPolicy;
  private readonly keys = new Map<string, KeyState>();
  /** Timestamps of recent asks, for the rolling per-minute ceiling. */
  private recent: number[] = [];

  constructor(policy: Partial<BackfillPolicy> = {}) {
    this.policy = { ...DEFAULT_BACKFILL_POLICY, ...policy };
  }

  /**
   * May we ask peers for `key` right now? Records the ask if the answer is yes.
   *
   * The order of the checks is the policy: per-key state first (cheap, and the
   * common case), then the global ceilings. A key that is being abandoned must
   * lose to the ceiling checks, or an abandoned key would still consume budget.
   */
  request(key: string, now = Date.now()): BackfillDecision {
    this.expire(now);
    const st = this.keys.get(key);

    if (st?.inFlightSince !== undefined) {
      return { ask: false, reason: 'already in flight' };
    }
    if (st && st.attempts >= this.policy.maxAttempts) {
      // Nothing has answered this key `maxAttempts` times. Almost certainly it
      // does not exist anywhere — asking again is only ever noise.
      return { ask: false, reason: 'giving up on this key' };
    }
    if (st && now - st.lastAskedAt < this.backoffFor(st.attempts)) {
      return { ask: false, reason: 'cooling down' };
    }
    if (this.inFlightCount() >= this.policy.maxInFlight) {
      return { ask: false, reason: 'too many in flight' };
    }
    if (this.recent.length >= this.policy.maxPerMinute) {
      return { ask: false, reason: 'rate ceiling' };
    }

    this.keys.set(key, {
      lastAskedAt: now,
      attempts: (st?.attempts ?? 0) + 1,
      inFlightSince: now,
    });
    this.recent.push(now);
    return { ask: true, reason: st ? 'cooldown elapsed' : 'first miss' };
  }

  /**
   * An answer arrived for `key` — free the slot and forget the attempts.
   *
   * Called when blocks for that account are ingested, not when the peer
   * acknowledges: the point of the request is the DATA, and a peer that replies
   * with nothing has not healed anything.
   */
  settle(key: string): void {
    const st = this.keys.get(key);
    if (!st) return;
    // Delete rather than zero the counters: a key that has been healed is no
    // longer interesting, and keeping it would grow this map by one entry per
    // account the relay was ever asked about — O(queries) memory, which is the
    // invariant this whole module exists to respect.
    this.keys.delete(key);
  }

  /** Reclaim slots whose requests were never answered, and age out the window. */
  private expire(now: number): void {
    for (const [key, st] of this.keys) {
      if (st.inFlightSince !== undefined && now - st.inFlightSince >= this.policy.inFlightTtlMs) {
        st.inFlightSince = undefined;   // slot freed; attempts deliberately kept
      }
      // Forget keys nothing is waiting on. An in-flight request is never
      // dropped, or its slot would leak instead of its entry.
      if (st.inFlightSince === undefined && now - st.lastAskedAt >= this.policy.forgetAfterMs) {
        this.keys.delete(key);
      }
    }
    const cutoff = now - 60_000;
    if (this.recent.length > 0 && this.recent[0]! <= cutoff) {
      this.recent = this.recent.filter((t) => t > cutoff);
    }
  }

  /** Exponential per-key backoff: 1×, 2×, 4× the cooldown. */
  private backoffFor(attempts: number): number {
    return this.policy.cooldownMs * Math.pow(2, Math.max(0, attempts - 1));
  }

  private inFlightCount(): number {
    let n = 0;
    for (const st of this.keys.values()) if (st.inFlightSince !== undefined) n++;
    return n;
  }

  /** For logging and tests. */
  stats(now = Date.now()): { tracked: number; inFlight: number; lastMinute: number } {
    this.expire(now);
    return { tracked: this.keys.size, inFlight: this.inFlightCount(), lastMinute: this.recent.length };
  }

  /**
   * Drop every key. Used on a network wipe: the generation changed, so what we
   * were failing to find no longer exists in the sense we were asking about.
   */
  clear(): void {
    this.keys.clear();
    this.recent = [];
  }
}
