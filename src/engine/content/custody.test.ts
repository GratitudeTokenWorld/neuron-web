import { describe, it, expect } from 'vitest';
import {
  REDUNDANCY_TARGET,
  MIN_REPLICAS,
  MAX_REPLICA_TARGET,
  POPULARITY_FLOOR,
  RELEASE_HYSTERESIS,
  demandWindowMs,
  DEMAND_BUCKETS,
  FAILURES_BEFORE_EVICTION,
  liveHolders,
  replicaTarget,
  planRepair,
  planRejoin,
  planEviction,
  mayReleasePublisherCopy,
  pollIntervalMs,
  CustodySignals,
} from './custody.js';
import { MAX_OFFLINE_MS, applyStorageTiming } from './provider-ledger.js';

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
  it('does not move for content nobody is reading', () => {
    expect(replicaTarget(0)).toBe(REDUNDANCY_TARGET);
    // Below one full step, the surplus is zero.
    expect(replicaTarget(POPULARITY_FLOOR - 1)).toBe(REDUNDANCY_TARGET);
  });

  it('guarantees the durability floor however unpopular the file', () => {
    // "Minimum copies is 10 for any file" — Lucian, 2026-09-22. There is no
    // read rate, including zero, at which this drops.
    for (const rate of [0, 1, 5, POPULARITY_FLOOR, 1e6]) {
      expect(replicaTarget(rate)).toBeGreaterThanOrEqual(REDUNDANCY_TARGET);
    }
  });

  it('grows linearly with demand — one copy per POPULARITY_FLOOR reads', () => {
    // Switched from log2 on 2026-09-22 (Lucian). The measurement in
    // sim/demand-replication.ts showed the cap does the work, not the curve,
    // and that linear reaches the cap far sooner — which is the whole point of
    // demand-scaling, since a copy that arrives after the spike is useless.
    expect(replicaTarget(POPULARITY_FLOOR)).toBe(REDUNDANCY_TARGET + 1);
    expect(replicaTarget(POPULARITY_FLOOR * 5)).toBe(REDUNDANCY_TARGET + 5);
    // Each further step buys exactly one more holder, until the cap.
    const a = replicaTarget(POPULARITY_FLOOR * 3);
    const b = replicaTarget(POPULARITY_FLOOR * 4);
    expect(b - a).toBe(1);
  });

  it('reaches the cap while the spike is still happening', () => {
    // The property the log curve did not have: under log2 the cap needed ~5
    // million reads per window, so hot content got its copies long after
    // anyone wanted them.
    expect(replicaTarget(POPULARITY_FLOOR * 20)).toBe(MAX_REPLICA_TARGET);
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

  it('KEEPS everything foreign when the lease has lapsed — reversed 2026-09-21', () => {
    // This asserted the opposite until Lucian reversed it. Discarding on lapse
    // is tidiness beating durability: those bytes are redundancy the network
    // already paid bandwidth to create, and deleting them turns a returning
    // node from free resilience into a node that must be re-fed. Over-
    // replication is cheap; under-replication is the risk.
    const plan = planRejoin({ offlineMs: MAX_OFFLINE_MS, held });
    expect(plan.lapsed).toBe(true);
    expect(plan.keep).toEqual(held);
    expect(plan.discard).toEqual([]);
    expect(plan.reason).toMatch(/uncounted spare redundancy/);
  });

  it('keeps them however long the absence was', () => {
    const plan = planRejoin({ offlineMs: 30 * 24 * HOUR, held, released: new Set() });
    expect(plan.keep).toHaveLength(3);
    expect(plan.discard).toHaveLength(0);
  });

  it('still drops what the OWNER released, lapsed or not', () => {
    // The one thing a lapse does not excuse: content its owner withdrew is
    // wanted by nobody, so keeping it is pure waste rather than spare
    // redundancy.
    const plan = planRejoin({ offlineMs: MAX_OFFLINE_MS, held, released: new Set(['cidB']) });
    expect(plan.discard).toEqual(['cidB']);
    expect(plan.keep).toEqual(['cidA', 'cidC']);
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

  it('states the lapse in a unit that survives a compressed profile', () => {
    // The reason line hardcoded hours while MAX_OFFLINE_MS scales with the
    // timing profile, so under `fast` (6-minute lease) the only message
    // explaining why a node just erased its disk read `lapsed 0h ago (max 0h)`.
    // Same family as `LAST REWARD -59066340h ago`: a fixed unit against a moved
    // clock. This is asserted under `fast` because that is the profile T9 step 5
    // runs in — the normal profile could never have shown the bug.
    try {
      applyStorageTiming('fast');
      const reason = planRejoin({ offlineMs: MAX_OFFLINE_MS + 60_000, held }).reason;
      expect(reason).not.toMatch(/0h/);
      expect(reason).toMatch(/lapsed \d+min ago \(max \d+min\)/);
    } finally {
      // A profile is global mutable state and a CONSENSUS input; leaking `fast`
      // into a later test would re-number every epoch it asserts on.
      applyStorageTiming('normal');
    }
  });

  it('still reads in hours at production timing', () => {
    const reason = planRejoin({ offlineMs: MAX_OFFLINE_MS, held }).reason;
    expect(reason).toMatch(/lapsed 12h ago \(max 12h\)/);
  });
});

describe('planEviction', () => {
  const MB = 1_000_000;

  it('does nothing while inside declared capacity', () => {
    // Cleanup is driven by SPACE PRESSURE, never by a clock. This is the whole
    // point of the rejoin reversal: bytes are kept until they actually cost
    // something.
    const plan = planEviction({
      usedBytes: 500 * MB,
      capacityBytes: 1_000 * MB,
      held: [{ cid: 'a', bytes: 500 * MB, leased: true }],
    });
    expect(plan.evict).toEqual([]);
    expect(plan.reason).toMatch(/within declared capacity/);
  });

  it('sacrifices owner-released bytes first, then uncounted spares, then leased', () => {
    const plan = planEviction({
      usedBytes: 400 * MB,
      capacityBytes: 100 * MB,
      held: [
        { cid: 'leased', bytes: 100 * MB, leased: true },
        { cid: 'spare', bytes: 100 * MB, leased: false },
        { cid: 'released', bytes: 100 * MB, leased: true, releasedByOwner: true },
        { cid: 'spare2', bytes: 100 * MB, leased: false },
      ],
    });
    // Nobody wants the released one; losing a spare costs the network nothing
    // it is counting on; the leased copy is the last resort because dropping it
    // genuinely lowers redundancy.
    expect(plan.evict[0]).toBe('released');
    expect(plan.evict.slice(1, 3).sort()).toEqual(['spare', 'spare2']);
    expect(plan.evict).not.toContain('leased');
  });

  it('stops as soon as it is back under capacity, never evicting more', () => {
    const plan = planEviction({
      usedBytes: 250 * MB,
      capacityBytes: 200 * MB,
      held: [
        { cid: 'a', bytes: 50 * MB, leased: false },
        { cid: 'b', bytes: 50 * MB, leased: false },
        { cid: 'c', bytes: 50 * MB, leased: false },
      ],
    });
    expect(plan.evict).toHaveLength(1);
    expect(plan.freedBytes).toBe(50 * MB);
  });

  it('breaks ties by least recently touched', () => {
    const plan = planEviction({
      usedBytes: 200 * MB,
      capacityBytes: 100 * MB,
      held: [
        { cid: 'fresh', bytes: 100 * MB, leased: false, lastTouched: 9_000 },
        { cid: 'stale', bytes: 100 * MB, leased: false, lastTouched: 1_000 },
      ],
    });
    expect(plan.evict[0]).toBe('stale');
  });
});

describe('mayReleasePublisherCopy', () => {
  it('holds the copy until the network has taken custody', () => {
    // Below MIN_REPLICAS the publisher's copy is the only one in existence.
    for (let live = 0; live < MIN_REPLICAS; live++) {
      expect(mayReleasePublisherCopy(live), `live=${live}`).toBe(false);
    }
  });

  it('releases at MIN_REPLICAS, not at the redundancy target', () => {
    // Waiting for REDUNDANCY_TARGET would pin every publisher's disk to a fleet
    // that may not be that large yet; getting from the minimum to the target is
    // repair's job, and repair pulls from the holders, not from the author.
    expect(mayReleasePublisherCopy(MIN_REPLICAS)).toBe(true);
    expect(MIN_REPLICAS).toBeLessThan(REDUNDANCY_TARGET);
  });

  it('never releases on one holder — one copy plus a lease expiry is zero', () => {
    expect(mayReleasePublisherCopy(1)).toBe(false);
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

  it('measures a RATE, so the target comes back down when reading stops', () => {
    // The defect this replaced: `reads` was a lifetime counter, so a CID that
    // went viral once held conscripted capacity forever and the target could
    // only ever rise. Demand has to be able to fall or "drop copies when reads
    // decrease" is unimplementable.
    const s = new CustodySignals();
    const t0 = 1_000_000_000;
    for (let i = 0; i < 400; i++) s.recordRead('cid', t0);
    const hot = s.targetFor('cid', t0);
    expect(hot).toBeGreaterThan(REDUNDANCY_TARGET);

    // Half a window later the early reads are still inside it.
    expect(s.reads('cid', t0 + demandWindowMs() / 2)).toBe(400);
    // A full window of silence and demand is gone — back to the durability floor.
    const cold = t0 + demandWindowMs() + 1;
    expect(s.reads('cid', cold)).toBe(0);
    expect(s.targetFor('cid', cold)).toBe(REDUNDANCY_TARGET);
  });

  it('decays gradually rather than all at once', () => {
    // A cliff would release every surplus holder in one tick. Buckets age out
    // one at a time, so the target walks down instead of falling off.
    const s = new CustodySignals();
    const t0 = 1_000_000_000;
    const bucket = demandWindowMs() / DEMAND_BUCKETS;
    for (let b = 0; b < DEMAND_BUCKETS; b++) {
      for (let i = 0; i < 100; i++) s.recordRead('cid', t0 + b * bucket);
    }
    const full = s.reads('cid', t0 + (DEMAND_BUCKETS - 1) * bucket);
    expect(full).toBe(600);
    // Each further bucket of silence drops exactly one bucket's worth.
    const after1 = s.reads('cid', t0 + DEMAND_BUCKETS * bucket);
    expect(after1).toBe(500);
    const after2 = s.reads('cid', t0 + (DEMAND_BUCKETS + 1) * bucket);
    expect(after2).toBe(400);
  });

  it('sweeps CIDs whose demand reached zero — the map has a remover', () => {
    const s = new CustodySignals();
    const t0 = 1_000_000_000;
    s.recordRead('cold', t0);
    s.recordRead('hot', t0);
    const later = t0 + demandWindowMs() + 1;
    s.recordRead('hot', later);
    expect(s.sweepDemand(later)).toBe(1);
    expect(s.reads('hot', later)).toBe(1);
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

describe('a new copy means a new NODE (2026-09-22)', () => {
  // Lucian: "making another copy means a new node, not the same node" — and
  // "two accounts on one machine must not count as separate replicas".
  // A distinct public key does not establish an independent machine: with
  // multi-device custody one account holds several keys, and two accounts can
  // run on one box. Ten copies in one failure domain is one copy with ten
  // names, and it fails exactly when redundancy is supposed to save you.
  const alive = () => true;
  // Four keys, two machines.
  const domain: Record<string, string> = { a1: 'boxA', a2: 'boxA', b1: 'boxB', b2: 'boxB' };
  const domainOf = (p: string) => domain[p] ?? p;

  it('never places a second copy in a domain it already holds', () => {
    const plan = planRepair({
      holders: ['a1'],
      isLive: alive,
      candidates: ['a2', 'b1', 'b2'],
      target: 3,
      domainOf,
    });
    // a2 shares boxA with the existing holder; b2 shares boxB with b1.
    expect(plan.add).toEqual(['b1']);
    // And it says so: two of the three slots cannot be filled by these
    // candidates, rather than being filled with fiction.
    expect(plan.shortfall).toBe(1);
  });

  it('counts existing holders by machine, so redundancy is not double-counted', () => {
    const plan = planRepair({
      holders: ['a1', 'a2', 'b1'],
      isLive: alive,
      candidates: [],
      target: 3,
      domainOf,
    });
    // Three keys, two machines: live is 2, not 3.
    expect(plan.live).toBe(2);
    expect(plan.shortfall).toBe(1);
  });

  it('without domainOf it degrades to per-key, which is the old behaviour', () => {
    const plan = planRepair({ holders: ['a1', 'a2'], isLive: alive, candidates: [], target: 3 });
    expect(plan.live).toBe(2);
  });
});

describe('planRepair releases surplus when demand falls', () => {
  const alive = () => true;
  const many = Array.from({ length: 20 }, (_, i) => `p${i}`);

  it('sheds holders above the target, newest first', () => {
    const plan = planRepair({ holders: many, isLive: alive, candidates: [], target: 15 });
    // 20 live, target 15, hysteresis 1 → release 4, taken from the tail.
    expect(plan.release).toHaveLength(20 - 15 - RELEASE_HYSTERESIS);
    expect(plan.release).toEqual(['p16', 'p17', 'p18', 'p19']);
  });

  it('never releases below the durability floor', () => {
    // Even at zero demand the target is REDUNDANCY_TARGET, and release must
    // respect it: shedding bandwidth copies must never touch durability.
    const plan = planRepair({
      holders: many,
      isLive: alive,
      candidates: [],
      target: replicaTarget(0),
    });
    expect(many.length - plan.release.length).toBeGreaterThanOrEqual(REDUNDANCY_TARGET);
  });

  it('does nothing inside the hysteresis band, so the target may oscillate', () => {
    // log2 growth crosses a bucket boundary constantly; releasing and
    // re-placing on each crossing would spend bandwidth to hold the same count.
    const atTarget = planRepair({ holders: many.slice(0, 10), isLive: alive, candidates: [], target: 10 });
    expect(atTarget.release).toEqual([]);
    const oneOver = planRepair({ holders: many.slice(0, 11), isLive: alive, candidates: [], target: 10 });
    expect(oneOver.release).toEqual([]);
    const twoOver = planRepair({ holders: many.slice(0, 12), isLive: alive, candidates: [], target: 10 });
    expect(twoOver.release).toHaveLength(1);
  });

  it('repairs and releases are mutually exclusive for one CID', () => {
    const under = planRepair({ holders: ['p0'], isLive: alive, candidates: ['p1', 'p2'], target: 10 });
    expect(under.release).toEqual([]);
    expect(under.add.length).toBeGreaterThan(0);
  });
});

describe('concurrentReads — derived, and honest about not knowing', () => {
  const t0 = 2_000_000_000;

  it('is zero without a service-time sample, meaning NO EVIDENCE not no demand', () => {
    // The distinction the caller must respect: a CID being read hard with no
    // latency recorded yet is unmeasured, and falling back to the read-rate
    // curve is the correct response to that, not planning for zero load.
    const s = new CustodySignals();
    for (let i = 0; i < 50; i++) s.recordRead('cid', t0);
    expect(s.reads('cid', t0)).toBe(50);
    expect(s.concurrentReads('cid', t0)).toBe(0);
  });

  it("applies Little's Law: concurrency = rate x service time", () => {
    const s = new CustodySignals();
    const window = demandWindowMs();
    // 100 reads in the window, each taking 1% of the window to serve.
    for (let i = 0; i < 100; i++) s.recordRead('cid', t0, window * 0.01);
    // L = (100 / window) x (0.01 x window) = 1.0
    expect(s.concurrentReads('cid', t0)).toBeCloseTo(1, 5);
  });

  it('rises with slower service at the same rate — a slow holder IS more loaded', () => {
    const window = demandWindowMs();
    const fast = new CustodySignals();
    const slow = new CustodySignals();
    for (let i = 0; i < 100; i++) {
      fast.recordRead('cid', t0, window * 0.01);
      slow.recordRead('cid', t0, window * 0.04);
    }
    expect(slow.concurrentReads('cid', t0)).toBeGreaterThan(fast.concurrentReads('cid', t0) * 3);
  });

  it('cannot get stuck — both inputs decay, unlike an in-flight gauge', () => {
    // An in-flight counter that misses a decrement reports phantom load
    // forever and quietly conscripts replicas. This estimate falls to zero on
    // its own when reading stops.
    const s = new CustodySignals();
    for (let i = 0; i < 100; i++) s.recordRead('cid', t0, 50);
    expect(s.concurrentReads('cid', t0)).toBeGreaterThan(0);
    expect(s.concurrentReads('cid', t0 + demandWindowMs() + 1)).toBe(0);
  });
});
