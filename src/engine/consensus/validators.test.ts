import { describe, it, expect } from 'vitest';
import { ValidatorRegistry } from './validators.js';
import { STAKE_CAP, votingWeight } from './weight.js';

describe('ValidatorRegistry', () => {
  it('bonds up to the cap and rejects over-cap bonding', () => {
    const r = new ValidatorRegistry();
    expect(r.bond('a', STAKE_CAP).ok).toBe(true);
    expect(r.bondedOf('a')).toBe(STAKE_CAP);
    expect(r.bond('a', 1n).ok).toBe(false);
  });

  it('requires the minimum bond to be an eligible validator', () => {
    const r = new ValidatorRegistry(STAKE_CAP, 100n);
    r.bond('a', 50n);
    expect(r.isValidator('a')).toBe(false);
    r.bond('a', 50n);
    expect(r.isValidator('a')).toBe(true);
    expect(r.validators()).toContain('a');
  });

  it('reflects activity-age in weight', () => {
    const r = new ValidatorRegistry();
    r.bond('a', STAKE_CAP);
    const before = r.weightOf('a');
    r.creditActivity('a', 52);
    expect(r.weightOf('a')).toBeGreaterThan(before);
    expect(r.weightOf('a')).toBeCloseTo(votingWeight(STAKE_CAP, 52));
  });

  it('slashing burns the bond and permanently bars the validator', () => {
    const r = new ValidatorRegistry();
    r.bond('a', STAKE_CAP);
    expect(r.slash('a')).toBe(STAKE_CAP);
    expect(r.bondedOf('a')).toBe(0n);
    expect(r.isValidator('a')).toBe(false);
    expect(r.weightOf('a')).toBe(0);
    expect(r.bond('a', 100n).ok).toBe(false); // cannot rebond after slashing
  });
});
