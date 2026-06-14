import { describe, it, expect } from 'vitest';
import { bytesToHex, type Hex } from '../core/hash.js';
import { publicKeyFromPrivate } from '../core/keys.js';
import {
  proveSortition,
  verifySortition,
  seatsFromBeta,
  sortitionAlpha,
} from './sortition.js';
import { vrfProve } from './vrf.js';

/** Deterministic test key from a small scalar (1..N), already reduced mod the order. */
function keyFromScalar(i: number): { priv: Hex; pub: Hex } {
  const bytes = new Uint8Array(32);
  let x = BigInt(i + 1);
  for (let j = 31; j >= 0; j--) {
    bytes[j] = Number(x & 0xffn);
    x >>= 8n;
  }
  const priv = bytesToHex(bytes);
  return { priv, pub: publicKeyFromPrivate(priv) };
}

const SEED = 'epoch-seed-abc';

describe('VRF self-sortition', () => {
  it('prove and verify agree on the seat count', () => {
    const { priv, pub } = keyFromScalar(7);
    const p = proveSortition(priv, SEED, 3, 9, 1000, 50_000, 64);
    const v = verifySortition(pub, SEED, 3, 9, 1000, 50_000, 64, p.pi);
    expect(v).toBe(p.seats);
  });

  it('is deterministic — identical inputs yield identical proof + seats', () => {
    const { priv } = keyFromScalar(7);
    const a = proveSortition(priv, SEED, 3, 9, 1000, 50_000, 64);
    const b = proveSortition(priv, SEED, 3, 9, 1000, 50_000, 64);
    expect(a).toEqual(b);
  });

  it('rejects a proof under the wrong key (returns null, not a seat count)', () => {
    const { priv } = keyFromScalar(7);
    const other = keyFromScalar(8).pub;
    const p = proveSortition(priv, SEED, 3, 9, 1000, 50_000, 64);
    expect(verifySortition(other, SEED, 3, 9, 1000, 50_000, 64, p.pi)).toBeNull();
  });

  it('rejects a proof for a different epoch/shard (different alpha)', () => {
    const { priv, pub } = keyFromScalar(7);
    const p = proveSortition(priv, SEED, 3, 9, 1000, 50_000, 64);
    expect(verifySortition(pub, SEED, 4, 9, 1000, 50_000, 64, p.pi)).toBeNull();
    expect(verifySortition(pub, SEED, 3, 10, 1000, 50_000, 64, p.pi)).toBeNull();
  });

  it('a valid but non-winning draw verifies as 0 seats (not null)', () => {
    // Tiny weight vs a huge pool ⇒ almost certainly zero seats, but the proof is valid.
    const { priv, pub } = keyFromScalar(11);
    const p = proveSortition(priv, SEED, 1, 0, 1, 10_000_000, 1);
    expect(p.seats).toBe(0);
    expect(verifySortition(pub, SEED, 1, 0, 1, 10_000_000, 1, p.pi)).toBe(0);
  });

  it('selects everyone when committeeSize >= totalWeight (p clamped to 1)', () => {
    const beta = vrfProve(keyFromScalar(1).priv, sortitionAlpha(SEED, 0, 0)).beta;
    expect(seatsFromBeta(beta, 500, 100, 1000)).toBe(500); // units = round(weight)
  });

  it('expected committee size ≈ target across many equal-weight validators', () => {
    const N = 600;
    const weight = 100;
    const total = N * weight;
    const committeeSize = 60;
    let seats = 0;
    for (let i = 0; i < N; i++) {
      seats += proveSortition(keyFromScalar(i).priv, SEED, 5, 2, weight, total, committeeSize).seats;
    }
    // Mean = committeeSize (=60); allow a generous band for the random draw.
    expect(seats).toBeGreaterThan(35);
    expect(seats).toBeLessThan(95);
  });

  it('an attacker wins ≈ its weight share — a 40% adversary rarely takes a majority', () => {
    const N = 500;
    const committeeSize = 80;
    // 40% of validators are the attacker (equal individual weight ⇒ 40% of weight).
    const attackerCount = Math.round(N * 0.4);
    const weight = 100;
    const total = N * weight;
    let honest = 0;
    let attacker = 0;
    for (let i = 0; i < N; i++) {
      const s = proveSortition(keyFromScalar(i).priv, SEED, 9, 4, weight, total, committeeSize).seats;
      if (i < attackerCount) attacker += s;
      else honest += s;
    }
    const share = attacker / (attacker + honest);
    // ~0.40 expected; assert it lands well below the 2/3 a quorum would require.
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.55);
  });
});
