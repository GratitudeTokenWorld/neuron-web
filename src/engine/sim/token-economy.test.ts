import { describe, it, expect } from 'vitest';
import {
  spaceNeutralRatio, provisionForStorage, equilibriumSupply, simulateSupply,
  breakEvenProvisionRatio, burnRateForSelfPayingAt, sybilValueOfAccount,
  grantLifetimeYears, simulateActivitySupply, balancedMintPerByteServed,
  signupIssuance,
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
