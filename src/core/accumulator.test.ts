import { describe, it, expect } from 'vitest';
import { AccountAccumulator, verifyInclusion } from './accumulator.js';
import { hash } from './hash.js';

function leaf(i: number): Uint8Array {
  return hash(new Uint8Array([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff]));
}

describe('AccountAccumulator', () => {
  it('inclusion proofs verify for every index across many tree sizes', () => {
    for (let size = 1; size <= 33; size++) {
      const acc = new AccountAccumulator();
      const leaves: Uint8Array[] = [];
      for (let i = 0; i < size; i++) {
        const l = leaf(i);
        leaves.push(l);
        acc.append(l);
      }
      const root = acc.rootHex();
      for (let idx = 0; idx < size; idx++) {
        const proof = acc.proofHex(idx);
        expect(verifyInclusion(root, leaves[idx]!, idx, size, proof)).toBe(true);
        // wrong leaf must fail
        expect(verifyInclusion(root, leaf(9999), idx, size, proof)).toBe(false);
        // wrong index must fail
        if (size > 1) {
          expect(verifyInclusion(root, leaves[idx]!, (idx + 1) % size, size, proof)).toBe(false);
        }
      }
    }
  });

  it('produces a deterministic, order-sensitive root', () => {
    const a = new AccountAccumulator();
    a.append(leaf(1));
    a.append(leaf(2));
    const b = new AccountAccumulator();
    b.append(leaf(1));
    b.append(leaf(2));
    const c = new AccountAccumulator();
    c.append(leaf(2));
    c.append(leaf(1));
    expect(a.rootHex()).toBe(b.rootHex());
    expect(a.rootHex()).not.toBe(c.rootHex());
  });

  it('changes the root on every append', () => {
    const acc = new AccountAccumulator();
    acc.append(leaf(1));
    const r1 = acc.rootHex();
    acc.append(leaf(2));
    expect(acc.rootHex()).not.toBe(r1);
    expect(acc.size).toBe(2);
  });

  it('rejects a proof against the wrong root', () => {
    const acc = new AccountAccumulator();
    for (let i = 0; i < 8; i++) acc.append(leaf(i));
    const proof = acc.proofHex(3);
    const wrongRoot = '00'.repeat(32);
    expect(verifyInclusion(wrongRoot, leaf(3), 3, 8, proof)).toBe(false);
  });
});
