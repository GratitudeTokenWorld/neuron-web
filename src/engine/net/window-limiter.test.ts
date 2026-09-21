import { describe, it, expect } from 'vitest';
import { sweepExpiredWindows, windowExpired, type WindowEntry } from './window-limiter.js';

const WINDOW = 24 * 60 * 60 * 1000;

/** The relay's own limiter, reproduced so the sweep can be proven harmless. */
function checkAndRecord(log: Map<string, WindowEntry>, key: string, max: number, now: number): boolean {
  const entry = log.get(key);
  if (!entry || now - entry.windowStart > WINDOW) {
    log.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

describe('sweepExpiredWindows', () => {
  it('drops entries whose window has fully elapsed', () => {
    const log = new Map<string, WindowEntry>([
      ['1.1.1.1', { count: 5, windowStart: 0 }],
      ['2.2.2.2', { count: 5, windowStart: WINDOW }],
    ]);
    expect(sweepExpiredWindows(log, WINDOW, WINDOW + 1)).toBe(1);
    expect([...log.keys()]).toEqual(['2.2.2.2']);
  });

  it('keeps a window that is still open, however full it is', () => {
    // A key at its limit is the one that matters most: dropping it would reset
    // the count and hand the limit back to whoever is being limited.
    const log = new Map<string, WindowEntry>([['bad', { count: 9_999, windowStart: 1_000 }]]);
    expect(sweepExpiredWindows(log, WINDOW, 1_000 + WINDOW)).toBe(0);
    expect(log.size).toBe(1);
  });

  it('is a no-op on an empty log', () => {
    expect(sweepExpiredWindows(new Map(), WINDOW, 1)).toBe(0);
  });
});

describe('the sweep cannot change a decision', () => {
  it('gives identical verdicts with and without sweeping', () => {
    // This is the property that makes the fix safe to apply without
    // re-reasoning about the limits: an expired entry is already treated as
    // absent, so removing it is pure memory reclaim.
    const swept = new Map<string, WindowEntry>();
    const kept = new Map<string, WindowEntry>();
    const MAX = 3;
    const verdicts: Array<[boolean, boolean]> = [];

    let now = 0;
    for (let i = 0; i < 200; i++) {
      const key = `ip-${i % 7}`;
      now += 3 * 60 * 60 * 1000;                     // 3h per step, so windows lapse
      if (i % 5 === 0) sweepExpiredWindows(swept, WINDOW, now);
      verdicts.push([
        checkAndRecord(swept, key, MAX, now),
        checkAndRecord(kept, key, MAX, now),
      ]);
    }
    for (const [a, b] of verdicts) expect(a).toBe(b);
  });

  it('reclaims the memory an attacker would otherwise grow without bound', () => {
    // The vector: one entry per distinct source address, kept for the life of
    // the process. With IPv6 a single /64 is 2^64 addresses, so the size of an
    // anti-abuse map is a number the abuser chooses.
    const log = new Map<string, WindowEntry>();
    for (let i = 0; i < 10_000; i++) checkAndRecord(log, `2001:db8::${i}`, 5, 0);
    expect(log.size).toBe(10_000);

    // A day later none of them mean anything, and none of them are left.
    sweepExpiredWindows(log, WINDOW, WINDOW + 1);
    expect(log.size).toBe(0);
  });
});

describe('windowExpired', () => {
  it('treats a missing entry as expired, exactly as the limiter does', () => {
    // Shared predicate on purpose: a sweep that disagreed with the limiter
    // about what "expired" means would either leak or reset live counters.
    expect(windowExpired(undefined, WINDOW, 0)).toBe(true);
    expect(windowExpired({ count: 1, windowStart: 0 }, WINDOW, WINDOW)).toBe(false);
    expect(windowExpired({ count: 1, windowStart: 0 }, WINDOW, WINDOW + 1)).toBe(true);
  });
});
