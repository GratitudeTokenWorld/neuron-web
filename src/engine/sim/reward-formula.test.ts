import { describe, it, expect } from 'vitest';
import {
  projectEarnings, custodyShareOfEarnings, servingPremium,
  splittingGain, inequalityRatio, DEFAULT_FLEET,
  claimCost, claimDayFor, claimSlotFor, claimsUnderThreshold,
  fleetBreakEven, ASSUMED_ANNUAL_COST,
} from './reward-formula.js';

/**
 * Hypothesis H-P7: `custodyRate × bytesHeld + serviceRate × bytesServed`, split
 * from a capped pool, is a workable reward formula.
 *
 * Disproved by: a weighting where serving is not worth doing, where cold
 * content is abandoned, or where the payout distribution excludes a class of
 * device the principles promise to include.
 *
 * PROJECTIONS, NOT MEASUREMENTS. Supply, inflation, fleet size and the device
 * mix are all ASSUMED; only the relationships between them are being tested.
 */

const GB = 1024 ** 3;
/** ASSUMED: 1M supply, 2% annual inflation, daily epochs. */
const SUPPLY = 1_000_000;
const WINDOWS_PER_YEAR = 365;
const EMISSION = (SUPPLY * 20_000 / 1e6) / WINDOWS_PER_YEAR;

const project = (weights: { custodyRate: number; serviceRate: number; alpha?: number }) =>
  projectEarnings({
    archetypes: DEFAULT_FLEET, weights,
    emissionPerWindow: EMISSION, windowsPerYear: WINDOWS_PER_YEAR,
  });

describe('the custody/service balance', () => {
  it('makes serving pointless when the custody term dominates', () => {
    // At 1:0.1 a laptop earns 1% more for serving 5 GB than for refusing. The
    // rational strategy is to hoard bytes and decline reads, which is the
    // free-rider failure - a write-only archive.
    const premium = servingPremium({
      weights: { custodyRate: 1, serviceRate: 0.1 }, bytesHeld: 50 * GB, bytesServed: 5 * GB,
    });
    expect(premium).toBeLessThan(1.02);
  });

  it('makes serving clearly worth it at 1:3 or better', () => {
    const premium = servingPremium({
      weights: { custodyRate: 1, serviceRate: 3 }, bytesHeld: 50 * GB, bytesServed: 5 * GB,
    });
    expect(premium).toBeGreaterThan(1.25);
  });

  it('keeps a custody term big enough that cold bytes still earn', () => {
    // The other side: with a service-heavy rule, holding unread content earns
    // too little to be worth the disk (see incentive-coverage.ts).
    const share = custodyShareOfEarnings({
      weights: { custodyRate: 1, serviceRate: 3 }, bytesHeld: 50 * GB, bytesServed: 5 * GB,
    });
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.95);
  });
});

describe('who actually earns — the finding that matters most', () => {
  it('pays a datacentre ~25,000x a phone under a LINEAR weight', () => {
    // Weight proportional to bytes means earnings proportional to bytes, and
    // the device range is five orders of magnitude. This is Principle 1
    // failing in the economics rather than in the code.
    const { rows } = project({ custodyRate: 1, serviceRate: 3, alpha: 1 });
    expect(inequalityRatio(rows)).toBeGreaterThan(20_000);
  });

  it('compresses the range as the weight becomes concave', () => {
    const linear = inequalityRatio(project({ custodyRate: 1, serviceRate: 3, alpha: 1 }).rows);
    const mild = inequalityRatio(project({ custodyRate: 1, serviceRate: 3, alpha: 0.9 }).rows);
    const strong = inequalityRatio(project({ custodyRate: 1, serviceRate: 3, alpha: 0.5 }).rows);
    expect(mild).toBeLessThan(linear / 2);
    expect(strong).toBeLessThan(linear / 100);
  });

  it('but concavity is a SPLITTING incentive, and that is the cost', () => {
    // `N^(1-alpha)`: the same bytes earn more when split across identities.
    expect(splittingGain(100, 1)).toBe(1);        // linear: no incentive at all
    expect(splittingGain(100, 0.9)).toBeCloseTo(1.58, 1);
    expect(splittingGain(100, 0.5)).toBe(10);     // clearly worth attacking
  });

  it('identifies alpha ~0.9 as the defensible point on the curve', () => {
    // Inequality falls ~2.8x while splitting 100 ways gains only 58% - and
    // under one-human-one-account that costs 100 recruited humans. Not worth
    // it. At 0.5 the same attack pays 10x and becomes worth organising.
    const mild = splittingGain(100, 0.9);
    const strong = splittingGain(100, 0.5);
    expect(mild).toBeLessThan(2);
    expect(strong).toBeGreaterThan(5);
  });

  it('leaves small devices earning essentially nothing, at EVERY weighting', () => {
    // The honest conclusion, and it does not go away with tuning: a phone
    // holding 2 GB earns a rounding error however the weights are set, because
    // the pool is small and the fleet is large. Small devices participate for
    // ACCESS, not revenue. The IoT story is "your sensor can use the network",
    // never "your sensor pays for itself".
    for (const alpha of [1, 0.9, 0.75, 0.5]) {
      const phone = project({ custodyRate: 1, serviceRate: 3, alpha }).rows
        .find(r => r.name === 'phone')!;
      expect(phone.perYear).toBeLessThan(0.01);
    }
  });
});

