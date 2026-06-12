import { describe, it, expect } from 'vitest';
import { RewardLedger } from './rewards.js';

describe('RewardLedger', () => {
  it('caps emission at the inflation rate, with a base floor when supply is tiny', () => {
    const big = new RewardLedger(1_000_000_000n, { inflationPpm: 100n, baseEmission: 1000n });
    expect(big.epochEmission()).toBe(100_000n); // 1e9 * 100ppm = 100000 > floor

    const tiny = new RewardLedger(1000n, { inflationPpm: 100n, baseEmission: 5000n });
    expect(tiny.epochEmission()).toBe(5000n); // rate would be 0 → base floor
  });

  it('distributes proportionally to contribution and grows supply by exactly what it mints', () => {
    const r = new RewardLedger(1_000_000n, { inflationPpm: 10_000n, baseEmission: 0n }); // 1% → 10000
    const before = r.totalSupply();
    const { minted, perRecipient } = r.distribute(new Map([['a', 3], ['b', 1]]));

    expect(Number(perRecipient.get('a')!) / Number(perRecipient.get('b')!)).toBeCloseTo(3, 1);
    expect(minted).toBeLessThanOrEqual(10_000n);
    expect(r.totalSupply()).toBe(before + minted);
    expect(r.earnedBy('a')).toBe(perRecipient.get('a'));
  });

  it('mints nothing when there are no contributors', () => {
    const r = new RewardLedger(1_000_000n, { inflationPpm: 10_000n, baseEmission: 100n });
    const { minted } = r.distribute(new Map());
    expect(minted).toBe(0n);
    expect(r.totalSupply()).toBe(1_000_000n);
  });
});
