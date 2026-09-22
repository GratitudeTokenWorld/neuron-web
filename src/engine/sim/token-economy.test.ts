import { describe, it, expect } from 'vitest';
import {
  spaceNeutralRatio, provisionForStorage, equilibriumSupply, simulateSupply,
  breakEvenProvisionRatio, burnRateForSelfPayingAt, sybilValueOfAccount,
  grantLifetimeYears, simulateActivitySupply, balancedMintPerByteServed,
  signupIssuance, selfPayingServedBytes, fixedRateStep, balancedReadIntensity,
  washReadStorageYield, capForWashYieldBelowFreeTier, COST_RATIO,
} from './token-economy.js';
import { REDUNDANCY_TARGET } from '../content/custody.js';

/**
 * Hypothesis H-P8: minting for service and burning for storage gives the UNIT
 * an equilibrium, so an inflationary emission is safe.
 *
 * Disproved by: an equilibrium that repels rather than attracts, which is what
 * the measurement found.
 *
 * ASSUMED network: 1M users storing 100 GB each, daily periods, 10% of
 * provisioned bytes served per day. Only the RELATIONSHIPS are being tested.
 */

const GB = 1024 ** 3;
const USERS = 1e6;
const NETWORK_STORED = USERS * 100 * GB;
const PERIODS = 365;
const READ_RATIO = 0.1;
const NETWORK_SERVED = NETWORK_STORED * REDUNDANCY_TARGET * READ_RATIO;
const EMISSION_PER_PERIOD = (1e12 * 20_000 / 1e6) / PERIODS;

const BURN = burnRateForSelfPayingAt({
  targetRatio: 10, readRatio: READ_RATIO,
  networkServedPerPeriod: NETWORK_SERVED, emissionPerPeriod: EMISSION_PER_PERIOD,
});

describe('the 10x is physics, not pricing', () => {
  it('equals REDUNDANCY_TARGET exactly', () => {
    // Storing one logical byte consumes ten physical bytes across the fleet,
    // so providing ten times what you store puts back what you take out.
    expect(spaceNeutralRatio(REDUNDANCY_TARGET)).toBe(10);
    expect(provisionForStorage(100 * GB, REDUNDANCY_TARGET) / GB).toBe(1000);
  });

  it('moves only if the redundancy target moves', () => {
    // The ratio is conservation. If redundancy became 6, self-paying would be
    // 6x - and no economic argument would change that.
    expect(spaceNeutralRatio(6)).toBe(6);
  });

  it('can be made to coincide with the ECONOMIC break-even by the burn rate', () => {
    // Space-neutral and cost-neutral are different conditions: burn is on
    // bytes stored, earnings on bytes served. The burn rate is the knob that
    // lines them up.
    const ratio = breakEvenProvisionRatio({
      burnPerBytePerPeriod: BURN, readRatio: READ_RATIO,
      networkServedPerPeriod: NETWORK_SERVED, emissionPerPeriod: EMISSION_PER_PERIOD,
    });
    expect(ratio).toBeCloseTo(10, 6);
  });
});

describe('H-P8 is DISPROVED: the equilibrium repels', () => {
  it('has a fixed point where burn meets emission', () => {
    const eq = equilibriumSupply({
      inflationPpm: 20_000, burnPerBytePerPeriod: BURN,
      networkBytesStored: NETWORK_STORED, periodsPerYear: PERIODS,
    });
    expect(eq).toBeCloseTo(1e12, -9);
  });

  it('spirals to ZERO from below the fixed point', () => {
    // Supply below equilibrium means minted < burned, so supply falls, so
    // emission (a percentage OF supply) falls further. A death spiral.
    const traj = simulateSupply({
      startSupply: 1e11, inflationPpm: 20_000, burnPerBytePerPeriod: BURN,
      networkBytesStored: NETWORK_STORED, periodsPerYear: PERIODS, periods: 365 * 20,
    });
    expect(traj[traj.length - 1]).toBe(0);
  });

  it('runs away from above the fixed point', () => {
    const traj = simulateSupply({
      startSupply: 1e13, inflationPpm: 20_000, burnPerBytePerPeriod: BURN,
      networkBytesStored: NETWORK_STORED, periodsPerYear: PERIODS, periods: 365 * 20,
    });
    expect(traj[traj.length - 1]!).toBeGreaterThan(1.4e13);
  });

  it('is not fixable by tuning the inflation rate', () => {
    // The instability comes from emission depending on supply while burn does
    // not. Every rate has the same shape.
    for (const ppm of [5_000, 20_000, 100_000]) {
      const eq = equilibriumSupply({
        inflationPpm: ppm, burnPerBytePerPeriod: BURN,
        networkBytesStored: NETWORK_STORED, periodsPerYear: PERIODS,
      });
      const below = simulateSupply({
        startSupply: eq * 0.5, inflationPpm: ppm, burnPerBytePerPeriod: BURN,
        networkBytesStored: NETWORK_STORED, periodsPerYear: PERIODS, periods: 365 * 30,
      });
      // The claim is DIVERGENCE, not a particular end state. A first draft
      // asserted it reaches exactly zero in thirty years, which is only true
      // at high inflation - a low rate drains slowly and was still falling
      // when the window closed. Asserting the wrong thing would have made
      // this test fail for a correct reason.
      expect(below[below.length - 1]!).toBeLessThan(eq * 0.5);
      // Monotonically away from the fixed point, never back toward it.
      for (let i = 1; i < below.length; i++) {
        expect(below[i]!).toBeLessThanOrEqual(below[i - 1]!);
      }
    }
  });
});

