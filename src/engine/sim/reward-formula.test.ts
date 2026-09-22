import { describe, it, expect } from 'vitest';
import {
  projectEarnings, custodyShareOfEarnings, servingPremium,
  splittingGain, inequalityRatio, DEFAULT_FLEET,
  claimCost, claimDayFor,
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
