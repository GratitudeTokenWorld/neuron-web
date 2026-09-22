import { describe, it, expect } from 'vitest';
import {
  planBySaturation, calibratedCapacity, suggestDeviceClass,
  DEFAULT_CONCURRENCY, HIGH_WATER, LOW_WATER,
} from './device-capacity.js';
import { REDUNDANCY_TARGET, MAX_REPLICA_TARGET } from './custody.js';

/**
 * Hypothesis H-S1: replicating on measured saturation keeps readers served
 * without over-provisioning, and the loop settles instead of oscillating.
 *
 * Disproved by: a fleet that keeps adding and releasing the same holder, a
 * release that causes saturation, or a heterogeneous fleet being mismanaged
 * because the policy assumed uniform nodes.
 */

const FLOOR = REDUNDANCY_TARGET;
const CAP = MAX_REPLICA_TARGET;
/** Ten laptops — the ordinary case. */
const TEN_LAPTOPS = new Array(10).fill(DEFAULT_CONCURRENCY.laptop);

describe('H-S1: the loop tracks demand', () => {
  it('holds at the floor when nothing is happening', () => {
    const p = planBySaturation({ holderCapacities: TEN_LAPTOPS, demandConcurrent: 0, floor: FLOOR, cap: CAP });
    expect(p.target).toBe(FLOOR);
    expect(p.ratio).toBe(0);
  });

  it('places more holders once demand passes the high-water mark', () => {
    const capacity = TEN_LAPTOPS.reduce((a, b) => a + b, 0); // 80
    const p = planBySaturation({
      holderCapacities: TEN_LAPTOPS,
      demandConcurrent: Math.ceil(capacity * 0.9),
      floor: FLOOR, cap: CAP,
    });
    expect(p.ratio).toBeGreaterThan(HIGH_WATER);
    expect(p.target).toBeGreaterThan(10);
  });

  it('closes the whole gap rather than adding one at a time', () => {
    // Adding one holder per cycle costs a replication delay per increment,
    // so a spike would be served late by however many copies it needed.
    const p = planBySaturation({
      holderCapacities: TEN_LAPTOPS,
      demandConcurrent: 400, // 5x the fleet's 80
      floor: FLOOR, cap: CAP,
    });
    expect(p.target).toBeGreaterThan(20);
  });

  it('never exceeds the cap, because demand is a number an attacker writes', () => {
    const p = planBySaturation({
      holderCapacities: TEN_LAPTOPS,
      demandConcurrent: 10_000_000,
      floor: FLOOR, cap: CAP,
    });
    expect(p.target).toBe(CAP);
  });

  it('never drops below the durability floor however quiet it gets', () => {
    const p = planBySaturation({
      holderCapacities: new Array(20).fill(DEFAULT_CONCURRENCY.server),
      demandConcurrent: 0,
      floor: FLOOR, cap: CAP,
    });
    expect(p.target).toBe(FLOOR);
  });
});

describe('the loop settles — it does not oscillate', () => {
  it('leaves the steady band alone', () => {
    const capacity = 80;
    for (const ratio of [LOW_WATER + 0.01, 0.5, HIGH_WATER - 0.01]) {
      const p = planBySaturation({
        holderCapacities: TEN_LAPTOPS,
        demandConcurrent: capacity * ratio,
        floor: FLOOR, cap: CAP,
      });
      expect(p.target).toBe(10);
      expect(p.reason).toContain('steady');
    }
  });

  it('never releases a holder if doing so would cause saturation', () => {
    // The trap a narrow band would fall into: releasing RAISES the ratio, so
    // release-then-resaturate-then-replace runs forever and pays a transfer
    // every cycle to hold the same number of copies.
    const holders = new Array(14).fill(DEFAULT_CONCURRENCY.laptop); // capacity 112
    const demand = 30; // ratio 0.27 — below LOW_WATER, so shedding is considered
    const p = planBySaturation({ holderCapacities: holders, demandConcurrent: demand, floor: FLOOR, cap: CAP });
    expect(p.target).toBeLessThan(14);
    // Whatever it releases, the resulting ratio must stay under HIGH_WATER.
    const remaining = p.target * DEFAULT_CONCURRENCY.laptop;
    expect(demand / remaining).toBeLessThan(HIGH_WATER);
  });

  it('converges from a spike and stays converged', () => {
    // Drive the loop: spike, let it settle, drop demand, let it settle. If the
    // policy oscillates this never reaches a fixed point.
    let holders = [...TEN_LAPTOPS];
    const step = (demand: number) => {
      const p = planBySaturation({ holderCapacities: holders, demandConcurrent: demand, floor: FLOOR, cap: CAP });
      holders = new Array(p.target).fill(DEFAULT_CONCURRENCY.laptop);
      return p;
    };
    for (let i = 0; i < 10; i++) step(150);
    const hot = holders.length;
    expect(hot).toBeGreaterThan(10);
    // Two consecutive identical decisions = a fixed point.
    expect(step(150).target).toBe(hot);
    expect(step(150).target).toBe(hot);

    for (let i = 0; i < 20; i++) step(0);
    expect(holders.length).toBe(FLOOR);
    expect(step(0).target).toBe(FLOOR);
  });
});

