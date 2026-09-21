import { describe, it, expect } from 'vitest';
import { runReciprocity, DEFAULT_RECIPROCITY as D } from './reciprocity.js';

/**
 * Hypothesis H-P2: storage can work with **no payment at all** — reads and
 * writes throttled by a locally-metered, non-transferable reciprocity budget.
 *
 * Disproved by: free-riders obtaining the service contributors get, an honest
 * newcomer starving, or the access floor failing to hold.
 *
 * Two of the three failure modes below were found by running this, not by
 * reasoning about it, and each is kept as a control so it cannot return
 * silently.
 */

const ratio = (r: ReturnType<typeof runReciprocity>) =>
  r.byClass.contributor.servedFraction / (r.byClass.freerider.servedFraction || 1e-9);

describe('H-P2: reciprocity in place of payment', () => {
  it('serves contributors several times better than free-riders', () => {
    const r = runReciprocity(D);
    expect(r.byClass.contributor.servedFraction).toBeGreaterThan(0.35);
    expect(r.byClass.freerider.servedFraction).toBeLessThan(0.10);
    expect(ratio(r)).toBeGreaterThan(4);
  });

  it('holds across seeds, so the result is not one lucky draw', () => {
    for (const seed of [1, 7, 42, 1337]) {
      const r = runReciprocity({ ...D, seed });
      expect(ratio(r)).toBeGreaterThan(3);
      expect(r.byClass.contributor.servedFraction).toBeGreaterThan(0.3);
    }
  });

  it('keeps the access floor open to a peer that has earned nothing', () => {
    // Principle 1 is ACCESS, and reciprocity is exclusionary by nature. A node
    // with nothing to give back — a sensor, a phone, a brand-new install — must
    // still be served. If this ever reads 0, the mechanism has eaten the
    // principle and the number to change is `newPeerPrior`.
    const r = runReciprocity(D);
    expect(r.byClass.freerider.served).toBeGreaterThan(0);
    expect(r.byClass.freerider.servedFraction).toBeGreaterThan(0.01);
  });

  it('lets an honest newcomer overtake a free-rider by serving', () => {
    const r = runReciprocity(D);
    // Joins halfway through with no history at all, and still does several
    // times better than a peer that simply refuses to serve.
    expect(r.byClass.newcomer.servedFraction).toBeGreaterThan(r.byClass.freerider.servedFraction * 2);
    // …but not as well as an established contributor. Reputation takes time,
    // which is the property that makes it expensive to fake.
    expect(r.byClass.newcomer.servedFraction).toBeLessThan(r.byClass.contributor.servedFraction);
  });
});

describe('the three ways this design fails (each found by running it)', () => {
  it('FAILS when the free floor is granted per stranger instead of per server', () => {
    // A per-stranger allowance is a subsidy keyed by something the attacker
    // picks (SCREENING.md → 1). Spread requests across peers and every one is
    // a first request, so free-riding costs nothing.
    const r = runReciprocity({ ...D, priorPerPeer: true });
    expect(ratio(r)).toBeLessThan(1.5);
    expect(r.byClass.freerider.servedFraction).toBeGreaterThan(0.4);
  });

  it('FAILS when partners are drawn uniformly — judge the stock, not the ratio', () => {
    // The trap this project has hit before (CLAUDE.md → repair vs churn): the
    // RATIO looks superb here, better than the working design's, because
    // free-riders get almost nothing. But contributors are starving too —
    // credit never accumulates when you never meet the same peer twice, so
    // nearly everyone is living on the floor.
    const r = runReciprocity({ ...D, neighbourhood: 0 });
    expect(ratio(r)).toBeGreaterThan(10);
    expect(r.byClass.contributor.servedFraction).toBeLessThan(0.25);
    // Half the service of the working design, at a flattering ratio.
    expect(r.byClass.contributor.servedFraction)
      .toBeLessThan(runReciprocity(D).byClass.contributor.servedFraction * 0.6);
  });

  it('FAILS when relationships are one-directional', () => {
    // Sticky partners are not enough. If I ask one set of peers and am asked by
    // another, I earn credit where I never spend it. The design consequence is
    // that custody assignments should be PAIRED: storage paid for in storage.
    const unpaired = runReciprocity({ ...D, mutual: false });
    const paired = runReciprocity(D);
    expect(unpaired.byClass.contributor.servedFraction)
      .toBeLessThan(paired.byClass.contributor.servedFraction * 0.6);
    // And the newcomer is hurt worst: it has no inbound demand to earn from.
    expect(unpaired.byClass.newcomer.servedFraction).toBeLessThan(0.05);
  });
});
