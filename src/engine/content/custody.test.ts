import { describe, it, expect } from 'vitest';
import {
  REDUNDANCY_TARGET,
  MIN_REPLICAS,
  MAX_REPLICA_TARGET,
  FAILURES_BEFORE_EVICTION,
  liveHolders,
  replicaTarget,
  planRepair,
  planRejoin,
  pollIntervalMs,
  CustodySignals,
} from './custody.js';
import { MAX_OFFLINE_MS } from './provider-ledger.js';

const HOUR = 60 * 60 * 1000;

describe('liveHolders', () => {
  it('counts only holders under a live lease', () => {
    const live = new Set(['a', 'c']);
    expect(liveHolders(['a', 'b', 'c'], p => live.has(p))).toEqual(['a', 'c']);
  });

  it('is empty when every holder has lapsed — the count that must not read as durable', () => {
    expect(liveHolders(['a', 'b'], () => false)).toEqual([]);
  });
});

describe('replicaTarget', () => {
  it('does not move for ordinary content', () => {
    expect(replicaTarget(0)).toBe(REDUNDANCY_TARGET);
    expect(replicaTarget(100)).toBe(REDUNDANCY_TARGET);
  });

  it('grows logarithmically with demand, never linearly', () => {
    const at200 = replicaTarget(200);
    const at400 = replicaTarget(400);
    const at800 = replicaTarget(800);
    expect(at200).toBeGreaterThan(REDUNDANCY_TARGET);
    // Each doubling of demand buys exactly one more holder.
    expect(at400 - at200).toBe(1);
    expect(at800 - at400).toBe(1);
    // A 1000x demand spike must not buy 1000x the holders.
    expect(replicaTarget(100_000)).toBeLessThan(REDUNDANCY_TARGET + 20);
  });

  it('is capped, so one viral object cannot conscript the fleet', () => {
    expect(replicaTarget(Number.MAX_SAFE_INTEGER)).toBe(MAX_REPLICA_TARGET);
  });

  it('keeps durability below the popularity surplus', () => {
    // The base is the durability guarantee; everything above it is bandwidth.
    expect(replicaTarget(1e9)).toBeGreaterThanOrEqual(REDUNDANCY_TARGET);
    expect(MIN_REPLICAS).toBeLessThan(REDUNDANCY_TARGET);
  });
});

describe('planRepair', () => {
  const allLive = () => true;

  it('places nothing when the target is already met by live holders', () => {
    const holders = Array.from({ length: REDUNDANCY_TARGET }, (_, i) => `h${i}`);
    const plan = planRepair({ holders, isLive: allLive, candidates: ['x', 'y'] });
    expect(plan.add).toEqual([]);
    expect(plan.drop).toEqual([]);
    expect(plan.live).toBe(REDUNDANCY_TARGET);
    expect(plan.shortfall).toBe(0);
  });

  it('does NOT count lapsed holders toward the target', () => {
    // Ten holders, but only two still hold a lease. A count that included the
    // other eight would report the object as fully replicated while one honest
    // failure would take it to one copy.
    const holders = Array.from({ length: REDUNDANCY_TARGET }, (_, i) => `h${i}`);
    const live = new Set(['h0', 'h1']);
    const candidates = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const plan = planRepair({ holders, isLive: p => live.has(p), candidates });
    expect(plan.live).toBe(2);
    expect(plan.add).toHaveLength(REDUNDANCY_TARGET - 2);
    expect(plan.drop).toHaveLength(REDUNDANCY_TARGET - 2);
    expect(plan.shortfall).toBe(0);
  });

  it('drops lapsed holders rather than leaving the set to grow with churn', () => {
    const live = new Set(['fresh']);
    const plan = planRepair({
      holders: ['gone1', 'gone2', 'fresh'],
      isLive: p => live.has(p),
      candidates: [],
    });
    expect(plan.drop.sort()).toEqual(['gone1', 'gone2']);
  });

  it('never re-places a CID on a provider that already holds it', () => {
    const plan = planRepair({
      holders: ['a', 'b'],
      isLive: allLive,
      candidates: ['b', 'c', 'a', 'd'],
    });
    expect(plan.add).not.toContain('a');
    expect(plan.add).not.toContain('b');
    expect(plan.add.slice(0, 2)).toEqual(['c', 'd']);
  });

  it('reports the shortfall when the fleet cannot restore the target', () => {
    const plan = planRepair({ holders: [], isLive: allLive, candidates: ['a', 'b'] });
    expect(plan.add).toEqual(['a', 'b']);
    expect(plan.shortfall).toBe(REDUNDANCY_TARGET - 2);
  });

  it('honours a raised target from popularity', () => {
    const holders = Array.from({ length: REDUNDANCY_TARGET }, (_, i) => `h${i}`);
    const candidates = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const plan = planRepair({ holders, isLive: allLive, candidates, target: REDUNDANCY_TARGET + 3 });
    expect(plan.add).toHaveLength(3);
  });
});