describe('a heterogeneous fleet is the point, not an edge case', () => {
  it('counts capacity, not holders — ten phones are not ten servers', () => {
    const phones = new Array(10).fill(DEFAULT_CONCURRENCY.phone);   // 30
    const servers = new Array(10).fill(DEFAULT_CONCURRENCY.server); // 640
    const demand = 100;
    const pPhones = planBySaturation({ holderCapacities: phones, demandConcurrent: demand, floor: FLOOR, cap: CAP });
    const pServers = planBySaturation({ holderCapacities: servers, demandConcurrent: demand, floor: FLOOR, cap: CAP });
    // Same replica count, same demand, opposite decisions — which a policy
    // based on a read count could not express at all.
    expect(pPhones.target).toBeGreaterThan(10);
    expect(pServers.target).toBe(FLOOR);
  });

  it('sheds the smallest holders first', () => {
    // Releasing a server to keep a phone would cut capacity hardest for the
    // same reduction in replica count.
    const mixed = [...new Array(8).fill(DEFAULT_CONCURRENCY.server), ...new Array(6).fill(DEFAULT_CONCURRENCY.phone)];
    const p = planBySaturation({ holderCapacities: mixed, demandConcurrent: 5, floor: FLOOR, cap: CAP });
    expect(p.target).toBe(FLOOR);
    // 4 shed out of 14, and capacity barely moves because they were phones.
    expect(mixed.length - p.target).toBe(4);
  });
});

describe('capacity is declared, then corrected by behaviour', () => {
  it('lowers a declaration that failed at a level below it', () => {
    // Over-declaring is self-punishing: the node fell over at 5, so its
    // capacity is not the 64 it claimed.
    expect(calibratedCapacity({ declared: 64, peakServedConcurrent: 5, failuresAtPeak: 2 })).toBe(4);
  });

  it('never raises a declaration above what was demonstrated', () => {
    expect(calibratedCapacity({ declared: 64, peakServedConcurrent: 10, failuresAtPeak: 0 })).toBe(10);
  });

  it('accepts a reader-observed failure level over the node own claim', () => {
    // The direction that matters: a holder may say it is worse than it looks,
    // never better than readers found it to be.
    expect(calibratedCapacity({
      declared: 64, peakServedConcurrent: 60, failuresAtPeak: 0, observedFailureConcurrency: 12,
    })).toBe(11);
  });

  it('never returns a capacity below 1 — a holder can always serve something', () => {
    expect(calibratedCapacity({ declared: 1, peakServedConcurrent: 1, failuresAtPeak: 5 })).toBe(1);
  });
});

describe('device class suggestion is a convenience, not evidence', () => {
  it('reads the obvious cases', () => {
    expect(suggestDeviceClass({ mobile: true, cores: 4, memoryGB: 4 })).toBe('phone');
    expect(suggestDeviceClass({ cores: 32, memoryGB: 64, downlinkMbps: 1000 })).toBe('server');
    expect(suggestDeviceClass({ cores: 4, memoryGB: 2 })).toBe('sbc');
  });

  it('orders the ladder so a smaller device never claims more', () => {
    const order = ['sbc', 'phone', 'tablet', 'laptop', 'desktop', 'server'] as const;
    for (let i = 1; i < order.length; i++) {
      expect(DEFAULT_CONCURRENCY[order[i]!]).toBeGreaterThan(DEFAULT_CONCURRENCY[order[i - 1]!]);
    }
  });
});
