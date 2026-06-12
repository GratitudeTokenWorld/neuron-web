import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../core/keys.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { createOpenBlock, createBlock, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { proveDoubleSpend, verifyDoubleSpend } from './fraud.js';

function openAccount() {
  const k = generateKeyPair();
  const at = generateKeyPair();
  const c = deriveCommitment(k.pub.slice(0, 16), k.pub);
  const acc = new AccountAccumulator();
  const open = createOpenBlock(
    { accountId: k.pub, identityCommitment: c, attestations: [createAttestation('personhood', c, at)], timestamp: 1000 },
    k.priv,
    acc,
  );
  return { k, open };
}

function send(k: { pub: string; priv: string }, prevHash: string, shard: number, ts: number, recipient: string, amount: bigint): Block {
  const acc = new AccountAccumulator();
  acc.append(prevHash);
  return createBlock(
    { accountId: k.pub, index: 1, type: 'send', previousHash: prevHash, shard, timestamp: ts, balance: 1_000_000n - amount, recipient, amount },
    k.priv,
    acc,
  );
}

describe('double-spend fraud proof', () => {
  it('proves and independently verifies a genuine double-spend', () => {
    const { k, open } = openAccount();
    const a = send(k, open.hash, open.shard, 1001, 'aa', 100_000n);
    const b = send(k, open.hash, open.shard, 1002, 'bb', 200_000n); // same height, conflicting
    const ev = proveDoubleSpend(a, b);
    expect(ev).not.toBeNull();
    expect(verifyDoubleSpend(ev!)).toBe(true);
  });

  it('returns null for non-conflicting blocks at different heights', () => {
    const { k, open } = openAccount();
    const a = send(k, open.hash, open.shard, 1001, 'aa', 100_000n);
    const acc = new AccountAccumulator();
    acc.append(open.hash);
    acc.append(a.hash);
    const b = createBlock(
      { accountId: k.pub, index: 2, type: 'send', previousHash: a.hash, shard: open.shard, timestamp: 1002, balance: 800_000n, recipient: 'bb', amount: 100_000n },
      k.priv,
      acc,
    );
    expect(proveDoubleSpend(a, b)).toBeNull();
  });

  it('rejects evidence with a forged signature', () => {
    const { k, open } = openAccount();
    const a = send(k, open.hash, open.shard, 1001, 'aa', 100_000n);
    const b = send(k, open.hash, open.shard, 1002, 'bb', 200_000n);
    const ev = proveDoubleSpend(a, b)!;
    ev.b = { ...ev.b, signature: '00'.repeat(64) };
    expect(verifyDoubleSpend(ev)).toBe(false);
  });
});
