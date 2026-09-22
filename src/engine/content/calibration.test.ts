import { describe, it, expect } from 'vitest';
import {
  CalibrationRun, calibrationPayload, calibrationStale, effectiveCapacity,
  CALIBRATION_SMALL_BYTES, CALIBRATION_LARGE_BYTES,
  MIN_SAMPLES_PER_LEVEL, MIN_DISTINCT_PROBERS, DEGRADATION_FACTOR,
} from './calibration.js';

/**
 * Hypothesis H-C1: a node's serving capacity can be MEASURED by real peers
 * rather than declared, and the measurement knows when it does not know.
 *
 * Disproved by: a knee found from a sample too thin to support one, a result
 * called confident when one prober supplied it, or a ladder that never
 * degraded being reported as a maximum rather than a lower bound.
 */

/** Build samples: `okUpTo` is the highest rung that still serves well. */
function run(opts: {
  okUpTo: number;
  probers?: string[];
  levels?: number[];
  baselineMs?: number;
  perLevel?: number;
}): CalibrationRun {
  const r = new CalibrationRun();
  const probers = opts.probers ?? ['p1', 'p2', 'p3'];
  const levels = opts.levels ?? [1, 2, 4, 8, 16];
  const baseline = opts.baselineMs ?? 100;
  const perLevel = opts.perLevel ?? MIN_SAMPLES_PER_LEVEL;
  for (const level of levels) {
    for (let i = 0; i < perLevel; i++) {
      const healthy = level <= opts.okUpTo;
      r.add({
        level,
        size: 'small',
        ok: healthy,
        // Past the knee, latency blows well past the degradation factor.
        latencyMs: healthy ? baseline : baseline * (DEGRADATION_FACTOR + 5),
        prober: probers[i % probers.length]!,
      });
    }
  }
  return r;
}

describe('H-C1: the knee is found from real probes', () => {
  it('reports the last healthy rung as the capacity', () => {
    const res = run({ okUpTo: 4 }).analyze();
    expect(res.maxConcurrentReads).toBe(4);
    expect(res.confident).toBe(true);
    expect(res.reason).toContain('degraded at 8');
  });

  it('separates a phone from a server on the same ladder', () => {
    expect(run({ okUpTo: 2 }).analyze().maxConcurrentReads).toBe(2);
    expect(run({ okUpTo: 16 }).analyze().maxConcurrentReads).toBe(16);
  });

  it('degrades on failure rate even when the survivors are fast', () => {
    // A node that drops half the requests but answers the rest quickly is
    // saturated, and latency alone would call it healthy.
    const r = new CalibrationRun();
    for (const level of [1, 2]) {
      for (let i = 0; i < 4; i++) {
        r.add({ level, size: 'small', ok: level === 1 || i === 0, latencyMs: 100, prober: `p${i}` });
      }
    }
    expect(r.analyze().maxConcurrentReads).toBe(1);
  });
});

describe('it knows when it does not know', () => {
  it('refuses to judge a rung with too few samples', () => {
    // Untested is not the same as passed. With one sample per rung, nothing
    // above the baseline may be judged at all.
    const r = run({ okUpTo: 16, perLevel: MIN_SAMPLES_PER_LEVEL - 1 });
    const res = r.analyze();
    expect(res.confident).toBe(false);
    expect(res.maxConcurrentReads).toBe(0);
  });

  it('is not confident when one prober supplied everything', () => {
    // The collusion case: a node and one friendly peer can manufacture any
    // number they like, so a single-prober result is evidence of nothing.
    const res = run({ okUpTo: 8, probers: ['solo'] }).analyze();
    expect(res.distinctProbers).toBe(1);
    expect(res.confident).toBe(false);
    // The knee is still computed — it is simply not trusted.
    expect(res.maxConcurrentReads).toBe(8);
  });

  it('becomes confident once enough distinct probers agree', () => {
    const probers = Array.from({ length: MIN_DISTINCT_PROBERS }, (_, i) => `p${i}`);
    expect(run({ okUpTo: 8, probers }).analyze().confident).toBe(true);
  });

  it('reports an unsaturated ladder as a LOWER BOUND, never a maximum', () => {
    // The node served everything we asked. We know it is at least this fast and
    // nothing about how much faster — rendering that as its capacity would be
    // the unmeasured-as-fact defect.
    const res = run({ okUpTo: 999, levels: [1, 2, 4] }).analyze();
    expect(res.lowerBoundOnly).toBe(true);
    expect(res.maxConcurrentReads).toBe(4);
    expect(res.reason).toContain('at least');
  });

  it('gives nothing at all when the baseline rung is unusable', () => {
    const r = new CalibrationRun();
    for (let i = 0; i < 5; i++) r.add({ level: 1, size: 'small', ok: false, latencyMs: 0, prober: `p${i}` });
    const res = r.analyze();
    expect(res.maxConcurrentReads).toBe(0);
    expect(res.confident).toBe(false);
  });
});

