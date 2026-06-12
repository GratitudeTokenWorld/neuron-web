import { describe, it, expect } from 'vitest';
import { getShard, isInSubscribedShards } from './partition.js';

describe('partition', () => {
  it('is deterministic and within range', () => {
    const s = getShard('account-abc', 16);
    expect(getShard('account-abc', 16)).toBe(s);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(16);
  });

  it('spreads accounts across all shards', () => {
    const counts = new Array(16).fill(0);
    for (let i = 0; i < 4000; i++) counts[getShard('acct-' + i, 16)]++;
    expect(counts.every((c) => c > 0)).toBe(true);
  });

  it('always returns 0 for a single shard', () => {
    expect(getShard('anything', 1)).toBe(0);
  });

  it('rejects an invalid shard count', () => {
    expect(() => getShard('x', 0)).toThrow();
    expect(() => getShard('x', -3)).toThrow();
  });

  it('answers subscription membership', () => {
    const id = 'acct-5';
    const s = getShard(id, 16);
    expect(isInSubscribedShards(id, new Set([s]), 16)).toBe(true);
    expect(isInSubscribedShards(id, new Set([(s + 1) % 16]), 16)).toBe(false);
  });
});