describe('the pool is capped, so this is a share contest', () => {
  it('cannot pay out more than the emission however large the fleet', () => {
    const { rows } = project({ custodyRate: 1, serviceRate: 3 });
    const total = rows.reduce((sum, r) => {
      const arch = DEFAULT_FLEET.find(a => a.name === r.name)!;
      return sum + r.perWindow * arch.count;
    }, 0);
    expect(total).toBeLessThanOrEqual(EMISSION * 1.0000001);
  });

  it('means one provider earning more makes others earn less', () => {
    // The property that turns wash-reading from minting into dilution.
    const base = project({ custodyRate: 1, serviceRate: 3 });
    const withWhale = projectEarnings({
      archetypes: [...DEFAULT_FLEET, {
        name: 'whale', bytesHeld: 500 * 1024 ** 4, bytesServed: 100 * 1024 ** 4, count: 100,
      }],
      weights: { custodyRate: 1, serviceRate: 3 },
      emissionPerWindow: EMISSION, windowsPerYear: WINDOWS_PER_YEAR,
    });
    const before = base.rows.find(r => r.name === 'laptop')!.perYear;
    const after = withWhale.rows.find(r => r.name === 'laptop')!.perYear;
    expect(after).toBeLessThan(before);
  });
});

describe('claim cadence (Lucian, 2026-09-22)', () => {
  const BLOCK = 400;

  it('confirms a 24h manual floor is 30x the chain cost of a 30-day auto-claim', () => {
    // 365 claims a year per user against 12.17. At 100M accounts that is 36.5
    // billion blocks a year versus 1.22 billion - 13.3 TB against 0.44 TB.
    const manual = claimCost({ accounts: 100e6, claimsPerYear: 365, blockBytes: BLOCK, windowsPerYear: 365 });
    const auto = claimCost({ accounts: 100e6, claimsPerYear: 365 / 30, blockBytes: BLOCK, windowsPerYear: 365 });
    expect(manual.blocksPerYear / auto.blocksPerYear).toBeCloseTo(30, 0);
    expect(auto.bytesPerYear / 1024 ** 4).toBeLessThan(0.5);
  });

  it('shows the hidden cost: evidence retention grows with the interval', () => {
    // The part that is easy to miss. A claim must be VALIDATABLE, so the
    // evidence has to outlive the interval. Pruned too early it does not make
    // a smaller payout - it makes a block every node rejects, stranding the
    // chain behind it.
    const manual = claimCost({ accounts: 1e6, claimsPerYear: 365, blockBytes: BLOCK, windowsPerYear: 365 });
    const auto = claimCost({ accounts: 1e6, claimsPerYear: 365 / 30, blockBytes: BLOCK, windowsPerYear: 365 });
    expect(manual.retentionWindows).toBe(2);
    expect(auto.retentionWindows).toBe(60);
  });

  it('spreads automatic claims uniformly, so there is no herd day', () => {
    // A 30-day auto-claim for everyone would put the whole network's
    // settlement traffic on one day in thirty. Deriving the day from the
    // account id spreads it with no coordination and is verifiable by anyone.
    const buckets = new Array(30).fill(0);
    for (let i = 0; i < 60_000; i++) buckets[claimDayFor(`acct${i}`, 30)]!++;
    const ideal = 60_000 / 30;
    expect(Math.min(...buckets)).toBeGreaterThan(ideal * 0.9);
    expect(Math.max(...buckets)).toBeLessThan(ideal * 1.1);
  });

  it('is deterministic, so a node can predict its own day without asking', () => {
    expect(claimDayFor('alice', 30)).toBe(claimDayFor('alice', 30));
    expect(claimDayFor('alice', 30)).toBeLessThan(30);
  });
});

