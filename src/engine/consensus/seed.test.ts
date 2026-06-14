import { describe, it, expect } from 'vitest';
import { hashHex, utf8ToBytes, type Hex } from '../core/hash.js';
import { GENESIS_SEED, deriveNextSeed, EpochSeeds, epochOfHeight, EPOCH_BLOCKS } from './seed.js';

/** A few well-formed 32-byte "betas" (any 32-byte hex works for the derivation). */
function beta(tag: string): Hex {
  return hashHex(utf8ToBytes(`beta:${tag}`));
}

describe('accumulated-VRF epoch seed', () => {
  it('genesis seed is fixed + deterministic', () => {
    expect(GENESIS_SEED).toBe(new EpochSeeds().seedFor(0));
    expect(GENESIS_SEED).toHaveLength(64);
  });

  it('derivation is independent of beta order', () => {
    const a = deriveNextSeed(GENESIS_SEED, [beta('x'), beta('y'), beta('z')]);
    const b = deriveNextSeed(GENESIS_SEED, [beta('z'), beta('x'), beta('y')]);
    expect(a).toBe(b);
  });

  it('derivation de-duplicates repeated betas', () => {
    const a = deriveNextSeed(GENESIS_SEED, [beta('x'), beta('y')]);
    const b = deriveNextSeed(GENESIS_SEED, [beta('x'), beta('y'), beta('x'), beta('y')]);
    expect(a).toBe(b);
  });

  it('changing any contributing beta changes the next seed (avalanche)', () => {
    const a = deriveNextSeed(GENESIS_SEED, [beta('x'), beta('y')]);
    const b = deriveNextSeed(GENESIS_SEED, [beta('x'), beta('y2')]);
    expect(a).not.toBe(b);
  });

  it('the same prior seed with no betas still advances deterministically', () => {
    expect(deriveNextSeed(GENESIS_SEED, [])).toBe(deriveNextSeed(GENESIS_SEED, []));
    expect(deriveNextSeed(GENESIS_SEED, [])).not.toBe(GENESIS_SEED);
  });

  it('EpochSeeds chains seeds in order; independent nodes agree', () => {
    const betas0 = [beta('a'), beta('b')];
    const betas1 = [beta('c'), beta('d')];

    const node1 = new EpochSeeds();
    node1.commit(0, betas0);
    node1.commit(1, betas1);

    // A second node sees the same betas in a different order.
    const node2 = new EpochSeeds();
    node2.commit(0, [...betas0].reverse());
    node2.commit(1, [...betas1].reverse());

    expect(node1.seedFor(1)).toBe(node2.seedFor(1));
    expect(node1.seedFor(2)).toBe(node2.seedFor(2));
    expect(node1.currentEpoch).toBe(2);
  });

  it('commit is idempotent for identical betas', () => {
    const s = new EpochSeeds();
    const first = s.commit(0, [beta('a')]);
    const second = s.commit(0, [beta('a')]);
    expect(first).toBe(second);
    expect(s.seedFor(1)).toBe(first);
  });

  it('refuses to commit an epoch whose seed is unknown', () => {
    const s = new EpochSeeds();
    expect(() => s.commit(5, [beta('a')])).toThrow();
  });

  it('a downstream seed changes if an earlier epoch is perturbed', () => {
    const base = new EpochSeeds();
    base.commit(0, [beta('a')]);
    base.commit(1, [beta('b')]);

    const perturbed = new EpochSeeds();
    perturbed.commit(0, [beta('a-tampered')]);
    perturbed.commit(1, [beta('b')]); // same epoch-1 betas, but epoch-0 differed

    expect(perturbed.seedFor(2)).not.toBe(base.seedFor(2));
  });

  it('epochOfHeight buckets by block height', () => {
    expect(epochOfHeight(0)).toBe(0);
    expect(epochOfHeight(EPOCH_BLOCKS - 1)).toBe(0);
    expect(epochOfHeight(EPOCH_BLOCKS)).toBe(1);
    expect(epochOfHeight(EPOCH_BLOCKS * 3 + 7)).toBe(3);
  });
});
