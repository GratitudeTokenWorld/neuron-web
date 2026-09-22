import { describe, it, expect } from 'vitest';
import { coverage, custodyProofCost } from './incentive-coverage.js';

/**
 * Hypothesis H-P5: paying purely on read/write volume is safe, because a
 * provider that serves is demonstrably holding.
 *
 * Disproved by: content that nobody reads losing its replicas, since a payment
 * rule with finite provider space is also a rule about what survives.
 *
 * ASSUMED throughout: Zipf popularity, rational capacity-bound providers, and a
 * fleet with 50% more space than the floor needs. The sociology of early
 * altruistic operators is deliberately not modelled — this measures the
 * incentive that remains once nobody knows anybody.
 */

const BASE = {
  objects: 100_000,
  zipfExponent: 1,
  totalReadsPerWindow: 10_000_000,
  redundancyTarget: 10,
};
/** Room for every object at the target, plus half again. */
const SLOTS = BASE.objects * BASE.redundancyTarget * 1.5;

describe('H-P5 is DISPROVED: pay-per-read abandons the tail', () => {
  it('leaves seven objects in eight below the durability target', () => {
    const r = coverage({ ...BASE, totalSlots: SLOTS, custodyWeight: 0, serviceWeight: 1 });
    // Reads are split among replicas, so marginal value equalises at
    // replicas ∝ read rate. Over Zipf that is catastrophic for the tail.
    expect(r.durableShare).toBeLessThan(0.15);
    expect(r.medianReplicas).toBeLessThan(3);
  });

  it('over-replicates the hottest object absurdly while the tail starves', () => {
    const r = coverage({ ...BASE, totalSlots: SLOTS, custodyWeight: 0, serviceWeight: 1 });
    // Both failures are the same equation: proportional-to-reads has no floor
    // and no ceiling. The cap on `replicaTarget` bounds placement, but nothing
    // bounds what providers VOLUNTARILY chase when only reads pay.
    expect(r.hottestReplicas).toBeGreaterThan(10_000);
    expect(r.hottestReplicas / r.medianReplicas).toBeGreaterThan(1_000);
  });

  it('drives objects below ONE replica when space is merely adequate', () => {
    // At exactly the floor, proportional allocation puts most of the catalogue
    // under a single copy — which is not under-replication, it is deletion.
    const r = coverage({
      ...BASE,
      totalSlots: BASE.objects * BASE.redundancyTarget,
      custodyWeight: 0,
      serviceWeight: 1,
    });
    // Measured at 17.3%. The first draft asserted >40% from intuition and
    // failed — the real figure is smaller and still means a sixth of the
    // catalogue has no copy at all.
    expect(r.lostShare).toBeGreaterThan(0.15);
    expect(r.durableShare).toBeLessThan(0.1);
  });
});

describe('a custody component fixes it, and that is the whole argument', () => {
  it('keeps every object durable at the same fleet size', () => {
    const r = coverage({ ...BASE, totalSlots: SLOTS, custodyWeight: 1, serviceWeight: 1 });
    // Identical capacity, identical workload; only the payment rule changed.
    expect(r.durableShare).toBe(1);
    expect(r.lostShare).toBe(0);
  });

  it('still rewards popularity — it adds a floor, it does not flatten', () => {
    const r = coverage({ ...BASE, totalSlots: SLOTS, custodyWeight: 1, serviceWeight: 1 });
    expect(r.hottestReplicas).toBeGreaterThan(r.medianReplicas * 100);
  });

  it('degrades to a capacity question, not an incentive one', () => {
    // With a base rate, coverage is limited by whether the fleet HAS the space.
    // That is a problem you can fix by adding providers; an incentive that
    // points away from cold content is not.
    const tight = coverage({
      ...BASE,
      totalSlots: BASE.objects * 4,
      custodyWeight: 1,
      serviceWeight: 1,
      redundancyTarget: 10,
    });
    expect(tight.durableShare).toBe(0);
    expect(tight.lostShare).toBe(0); // spread thin, but nothing abandoned
  });
});

describe('what removing the heartbeat would actually cost', () => {
  it('shows proving cold custody by reads is 800x the beacon', () => {
    // The measured objection to the heartbeat was that it is a BLOCK - 2,555 a
    // year per provider, accruing with the clock. That is a property of putting
    // it on the chain, not of the beacon.
    //
    // "Custody is proven by successful reads" means somebody must issue
    // synthetic reads for content nobody asks for, and that is per OBJECT
    // rather than per provider.
    const c = custodyProofCost({
      providers: 10_000,
      objectsPerProvider: 5_000,
      beatsPerWindow: 6,
      spotChecksPerObjectPerWindow: 1,
    });
    expect(c.spotCheckEverything / c.onChainHeartbeat).toBeGreaterThan(800);
  });

  it('costs the same off-chain as on-chain, in messages', () => {
    // So the fix for the measured defect is to stop chaining it, not to stop
    // sending it: same liveness, zero chain growth.
    const c = custodyProofCost({
      providers: 10_000, objectsPerProvider: 5_000,
      beatsPerWindow: 6, spotChecksPerObjectPerWindow: 1,
    });
    expect(c.offChainBeacon).toBe(c.onChainHeartbeat);
  });
});
