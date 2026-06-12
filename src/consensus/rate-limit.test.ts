import { describe, it, expect } from 'vitest';
import { ValidatorRegistry } from './validators.js';
import { RateLimiter, writeBudget, MIN_WRITE_BUDGET } from './rate-limit.js';
import { STAKE_CAP } from './weight.js';

describe('stake-bonded rate limit', () => {
  it('budget scales with bonded stake and activity-age', () => {
    const tiny = writeBudget(1n, 0);
    const staked = writeBudget(STAKE_CAP, 0);
    const stakedAged = writeBudget(STAKE_CAP, 52);
    expect(tiny).toBe(MIN_WRITE_BUDGET);
    expect(staked).toBeGreaterThan(tiny);
    expect(stakedAged).toBeGreaterThan(staked);
  });

  it('enforces the budget within an epoch and resets on rotation', () => {
    const reg = new ValidatorRegistry();
    reg.bond('a', STAKE_CAP);
    reg.creditActivity('a', 52);
    const rl = new RateLimiter();

    const budget = rl.budgetFor(reg, 'a');
    expect(budget).toBeGreaterThan(0);
    for (let i = 0; i < budget; i++) expect(rl.tryConsume(reg, 'a')).toBe(true);
    expect(rl.tryConsume(reg, 'a')).toBe(false); // over budget

    rl.rotate(1);
    expect(rl.tryConsume(reg, 'a')).toBe(true); // reset for the new epoch
  });
});