describe('the fix: tie emission to ACTIVITY, not to supply', () => {
  const MINT = balancedMintPerByteServed({
    networkBytesStored: NETWORK_STORED, burnPerBytePerPeriod: BURN,
    bytesServedPerPeriod: NETWORK_SERVED,
  });

  it('holds steady from ANY starting supply', () => {
    // Supply no longer appears on the right-hand side, so there is no feedback
    // loop to escape from.
    for (const start of [1e11, 1e12, 1e13]) {
      const traj = simulateActivitySupply({
        startSupply: start, bytesServedPerPeriod: NETWORK_SERVED, mintPerByteServed: MINT,
        networkBytesStored: NETWORK_STORED, burnPerBytePerPeriod: BURN, periods: 365 * 20,
      });
      expect(traj[traj.length - 1]).toBeCloseTo(start, -6);
    }
  });

  it('drifts at a BOUNDED rate when storage and service diverge', () => {
    // Twice the stored data with unchanged service is net deflation - but a
    // linear drift, not a spiral, and it reverses when service catches up.
    const traj = simulateActivitySupply({
      startSupply: 1e12, bytesServedPerPeriod: NETWORK_SERVED, mintPerByteServed: MINT,
      networkBytesStored: NETWORK_STORED * 2, burnPerBytePerPeriod: BURN, periods: 365 * 5,
    });
    const end = traj[traj.length - 1]!;
    expect(end).toBeLessThan(1e12);
    expect(end).toBeGreaterThan(8e11);
  });
});

describe('the signup grant is the real issuance mechanism', () => {
  it('dwarfs service emission at any realistic population', () => {
    // 1M UNITS per human makes total supply a direct function of how many
    // people have joined. Defensible as a universal endowment, but it must be
    // chosen rather than discovered.
    expect(signupIssuance({ humans: 1e6, signupUnits: 1e6 })).toBe(1e12);
    expect(signupIssuance({ humans: 1e10, signupUnits: 1e6 })).toBe(1e16);
  });

  it('puts the money supply in the hands of the identity gate', () => {
    // Each fake human is worth its grant plus whatever the free allowance
    // saves. Stated as a number rather than left implicit.
    const v = sybilValueOfAccount({
      signupUnits: 1e6, freeBytes: 10 * GB, burnPerBytePerPeriod: BURN,
      periodsPerYear: PERIODS, freeStorageYears: 10,
    });
    expect(v.signup).toBe(1e6);
    expect(v.total).toBeGreaterThan(1e6);
  });

  it('covers a lifetime of ordinary storage, which is the intent', () => {
    // At this calibration 1M UNITS pays for 100 GB for ~50 years, so a normal
    // user never has to think about it - exactly what a free tier is for.
    const years = grantLifetimeYears({
      signupUnits: 1e6, bytesStored: 100 * GB,
      burnPerBytePerPeriod: BURN, periodsPerYear: PERIODS,
    });
    expect(years).toBeGreaterThan(40);
  });
});

