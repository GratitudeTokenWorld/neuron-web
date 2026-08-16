import { describe, it, expect } from 'vitest';
import { runRepairScenario } from './repair.js';
import { REDUNDANCY_TARGET } from '../content/custody.js';

/**
 * The flow property, measured.
 *
 * The claim under test is the one CLAUDE.md and ARCHITECTURE.md both rest on:
 * content survives because repair outruns churn, NOT because many copies exist.
 * A test suite that only ever ran the healthy configuration would prove nothing —
 * so the load-bearing case here is the one where repair is throttled below the
 * churn rate and durability is expected to FAIL. If that case ever starts
 * passing, the simulation has stopped modelling anything.
 */

/** A month of hourly ticks: long enough for a decaying stock to actually decay. */
const TICKS = 720;

describe('repair vs churn — durability as a flow', () => {
  it('survives heavy churn when repair throughput is ample', () => {
    const stats = runRepairScenario({
      objects: 40,
      fleet: 120,
      churnPerTick: 0.02,       // ~2% of the fleet drops out every hour
      rejoinPerTick: 0.10,
      repairPerTick: 200,       // repair is not the bottleneck
      ticks: TICKS,
      seed: 7,
    });

    expect(stats.lost).toBe(0);
    expect(stats.durable).toBe(true);
    expect(stats.finalMeanReplicas).toBeGreaterThanOrEqual(REDUNDANCY_TARGET);
    // Churn is real — the run is not passing by never losing anything.
    expect(stats.churnRate).toBeGreaterThan(0);
  });

  it('LOSES content when repair is throttled below the churn rate', () => {
    const starved = runRepairScenario({
      objects: 40,
      fleet: 120,
      churnPerTick: 0.05,
      rejoinPerTick: 0.02,      // nodes leave far faster than they come back
      repairPerTick: 1,         // one placement an hour against dozens of losses
      ticks: TICKS,
      seed: 7,
    });

    // The stock decays monotonically once the flow is negative — no amount of
    // "we started at 10 copies" saves it.
    expect(starved.durable).toBe(false);
    expect(starved.finalMeanReplicas).toBeLessThan(REDUNDANCY_TARGET);
    expect(starved.everUnderReplicated).toBeGreaterThan(0);
    // And the budget is visibly the binding constraint, not the fleet size.
    expect(starved.starvedRate).toBeGreaterThan(0);
  });

  it('is the repair BUDGET that decides it, with everything else held equal', () => {
    const common = {
      objects: 40, fleet: 120,
      churnPerTick: 0.04, rejoinPerTick: 0.03,
      ticks: TICKS, seed: 11,
    };
    const throttled = runRepairScenario({ ...common, repairPerTick: 1 });
    const ample = runRepairScenario({ ...common, repairPerTick: 200 });

    expect(throttled.durable).toBe(false);
    expect(ample.durable).toBe(true);
    expect(ample.finalMeanReplicas).toBeGreaterThan(throttled.finalMeanReplicas);
  });

  it('a fleet that never churns needs no repair at all', () => {
    const stats = runRepairScenario({
      objects: 20, fleet: 60,
      churnPerTick: 0, rejoinPerTick: 0,
      repairPerTick: 0, ticks: 100, seed: 3,
    });
    expect(stats.churnRate).toBe(0);
    expect(stats.repairRate).toBe(0);
    expect(stats.minLiveReplicas).toBe(REDUNDANCY_TARGET);
    expect(stats.durable).toBe(true);
  });

  it('a brief absence inside the lease costs no repair — that is what the slack is for', () => {
    // Every node bounces constantly but returns fast, so no lease ever lapses.
    const stats = runRepairScenario({
      objects: 20, fleet: 60,
      churnPerTick: 0.30,       // a third of the fleet blinks out every hour…
      rejoinPerTick: 0.95,      // …and nearly all of it is back the next
      repairPerTick: 100,
      ticks: 200, seed: 5,
    });
    expect(stats.churnRate).toBe(0);        // no lease expired
    expect(stats.repairRate).toBe(0);       // so nothing had to be re-placed
    expect(stats.durable).toBe(true);
  });

  it('is deterministic — a durability threshold that moved between runs would be useless', () => {
    const cfg = {
      objects: 25, fleet: 80,
      churnPerTick: 0.03, rejoinPerTick: 0.05,
      repairPerTick: 20, ticks: 300, seed: 42,
    };
    const a = runRepairScenario(cfg);
    const b = runRepairScenario(cfg);
    expect(b).toEqual(a);
    // …and a different seed is genuinely a different run, not a fixed script.
    const c = runRepairScenario({ ...cfg, seed: 43 });
    expect(c.churnRate).not.toBe(a.churnRate);
  });

  it('a returning node past the lease does not resurrect replicas the network re-homed', () => {
    // Long absences (slow rejoin) with ample repair: every lapse is repaired
    // onto a live node, and the returning node discards rather than re-adding
    // itself. If planRejoin kept the content, mean replicas would drift ABOVE
    // the target as the same object accumulated stale holders.
    const stats = runRepairScenario({
      objects: 30, fleet: 100,
      churnPerTick: 0.05, rejoinPerTick: 0.05,
      repairPerTick: 200, ticks: TICKS, seed: 9,
    });
    expect(stats.durable).toBe(true);
    expect(stats.finalMeanReplicas).toBe(REDUNDANCY_TARGET);
  });
});