describe('capacity selection never excludes a node', () => {
  const now = 1_000_000;
  const ttl = 10_000;

  it('prefers a confident fresh measurement over any declaration', () => {
    const measured = run({ okUpTo: 4 }).analyze();
    const e = effectiveCapacity({ measured, measuredAt: now - 1, declared: 64, now, ttlMs: ttl });
    expect(e).toEqual({ capacity: 4, source: 'measured' });
  });

  it('falls back to the declaration when the measurement went stale', () => {
    // A laptop moves from ethernet to a train. A stale measurement is an
    // assumption wearing a measurement's clothes.
    const measured = run({ okUpTo: 4 }).analyze();
    const e = effectiveCapacity({ measured, measuredAt: now - ttl - 1, declared: 8, now, ttlMs: ttl });
    expect(e.source).toBe('declared');
  });

  it('falls back rather than refusing when the measurement is not confident', () => {
    const measured = run({ okUpTo: 8, probers: ['solo'] }).analyze();
    const e = effectiveCapacity({ measured, measuredAt: now, declared: 8, now, ttlMs: ttl });
    expect(e.source).toBe('declared');
  });

  it('gives an uncalibrated, undeclared node the smallest rung, not zero', () => {
    // Principle 1: calibration decides HOW MUCH a node serves, never WHETHER it
    // may participate. A new node has no history and must still be able to join.
    expect(effectiveCapacity({ now, ttlMs: ttl })).toEqual({ capacity: 1, source: 'floor' });
  });

  it('MANDATORY mode credits an uncalibrated node the floor, whatever it declares', () => {
    // "We can make this mandatory" — Lucian. The teeth without the exclusion:
    // a node that has not been measured may still register, hold replicas and
    // count toward durability, but the network will not plan bandwidth against
    // a number nobody verified.
    const e = effectiveCapacity({ declared: 64, now, ttlMs: ttl, requireMeasured: true });
    expect(e).toEqual({ capacity: 1, source: 'floor' });
  });

  it('MANDATORY mode still accepts a confident measurement', () => {
    const measured = run({ okUpTo: 8 }).analyze();
    const e = effectiveCapacity({ measured, measuredAt: now, declared: 64, now, ttlMs: ttl, requireMeasured: true });
    expect(e).toEqual({ capacity: 8, source: 'measured' });
  });

  it('never hands out a generous default to an unknown node', () => {
    const e = effectiveCapacity({ now, ttlMs: ttl, declared: 0 });
    expect(e.capacity).toBe(1);
  });
});

describe('the probe files', () => {
  it('regenerates identically from a seed, so nothing has to be stored', () => {
    const a = calibrationPayload(42, 1024);
    const b = calibrationPayload(42, 1024);
    expect(a).toEqual(b);
    expect(a.length).toBe(1024);
  });

  it('differs per seed, so a cached copy cannot be replayed as a fetch', () => {
    const a = calibrationPayload(1, 512);
    const b = calibrationPayload(2, 512);
    expect(a).not.toEqual(b);
  });

  it('uses two sizes, because they measure different ceilings', () => {
    // Small finds the concurrency ceiling (per-request overhead), large finds
    // the throughput ceiling (bandwidth). A phone on fibre and a server on
    // ADSL fail in opposite ways and one size could not tell them apart.
    expect(CALIBRATION_LARGE_BYTES).toBeGreaterThan(CALIBRATION_SMALL_BYTES * 50);
  });
});