describe('planRejoin', () => {
  const held = ['cidA', 'cidB', 'cidC'];

  it('discards everything foreign once the lease has lapsed', () => {
    const plan = planRejoin({ offlineMs: MAX_OFFLINE_MS, held });
    expect(plan.lapsed).toBe(true);
    expect(plan.keep).toEqual([]);
    expect(plan.discard).toEqual(held);
  });

  it('discards after a long absence even when nothing was released', () => {
    const plan = planRejoin({ offlineMs: 30 * 24 * HOUR, held, released: new Set() });
    expect(plan.discard).toHaveLength(3);
  });

  it('keeps everything for a restart inside the lease — a reboot costs no re-transfer', () => {
    const plan = planRejoin({ offlineMs: MAX_OFFLINE_MS - 1, held });
    expect(plan.lapsed).toBe(false);
    expect(plan.keep).toEqual(held);
    expect(plan.discard).toEqual([]);
  });

  it('drops only what an owner released, inside the lease', () => {
    const plan = planRejoin({ offlineMs: HOUR, held, released: new Set(['cidB']) });
    expect(plan.keep).toEqual(['cidA', 'cidC']);
    expect(plan.discard).toEqual(['cidB']);
  });

  it('is safe with nothing held', () => {
    const plan = planRejoin({ offlineMs: 10 * 24 * HOUR, held: [] });
    expect(plan.discard).toEqual([]);
    expect(plan.keep).toEqual([]);
    expect(plan.lapsed).toBe(true);
  });

  it('draws the line exactly at MAX_OFFLINE_MS, not near it', () => {
    expect(planRejoin({ offlineMs: MAX_OFFLINE_MS - 1, held }).lapsed).toBe(false);
    expect(planRejoin({ offlineMs: MAX_OFFLINE_MS, held }).lapsed).toBe(true);
  });
});

describe('pollIntervalMs', () => {
  const noJitter = { jitterFrac: 0, rand: () => 0.5 };

  it('leaves a small network at the base cadence', () => {
    expect(pollIntervalMs(600_000, 1, { ...noJitter, refPopulation: 100 })).toBe(600_000);
    expect(pollIntervalMs(600_000, 100, { ...noJitter, refPopulation: 100 })).toBe(600_000);
  });

  it('stretches sub-linearly as population grows', () => {
    const base = 600_000;
    const at10k = pollIntervalMs(base, 10_000, { ...noJitter, refPopulation: 100, maxMs: Infinity });
    // 100x the population is 10x the interval (√), not 100x.
    expect(at10k).toBe(base * 10);
    // Aggregate load on the answering tier therefore grows as √P, not P.
    const loadRatio = (10_000 / at10k) / (100 / base);
    expect(loadRatio).toBeCloseTo(10, 5);
  });

  it('clamps at maxMs so freshness has a floor however large the network gets', () => {
    const max = 2 * HOUR;
    expect(pollIntervalMs(600_000, 1e12, { ...noJitter, refPopulation: 100, maxMs: max })).toBe(max);
  });

  it('spreads callers across the window instead of synchronising them', () => {
    // Every client computes the same interval from the same population estimate;
    // without jitter they all fire in the same instant and the average is a lie.
    const spread = [0, 0.25, 0.5, 0.75, 1].map(r =>
      pollIntervalMs(600_000, 100, { refPopulation: 100, jitterFrac: 0.2, rand: () => r }));
    expect(new Set(spread).size).toBe(5);
    expect(Math.min(...spread)).toBeCloseTo(600_000 * 0.8, -1);
    expect(Math.max(...spread)).toBeCloseTo(600_000 * 1.2, -1);
  });

  it('never returns a non-positive interval', () => {
    expect(pollIntervalMs(1, 1, { jitterFrac: 1, rand: () => 0 })).toBeGreaterThan(0);
  });
});

describe('CustodySignals', () => {
  it('raises the target as a CID is read', () => {
    const s = new CustodySignals();
    expect(s.targetFor('cid')).toBe(REDUNDANCY_TARGET);
    for (let i = 0; i < 400; i++) s.recordRead('cid');
    expect(s.reads('cid')).toBe(400);
    expect(s.targetFor('cid')).toBeGreaterThan(REDUNDANCY_TARGET);
  });

  it('does not evict on a single failure — one flaky dial is not evidence of loss', () => {
    const s = new CustodySignals();
    s.recordFailure('cid', 'p');
    expect(s.shouldEvict('cid', 'p')).toBe(false);
  });

  it('evicts after consecutive failures', () => {
    const s = new CustodySignals();
    for (let i = 0; i < FAILURES_BEFORE_EVICTION; i++) s.recordFailure('cid', 'p');
    expect(s.shouldEvict('cid', 'p')).toBe(true);
  });

  it('a success clears the streak — the counter is consecutive, not cumulative', () => {
    const s = new CustodySignals();
    s.recordFailure('cid', 'p');
    s.recordSuccess('cid', 'p');
    s.recordFailure('cid', 'p');
    expect(s.shouldEvict('cid', 'p')).toBe(false);
  });

  it('tracks failures per (cid, provider), not per provider', () => {
    const s = new CustodySignals();
    s.recordFailure('cid1', 'p');
    s.recordFailure('cid2', 'p');
    // One failure each: a provider that lost one object still holds the other.
    expect(s.shouldEvict('cid1', 'p')).toBe(false);
    expect(s.shouldEvict('cid2', 'p')).toBe(false);
  });

  it('forgets a CID without touching its neighbours', () => {
    const s = new CustodySignals();
    s.recordRead('cid1');
    s.recordFailure('cid1', 'p');
    s.recordRead('cid2');
    s.recordFailure('cid2', 'p');
    s.forget('cid1');
    expect(s.reads('cid1')).toBe(0);
    expect(s.recordFailure('cid1', 'p')).toBe(1);
    expect(s.reads('cid2')).toBe(1);
    expect(s.recordFailure('cid2', 'p')).toBe(2);
  });

  it('forget matches on the whole CID, not a prefix of it', () => {
    const s = new CustodySignals();
    s.recordFailure('cid', 'p');
    s.recordFailure('cidLONGER', 'p');
    s.forget('cid');
    expect(s.recordFailure('cidLONGER', 'p')).toBe(2);
  });
});