describe('the actual rule: a fixed store/serve exchange rate', () => {
  const PB = 1024 ** 5;

  it('cancels exactly at 10 GB served per 1 GB stored', () => {
    expect(selfPayingServedBytes(1 * GB) / GB).toBe(10);
    const step = fixedRateStep({
      bytesServedPerPeriod: 10 * GB, bytesStored: 1 * GB, mintPerByteServed: 1e-6,
    });
    expect(step.net).toBe(0);
  });

  it('has no feedback term — supply never appears on the right', () => {
    // Which is why the instability found above cannot arise here. Not tuned
    // away: structurally absent. The same activity gives the same net movement
    // whatever the supply happens to be.
    const a = fixedRateStep({ bytesServedPerPeriod: 30 * GB, bytesStored: 1 * GB, mintPerByteServed: 1e-6 });
    const b = fixedRateStep({ bytesServedPerPeriod: 30 * GB, bytesStored: 1 * GB, mintPerByteServed: 1e-6 });
    expect(a.net).toBe(b.net);
  });

  it('makes mintRate a pure denomination choice', () => {
    // Doubling it doubles every balance and changes nothing real. COST_RATIO
    // is the only economically meaningful parameter.
    const cheap = fixedRateStep({ bytesServedPerPeriod: 30 * GB, bytesStored: 1 * GB, mintPerByteServed: 1e-6 });
    const dear = fixedRateStep({ bytesServedPerPeriod: 30 * GB, bytesStored: 1 * GB, mintPerByteServed: 1e-3 });
    expect(dear.net / cheap.net).toBeCloseTo(1000, 0);
    expect(dear.inflationary).toBe(cheap.inflationary);
  });

  it('identifies the ONE empirical question the design rests on', () => {
    // Supply grows exactly when the network reads more than ten times its
    // stored volume per period. Whether it does is a fact about usage, not a
    // parameter - and it is unmeasured.
    expect(balancedReadIntensity()).toBe(COST_RATIO);
    const stored = 100 * PB;
    for (const [intensity, expectInflation] of [[1, false], [5, false], [30, true]] as const) {
      const s = fixedRateStep({
        bytesServedPerPeriod: stored * intensity, bytesStored: stored, mintPerByteServed: 1e-6,
      });
      expect(s.inflationary).toBe(expectInflation);
    }
  });

  it('lines the economics up with the physics by construction', () => {
    // COST_RATIO is the redundancy factor, which is also the space-conservation
    // ratio. They agree because they are the same number, not because anyone
    // calibrated them together.
    expect(COST_RATIO).toBe(REDUNDANCY_TARGET);
    expect(selfPayingServedBytes(1 * GB)).toBe(provisionForStorage(1 * GB, REDUNDANCY_TARGET));
  });
});

describe('a fixed rate reopens wash-reading — and the cap is now economic', () => {
  it('shows an 8 GB per-pair cap pays BETTER than signing up honestly', () => {
    // Under a capped pool, fake reads only diluted other providers. At a fixed
    // rate they create UNITS from nothing, so the per-reader cap stops being
    // an anti-abuse knob and becomes an economic parameter.
    const w = washReadStorageYield({ perReaderCapBytes: 8 * GB, periodsPerYear: 365 / 30 });
    expect(w.storageBytesPerYear / GB).toBeGreaterThan(9);
    // …against a free tier of 1-10 GB for a LIFETIME. Manufacturing an
    // identity to wash-read would out-earn the door prize, which is exactly
    // backwards.
  });

  it('gives the cap that makes the attack pointless rather than merely bounded', () => {
    // If a fake human mints less storage than a real signup gives away, nobody
    // bothers. ~17 MB per period against a 1 GB/50yr tier; ~168 MB against
    // 10 GB - roughly fifty times tighter than the 8 GB currently in
    // read-receipts.ts.
    const tight = capForWashYieldBelowFreeTier({ freeBytes: 1 * GB, lifetimeYears: 50, periodsPerYear: 365 / 30 });
    const loose = capForWashYieldBelowFreeTier({ freeBytes: 10 * GB, lifetimeYears: 50, periodsPerYear: 365 / 30 });
    expect(tight / 1024 / 1024).toBeCloseTo(16.8, 0);
    expect(loose / 1024 / 1024).toBeCloseTo(168.3, 0);
    expect(loose).toBeLessThan(8 * GB / 40);
  });

  it('stays compatible with honest reading, because the cap is PER PAIR', () => {
    // A tight per-pair cap does not limit a reader overall: honest reads spread
    // across the many providers that hold different content, while wash-reading
    // wants to concentrate on one. The shape of the cap does the work.
    const capPerPair = capForWashYieldBelowFreeTier({
      freeBytes: 10 * GB, lifetimeYears: 50, periodsPerYear: 365 / 30,
    });
    const providersAReaderUses = 60;
    expect((capPerPair * providersAReaderUses) / GB).toBeGreaterThan(9);
  });
});