describe('staleness', () => {
  it('treats a never-measured node as stale', () => {
    expect(calibrationStale(0, 1000, 100)).toBe(true);
  });

  it('expires on the TTL', () => {
    expect(calibrationStale(900, 1000, 100)).toBe(false);
    expect(calibrationStale(899, 1000, 100)).toBe(true);
  });
});

describe('a single prober can measure itself by mistake', () => {
  it('flags a knee that sits at the prober own ceiling', () => {
    // The two-node case: one reader hammering one provider. N concurrent
    // fetches cost the READER N connections and N buffers, so if the reader
    // tops out first the "provider capacity" is a self-portrait.
    const res = run({ okUpTo: 8 }).analyze(8);
    expect(res.maxConcurrentReads).toBe(8);
    expect(res.proberBound).toBe(true);
    expect(res.confident).toBe(false);
    expect(res.reason).toContain("prober's own ceiling");
  });

  it('accepts a knee comfortably below the prober ceiling', () => {
    const res = run({ okUpTo: 4 }).analyze(32);
    expect(res.proberBound).toBe(false);
    expect(res.confident).toBe(true);
  });

  it('keeps a prober-bound result as a lower bound rather than discarding it', () => {
    // Still useful: the target served 8 concurrent reads, so it can do at
    // least that. It is only the ceiling that is unknown.
    const res = run({ okUpTo: 8 }).analyze(8);
    expect(res.maxConcurrentReads).toBeGreaterThan(0);
  });
});

describe('sample history is bounded', () => {
  it('caps samples per rung instead of growing forever', () => {
    // The defect: every spot check pushed a sample and nothing removed any, so
    // the array grew for the life of the process. Measured before the cap,
    // 100k samples cost 17.9 ms per analyze() — and analyze() runs per holder
    // per target computation. Unbounded in time is half the invariant.
    const r = new CalibrationRun();
    for (let i = 0; i < 10_000; i++) {
      r.add({ level: 1, size: 'small', ok: true, latencyMs: 100, prober: `p${i % 3}` });
    }
    expect(r.size()).toBeLessThanOrEqual(CalibrationRun.MAX_PER_LEVEL);
  });

  it('keeps the newest samples, because capacity is a property of NOW', () => {
    // A sample from last week is not evidence about this afternoon: a laptop
    // moves from ethernet to a train. Recency is correct on the merits, not
    // only convenient for memory.
    const r = new CalibrationRun();
    for (let i = 0; i < 100; i++) {
      r.add({ level: 1, size: 'small', ok: true, latencyMs: 10, prober: 'old' });
    }
    for (let i = 0; i < CalibrationRun.MAX_PER_LEVEL; i++) {
      r.add({ level: 1, size: 'small', ok: true, latencyMs: 500, prober: 'new' });
    }
    expect(r.analyze().distinctProbers).toBe(1);
  });

  it('bounds each rung separately, so a ladder keeps every rung', () => {
    const r = new CalibrationRun();
    for (const level of [1, 2, 4, 8]) {
      for (let i = 0; i < 100; i++) {
        r.add({ level, size: 'small', ok: true, latencyMs: 100, prober: `p${i % 3}` });
      }
    }
    // Four rungs retained, each capped — not one rung's worth in total.
    expect(r.size()).toBe(4 * CalibrationRun.MAX_PER_LEVEL);
    expect(r.analyze().levelsJudged).toBe(4);
  });

  it('stays fast however long the node runs', () => {
    const r = new CalibrationRun();
    for (let i = 0; i < 50_000; i++) {
      r.add({ level: (i % 4) * 2 || 1, size: 'small', ok: true, latencyMs: 100, prober: `p${i % 3}` });
    }
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) r.analyze();
    expect((performance.now() - t0) / 50).toBeLessThan(2);
  });
});