describe('spreading claims without a fixed day (Lucian, 2026-09-22)', () => {
  it('never returns a negative slot — the bug this measurement caught', () => {
    // The first version mixed with `h ^= h >>> 13` and skipped the final
    // `>>> 0`, so the result was SIGNED and the modulo could come out
    // negative. Found by counting distinct slots and getting 77,740 in a
    // 43,200-slot period, which is arithmetically impossible.
    for (let i = 0; i < 20_000; i++) {
      const slot = claimSlotFor(`acct${i}`, 43_200);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(43_200);
    }
  });

  it('turns a daily spike into a continuous trickle', () => {
    // 30 days of minutes is 43,200 slots. 200k accounts land ~4.6 per slot
    // instead of 6,667 on one day.
    const buckets = new Map<number, number>();
    for (let i = 0; i < 200_000; i++) {
      const s = claimSlotFor(`acct${i}`, 43_200);
      buckets.set(s, (buckets.get(s) ?? 0) + 1);
    }
    expect(buckets.size).toBeGreaterThan(40_000);
    // No slot carries a meaningful share of the load.
    expect(Math.max(...buckets.values())).toBeLessThan(30);
  });
});

describe('a minimum claim collapses the volume — the better fix', () => {
  const EMISSION_L = (SUPPLY * 20_000 / 1e6) / WINDOWS_PER_YEAR;
  const earnings = new Map(
    projectEarnings({
      archetypes: DEFAULT_FLEET, weights: { custodyRate: 1, serviceRate: 3, alpha: 0.9 },
      emissionPerWindow: EMISSION_L, windowsPerYear: WINDOWS_PER_YEAR,
    }).rows.map(r => [r.name, r.perYear] as const),
  );

  it('drops claims 65x by refusing to write a block for a rounding error', () => {
    // Most accounts earn almost nothing, so most claims would move almost
    // nothing. Letting those accrue is free: receipts are cumulative and the
    // baseline only moves at settlement, so waiting loses nobody anything.
    const none = claimsUnderThreshold({
      archetypes: DEFAULT_FLEET, earningsPerYear: earnings, minClaim: 0, maxClaimsPerYear: 12.17,
    });
    const threshold = claimsUnderThreshold({
      archetypes: DEFAULT_FLEET, earningsPerYear: earnings, minClaim: 0.1, maxClaimsPerYear: 12.17,
    });
    expect(none.totalClaimsPerYear / threshold.totalClaimsPerYear).toBeGreaterThan(60);
  });

  it('leaves only the accounts with something worth settling', () => {
    const c = claimsUnderThreshold({
      archetypes: DEFAULT_FLEET, earningsPerYear: earnings, minClaim: 0.1, maxClaimsPerYear: 12.17,
    });
    // Datacentres claim at the cadence; a phone would wait millennia, which is
    // the correct answer for an amount that rounds to nothing.
    expect(c.byName.get('datacentre')).toBeCloseTo(12.17, 1);
    expect(c.byName.get('phone')!).toBeLessThan(0.01);
  });
});

describe('can rewards cover the cost of RUNNING a node?', () => {
  it('answers at the fleet level, which is the honest scale', () => {
    // Lucian: the reward should not pay for the device, but could cover
    // running it. At fleet level that is one statement - the annual emission
    // must be worth roughly what the fleet costs to run.
    const b = fleetBreakEven({
      archetypes: DEFAULT_FLEET, annualCostByName: ASSUMED_ANNUAL_COST,
      annualEmissionUnits: 20_000, supplyUnits: SUPPLY,
    });
    expect(b.annualFleetCost / 1e6).toBeCloseTo(16.9, 0);
    // So a UNIT has to be worth ~$848, i.e. an ~$848M market cap at 1M supply.
    expect(b.unitPrice).toBeGreaterThan(800);
    expect(b.unitPrice).toBeLessThan(900);
  });

  it('scales with the emission rate, not with the formula weights', () => {
    // The binding constraint is the size of the pool. No choice of
    // custody:service ratio or alpha changes what the fleet costs to run.
    const doubled = fleetBreakEven({
      archetypes: DEFAULT_FLEET, annualCostByName: ASSUMED_ANNUAL_COST,
      annualEmissionUnits: 40_000, supplyUnits: SUPPLY,
    });
    expect(doubled.unitPrice).toBeCloseTo(424, 0);
  });
});
