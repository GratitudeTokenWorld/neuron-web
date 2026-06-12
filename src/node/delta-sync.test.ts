import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../core/keys.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { createOpenBlock, createBlock, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { AccountStore } from './account-store.js';
import { serveDelta, deltaRequestFor, syncAccount } from './delta-sync.js';

function buildChain(len: number) {
  const k = generateKeyPair();
  const at = generateKeyPair();
  const c = deriveCommitment(k.pub.slice(0, 16), k.pub);
  const acc = new AccountAccumulator();
  const blocks: Block[] = [
    createOpenBlock(
      { accountId: k.pub, identityCommitment: c, attestations: [createAttestation('personhood', c, at)], timestamp: 1000 },
      k.priv,
      acc,
    ),
  ];
  for (let i = 1; i < len; i++) {
    blocks.push(
      createBlock(
        { accountId: k.pub, index: i, type: 'send', previousHash: blocks[i - 1]!.hash, shard: blocks[0]!.shard, timestamp: 1000 + i, balance: 1_000_000n - BigInt(i), recipient: '00', amount: 1n },
        k.priv,
        acc,
      ),
    );
  }
  return { k, blocks };
}

describe('account-scoped delta sync', () => {
  it('syncs a whole account into an empty store', () => {
    const { k, blocks } = buildChain(5);
    const source = new AccountStore();
    for (const b of blocks) source.apply(b);

    const dest = new AccountStore();
    const res = syncAccount(dest, source, k.pub);
    expect(res.applied).toBe(5);
    expect(dest.head(k.pub)!.index).toBe(4);
  });

  it('serves and applies only the tail past what the destination already holds', () => {
    const { k, blocks } = buildChain(5);
    const source = new AccountStore();
    for (const b of blocks) source.apply(b);

    const dest = new AccountStore();
    dest.apply(blocks[0]!);
    dest.apply(blocks[1]!); // dest holds indices 0,1

    const req = deltaRequestFor(dest, k.pub);
    expect(req.haveIndex).toBe(1);
    const delta = serveDelta(source, req);
    expect(delta.map((b) => b.index)).toEqual([2, 3, 4]);

    const res = syncAccount(dest, source, k.pub);
    expect(res.applied).toBe(3);
    expect(dest.head(k.pub)!.index).toBe(4);
  });

  it('reads only the requested account (cost is O(tail), not O(store))', () => {
    const a = buildChain(3);
    const b = buildChain(3);
    const source = new AccountStore();
    for (const blk of [...a.blocks, ...b.blocks]) source.apply(blk);

    // Requesting account a returns exactly a's chain — b is untouched.
    const delta = serveDelta(source, { accountId: a.k.pub, haveIndex: -1 });
    expect(delta.every((blk) => blk.accountId === a.k.pub)).toBe(true);
    expect(delta.length).toBe(3);
  });
});
