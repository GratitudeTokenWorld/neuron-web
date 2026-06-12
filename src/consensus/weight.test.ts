import { describe, it, expect } from 'vitest';
import {
  ageMultiplier,
  stakeWeight,
  votingWeight,
  splittingIsProfitableWithoutOneHumanOneAccount,
  STAKE_CAP,
  MAX_AGE_MULTIPLIER,
  AGE_SATURATION_EPOCHS,
} from './weight.js';

describe('voting weight', () => {
  it('age multiplier rises from 1 to MAX and saturates', () => {
    expect(ageMultiplier(0)).toBe(1);
    expect(ageMultiplier(AGE_SATURATION_EPOCHS)).toBe(MAX_AGE_MULTIPLIER);
    expect(ageMultiplier(AGE_SATURATION_EPOCHS * 10)).toBe(MAX_AGE_MULTIPLIER); // saturates, no oligarchy
    expect(ageMultiplier(AGE_SATURATION_EPOCHS / 2)).toBeCloseTo(1 + (MAX_AGE_MULTIPLIER - 1) * 0.5);
  });

  it('stake weight is concave and capped at the mint', () => {
    expect(stakeWeight(STAKE_CAP)).toBeCloseTo(Math.sqrt(Number(STAKE_CAP)));
    expect(stakeWeight(STAKE_CAP * 2n)).toBe(stakeWeight(STAKE_CAP)); // cap → whales can't out-bond
    expect(stakeWeight(400_000n)).toBeLessThan(2 * stakeWeight(200_000n)); // concave
  });

  it('combines age and stake; a fully-aged validator is MAX× a fresh one', () => {
    const full = votingWeight(STAKE_CAP, AGE_SATURATION_EPOCHS);
    const fresh = votingWeight(STAKE_CAP, 0);
    expect(full / fresh).toBeCloseTo(MAX_AGE_MULTIPLIER);
  });

  it('documents why one-human-one-account is required for concave weighting', () => {
    // Splitting a stake across n accounts multiplies √-weight by √n — a fatal
    // exploit IF accounts could be Sybil'd. One-human-one-account is what blocks it.
    const { single, split } = splittingIsProfitableWithoutOneHumanOneAccount(1_000_000n, 4);
    expect(split).toBeGreaterThan(single);
    expect(split / single).toBeCloseTo(2, 1); // √4 = 2×
  });
});
