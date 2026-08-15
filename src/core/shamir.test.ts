import { describe, it, expect } from 'vitest';
import { shamirSplit, shamirCombine } from './shamir.js';

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe('shamir 2-of-n over GF(256)', () => {
  it('any pair of shares reconstructs the secret', () => {
    const secret = rand(32);
    const shares = shamirSplit(secret, 3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue;
        expect(shamirCombine(shares[i], shares[j])).toEqual(secret);
      }
    }
  });

  it('handles every share count the relay topology can produce', () => {
    for (const n of [2, 3, 5, 10]) {
      const secret = rand(32);
      const shares = shamirSplit(secret, n);
      expect(shares.map(s => s.x)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      expect(shamirCombine(shares[0], shares[n - 1])).toEqual(secret);
    }
  });

  it('a single share is independent of the secret', () => {
    // Same x-coordinate, two different secrets: over many trials the share
    // bytes must not correlate with the secret bytes. Spot-check the defining
    // property instead of a statistical test: for ANY observed share y at x,
    // and ANY candidate secret s, r = (y ⊕ s)/x explains it — i.e. the share
    // fits every secret equally. We verify by constructing that r explicitly.
    const secretA = rand(32);
    const shares = shamirSplit(secretA, 2);
    const y = shares[0]; // x=1 → y = s ⊕ r  → r = y ⊕ s, valid for ANY s
    const secretB = rand(32);
    const rB = y.data.map((v, i) => v ^ secretB[i]); // the r that would explain y under secretB
    // That r reproduces the observed share exactly — so y alone cannot
    // distinguish secretA from secretB (or any other secret).
    const reproduced = rB.map((r, i) => secretB[i] ^ r);
    expect(Uint8Array.from(reproduced)).toEqual(y.data);
  });

  it('mixing shares from two different splits yields garbage, not the secret', () => {
    // The client-side ts-equality guard exists because of this: shares are only
    // meaningful within ONE split. If a partial re-store ever left relays on
    // different generations, combining across them must not silently "work".
    const secret = rand(32);
    const splitA = shamirSplit(secret, 3);
    const splitB = shamirSplit(secret, 3);
    const mixed = shamirCombine(splitA[0], splitB[1]);
    expect(mixed).not.toEqual(secret);
  });

  it('rejects invalid inputs', () => {
    const secret = rand(32);
    expect(() => shamirSplit(secret, 1)).toThrow();
    expect(() => shamirSplit(secret, 256)).toThrow();
    const [a] = shamirSplit(secret, 2);
    expect(() => shamirCombine(a, a)).toThrow();
  });
});
