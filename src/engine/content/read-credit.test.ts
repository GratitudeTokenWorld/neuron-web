import { describe, it, expect } from 'vitest';
import {
  readCredit, cumulativeCredit, maxCreditPerFile, providerCeilingPerReader,
  FREE_READS_PER_FILE_PER_WINDOW, DEFAULT_TAPER, type TaperPolicy,
} from './read-credit.js';

/**
 * Hypothesis H-P9: counting reads per FILE with diminishing returns separates
 * honest reading from wash-reading better than a flat byte cap.
 *
 * Disproved by a policy where repeating one file earns comparably to reading
 * that many distinct files — i.e. where depth pays like breadth.
 */

const HARD: TaperPolicy = { kind: 'hard' };
const HARMONIC: TaperPolicy = { kind: 'harmonic' };
const GEOMETRIC: TaperPolicy = { kind: 'geometric', ratio: 0.5 };

describe('H-P9: depth is worthless, breadth is unlimited', () => {
  it('pays a million re-reads of one file about what TWO reads are worth', () => {
    // The whole point. Honest reading is broad - many files, once each, then
    // cached. Wash-reading is deep, because an attacker has only so much
    // content and repeating it is free.
    expect(cumulativeCredit(1_000_000, GEOMETRIC)).toBeCloseTo(2, 5);
    expect(cumulativeCredit(1_000_000, HARD)).toBe(1);
  });

  it('pays breadth in full — 10,000 distinct files earn 10,000', () => {
    // Each file's first read is worth full value, so a reader that fetches a
    // provider's whole catalogue is paid for all of it.
    const distinctFiles = 10_000;
    const total = distinctFiles * readCredit(1, GEOMETRIC);
    expect(total).toBe(10_000);
  });

  it('separates the two by ~5000x at realistic volumes', () => {
    const attack = cumulativeCredit(1_000_000, GEOMETRIC); // one file, a million times
    const honest = 10_000 * readCredit(1, GEOMETRIC);      // 10k files, once each
    expect(honest / attack).toBeGreaterThan(4_000);
  });

  it('still pays something for a GENUINE re-read', () => {
    // A cache evicted early, or a second device. Charging nothing would be
    // slightly unfair; `hard` does that, which is why it is not the default.
    expect(readCredit(2, GEOMETRIC)).toBe(0.5);
    expect(readCredit(2, HARD)).toBe(0);
  });
});

describe('choosing the taper', () => {
  it('bounds what one file can ever yield, under the default', () => {
    expect(maxCreditPerFile(GEOMETRIC)).toBe(2);
    expect(maxCreditPerFile(HARD)).toBe(FREE_READS_PER_FILE_PER_WINDOW);
  });

  it('reports harmonic as UNBOUNDED, because it is', () => {
    // It grows like a logarithm, which is slow - but slow is not bounded, and
    // "bounded" and "grows like log" are different promises. Only one is a
    // guarantee, so the difference is reported rather than smoothed over.
    expect(maxCreditPerFile(HARMONIC)).toBe(Infinity);
    expect(cumulativeCredit(1_000_000, HARMONIC)).toBeGreaterThan(14);
  });

  it('defaults to geometric — bounded, and forgiving of one re-read', () => {
    expect(DEFAULT_TAPER).toEqual({ kind: 'geometric', ratio: 0.5 });
  });
});

describe('the ceiling now scales with content the attacker must PAY for', () => {
  it('grows with distinct files held, not with a flat number', () => {
    // The improvement over a flat per-pair byte cap: a provider holding a real
    // catalogue can legitimately earn from a reader in proportion to it, while
    // an attacker must actually hold every file it claims - and each one has to
    // survive sampled custody challenges.
    const MB = 1024 ** 2;
    const small = providerCeilingPerReader({ filesHeld: 100, policy: GEOMETRIC, avgFileBytes: 5 * MB });
    const large = providerCeilingPerReader({ filesHeld: 10_000, policy: GEOMETRIC, avgFileBytes: 5 * MB });
    expect(small.creditedBytes / 1024 ** 3).toBeCloseTo(1, 1);
    expect(large.creditedBytes / 1024 ** 3).toBeCloseTo(97.7, 0);
    expect(large.creditedReads / small.creditedReads).toBe(100);
  });

  it('is more generous than the flat 128 MB cap for an honest large provider', () => {
    // The flat cap punished breadth: a provider holding ten thousand files
    // legitimately serves ten thousand distinct reads and hit the cap.
    const MB = 1024 ** 2;
    const large = providerCeilingPerReader({ filesHeld: 10_000, policy: GEOMETRIC, avgFileBytes: 5 * MB });
    expect(large.creditedBytes).toBeGreaterThan(128 * MB);
  });

  it('is UNBOUNDED under harmonic, which is why it is not the default', () => {
    const MB = 1024 ** 2;
    const c = providerCeilingPerReader({ filesHeld: 10_000, policy: HARMONIC, avgFileBytes: 5 * MB });
    expect(c.creditedReads).toBe(Infinity);
  });
});
