import { describe, it, expect } from 'vitest';
import { BackfillLimiter, DEFAULT_BACKFILL_POLICY } from './archive-backfill.js';

/**
 * The thing under test is a LIMITER, so most of these assert that it refuses.
 * A backfill is an optimisation — the client asked several relays and verifies
 * every answer — so being slow to heal costs one extra query, while being eager
 * turns any stranger's HTTP miss into federation-wide gossip.
 */

const KEY = 'testnet:03abc';

describe('asking at all', () => {
  it('asks on the first miss, and says it was the first', () => {
    const b = new BackfillLimiter();
    expect(b.request(KEY, 1000)).toEqual({ ask: true, reason: 'first miss' });
  });

  it('does not ask twice while a request is outstanding', () => {
    const b = new BackfillLimiter();
    b.request(KEY, 1000);
    // A second miss a millisecond later is the same question, not a new one.
    expect(b.request(KEY, 1001)).toEqual({ ask: false, reason: 'already in flight' });
  });

  it('frees the slot when a request goes unanswered past its TTL', () => {
    const b = new BackfillLimiter({ inFlightTtlMs: 5_000, cooldownMs: 1_000 });
    b.request(KEY, 0);
    // Still outstanding just before the TTL...
    expect(b.request(KEY, 4_999).ask).toBe(false);
    // ...and askable again after it, or one lost gossip message would wedge
    // this key permanently.
    expect(b.request(KEY, 6_000).ask).toBe(true);
  });
});

describe('backoff', () => {
  it('waits longer after each unanswered attempt', () => {
    const b = new BackfillLimiter({ cooldownMs: 1_000, inFlightTtlMs: 10, maxAttempts: 9 });
    b.request(KEY, 0);                                   // attempt 1
    expect(b.request(KEY, 900).ask).toBe(false);          // 1× cooldown not up
    expect(b.request(KEY, 1_100).ask).toBe(true);         // attempt 2

    expect(b.request(KEY, 2_500).ask).toBe(false);        // now needs 2×
    expect(b.request(KEY, 3_200).ask).toBe(true);         // attempt 3

    expect(b.request(KEY, 6_000).ask).toBe(false);        // now needs 4×
    expect(b.request(KEY, 7_300).ask).toBe(true);         // attempt 4
  });

  it('gives up on a key nothing ever answers', () => {
    // The common miss is a query for something that does not exist anywhere —
    // a typo, a probe, a scan. Those must stop costing the federation.
    const b = new BackfillLimiter({ cooldownMs: 1, inFlightTtlMs: 1, maxAttempts: 3 });
    let t = 0;
    for (let i = 0; i < 3; i++) { expect(b.request(KEY, t).ask).toBe(true); t += 10_000; }
    expect(b.request(KEY, t)).toEqual({ ask: false, reason: 'giving up on this key' });
    // And it stays given up, however long we wait.
    expect(b.request(KEY, t + 86_400_000).ask).toBe(false);
  });

  it('forgets the attempts once an answer arrives', () => {
    const b = new BackfillLimiter({ cooldownMs: 1, inFlightTtlMs: 1, maxAttempts: 2 });
    b.request(KEY, 0);
    b.settle(KEY);
    // A healed key is a fresh key: the next genuine miss is a first miss again.
    expect(b.request(KEY, 10_000)).toEqual({ ask: true, reason: 'first miss' });
  });

  it('drops healed keys instead of remembering them forever', () => {
    // Keeping one entry per account ever queried is O(queries) memory — the
    // invariant this module exists to respect, violated by its own bookkeeping.
    const b = new BackfillLimiter();
    for (let i = 0; i < 100; i++) { b.request(`testnet:acct${i}`, i); b.settle(`testnet:acct${i}`); }
    expect(b.stats(1_000).tracked).toBe(0);
  });
});

describe('ceilings', () => {
  it('caps how many requests may be outstanding at once', () => {
    const b = new BackfillLimiter({ maxInFlight: 3, inFlightTtlMs: 60_000 });
    for (let i = 0; i < 3; i++) expect(b.request(`k${i}`, 0).ask).toBe(true);
    expect(b.request('k3', 0)).toEqual({ ask: false, reason: 'too many in flight' });

    // Settling one frees exactly one slot.
    b.settle('k0');
    expect(b.request('k3', 0).ask).toBe(true);
  });

  it('caps the total rate, so an HTTP scan cannot be amplified into gossip', () => {
    const b = new BackfillLimiter({ maxPerMinute: 5, maxInFlight: 1_000, inFlightTtlMs: 1 });
    for (let i = 0; i < 5; i++) expect(b.request(`k${i}`, i).ask).toBe(true);
    expect(b.request('k5', 6)).toEqual({ ask: false, reason: 'rate ceiling' });
  });

  it('lets the rate window roll forward', () => {
    const b = new BackfillLimiter({ maxPerMinute: 2, maxInFlight: 1_000, inFlightTtlMs: 1 });
    expect(b.request('a', 0).ask).toBe(true);
    expect(b.request('b', 1_000).ask).toBe(true);
    expect(b.request('c', 2_000).ask).toBe(false);
    // Just past a minute from the first two, the budget is back.
    expect(b.request('c', 61_001).ask).toBe(true);
  });

  it('does not let an abandoned key consume the budget', () => {
    // Per-key refusals must be decided BEFORE the ceilings, or a hot dead key
    // would spend the federation's request budget on nothing.
    const b = new BackfillLimiter({ cooldownMs: 1, inFlightTtlMs: 1, maxAttempts: 1, maxPerMinute: 3 });
    b.request(KEY, 0);                                    // uses 1 of 3
    for (let i = 0; i < 50; i++) b.request(KEY, 1_000 + i); // all refused, none spent
    expect(b.stats(2_000).lastMinute).toBe(1);
    expect(b.request('other', 2_000).ask).toBe(true);
  });
});

describe('defaults', () => {
  it('ships conservative numbers', () => {
    // These are load-bearing: a relay under a scan must not become a gossip
    // amplifier, and the failure mode of being too slow is one extra query.
    expect(DEFAULT_BACKFILL_POLICY.maxPerMinute).toBeLessThanOrEqual(60);
    expect(DEFAULT_BACKFILL_POLICY.maxInFlight).toBeLessThanOrEqual(16);
    expect(DEFAULT_BACKFILL_POLICY.maxAttempts).toBeLessThanOrEqual(5);
    expect(DEFAULT_BACKFILL_POLICY.cooldownMs).toBeGreaterThanOrEqual(30_000);
  });

  it('clears everything on a wipe', () => {
    const b = new BackfillLimiter();
    b.request('testnet:x', 0);
    b.clear();
    expect(b.stats(0)).toEqual({ tracked: 0, inFlight: 0, lastMinute: 0 });
  });
});
