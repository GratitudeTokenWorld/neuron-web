import { describe, it, expect } from 'vitest';
import {
  zipfRates, policyCost, requiredCacheHitRate,
  fixedPolicy, logPolicy, linearPolicy, linearCappedPolicy,
  DEFAULT_WORKLOAD, READS_PER_COPY, REDUNDANCY_TARGET, MAX_REPLICA_TARGET,
} from './demand-replication.js';

/**
 * Hypothesis H-R1: sub-linear (log) growth is necessary, because Lucian's
 * "one more copy per 10 reads an hour" rule would conscript the fleet.
 *
 * Disproved by: linear costing the network about the same as log once the cap
 * is applied — in which case the curve is not the thing that matters and
 * picking the simpler rule is free.
 *
 * ASSUMED inputs, and the conclusions inherit every one of them: a Zipf
 * exponent of 1, 100k objects, 10M reads per window, and a holder that can
 * serve 4,500 reads per window (a 1 MB object on a ~10 Mbit uplink). Nothing
 * here is measured from a real workload, because we have none.
 */

const rates = zipfRates(DEFAULT_WORKLOAD);
const HOTTEST = rates[0]!;
/** ASSUMED — the single most load-bearing number in this file. */
const HOLDER_CAPACITY = 4_500;

describe('H-R1: does the growth curve actually matter?', () => {
  it('finds the hottest object carries a huge share — Zipf, not uniform', () => {
    // If this were uniform every policy would look affordable and the whole
    // comparison would be meaningless.
    expect(HOTTEST).toBeGreaterThan(800_000);
    expect(rates[Math.floor(rates.length / 2)]!).toBeLessThan(20);
  });

  it('DISPROVES the fear about fleet cost: uncapped linear is ~2x, not 100x', () => {
    const fixed = policyCost(rates, fixedPolicy, 'fixed', { cacheHitRate: 0 });
    const linear = policyCost(rates, linearPolicy, 'linear', { cacheHitRate: 0 });
    // The Zipf tail is enormous and nearly all of it sits at the floor, so the
    // aggregate barely moves. "Linear would consume the fleet" is wrong about
    // total storage.
    expect(linear.multipleOfFloor).toBeLessThan(2.5);
    expect(fixed.multipleOfFloor).toBe(1);
  });

  it('…but locates the real problem: ONE object demanding 80,000 copies', () => {
    const linear = policyCost(rates, linearPolicy, 'linear', { cacheHitRate: 0 });
    // Uncapped linear asks for more copies of a single viral object than most
    // networks have providers. That is the failure — concentration, not
    // aggregate cost — and it is also the attack: demand is self-reported, so
    // reading your own file conscripts capacity from everyone.
    expect(linear.copiesForHottest).toBeGreaterThan(80_000);
    expect(linearCappedPolicy(HOTTEST)).toBe(MAX_REPLICA_TARGET);
  });

  it('shows the CAP does the work, not the curve', () => {
    // The headline. Once both are capped, log and linear need almost the same
    // help from caches: 85.3% vs 83.7%. The curve is nearly irrelevant.
    const needLog = requiredCacheHitRate({ hottestRate: HOTTEST, policy: logPolicy, holderCapacityPerWindow: HOLDER_CAPACITY });
    const needLinear = requiredCacheHitRate({ hottestRate: HOTTEST, policy: linearCappedPolicy, holderCapacityPerWindow: HOLDER_CAPACITY });
    expect(needLog).toBeGreaterThan(0.84);
    expect(needLog).toBeLessThan(0.87);
    expect(Math.abs(needLog - needLinear)).toBeLessThan(0.03);

    // And the fleet cost difference is small too — ~11%.
    const log = policyCost(rates, logPolicy, 'log', { cacheHitRate: 0 });
    const linear = policyCost(rates, linearCappedPolicy, 'linearCapped', { cacheHitRate: 0 });
    expect(linear.multipleOfFloor / log.multipleOfFloor).toBeLessThan(1.2);
  });

  it('reaches the cap far sooner under the linear rule, which is the real difference', () => {
    // Linear hits 30 copies at 200 reads/window; log needs ~5 million. So
    // linear gives hot content its copies FASTER, which is what demand-scaling
    // is for, and the cap is what keeps it safe.
    expect(linearCappedPolicy(200)).toBe(MAX_REPLICA_TARGET);
    expect(logPolicy(200)).toBeLessThan(MAX_REPLICA_TARGET);
    expect(logPolicy(200)).toBe(REDUNDANCY_TARGET + Math.floor(Math.log2(200 / 10)) + 1);
  });

  it('leaves the durability floor untouched by either policy', () => {
    for (const p of [fixedPolicy, logPolicy, linearPolicy, linearCappedPolicy]) {
      expect(p(0)).toBe(REDUNDANCY_TARGET);
      expect(p(1e9)).toBeGreaterThanOrEqual(REDUNDANCY_TARGET);
    }
  });
});

describe('what the answer is actually sensitive to', () => {
  it('flips on holder capacity, which is ASSUMED and unmeasured', () => {
    // The conclusion moves a long way when the assumption moves — per
    // PRINCIPLES.md → 5, that makes this a statement about the assumption, not
    // about the system. A weak node (Principle 1 says there will be many) needs
    // near-total cache coverage whatever the curve.
    const weak = requiredCacheHitRate({ hottestRate: HOTTEST, policy: logPolicy, holderCapacityPerWindow: 500 });
    const strong = requiredCacheHitRate({ hottestRate: HOTTEST, policy: logPolicy, holderCapacityPerWindow: 50_000 });
    expect(weak).toBeGreaterThan(0.98);
    expect(strong).toBeLessThan(0.1);
  });

  it('needs no caching at all only where no cap can be applied', () => {
    // The one policy that removes the cache dependency is the one that cannot
    // be deployed. That is the trade, stated plainly.
    expect(requiredCacheHitRate({ hottestRate: HOTTEST, policy: linearPolicy, holderCapacityPerWindow: HOLDER_CAPACITY })).toBe(0);
  });

  it('keeps READS_PER_COPY meaningful as the rule Lucian proposed', () => {
    expect(READS_PER_COPY).toBe(10);
    expect(linearPolicy(100)).toBe(REDUNDANCY_TARGET + 10);
  });
});
