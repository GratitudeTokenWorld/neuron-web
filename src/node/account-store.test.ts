import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../core/keys.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { createOpenBlock, createBlock, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { AccountStore } from './account-store.js';

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
        {
          accountId: k.pub,
          index: i,
          type: 'send',
          previousHash: blocks[i - 1]!.hash,
          shard: blocks[0]!.shard,
          timestamp: 1000 + i,
          balance: 1_000_000n - BigInt(i),
          recipient: '00',
          amount: 1n,
        },
        k.priv,
        acc,
      ),
    );
  }
  return { k, blocks, acc };
}

describe('AccountStore', () => {
  it('applies a chain in order', () => {
    const { k, blocks } = buildChain(4);
    const store = new AccountStore();
    for (const b of blocks) expect(store.apply(b).ok).toBe(true);
    expect(store.blockCount()).toBe(4);
    expect(store.accountCount()).toBe(1);
    expect(store.head(k.pub)!.index).toBe(3);
  });

  it('rejects a non-genesis block before the genesis is seen', () => {
    const { blocks } = buildChain(2);
    const store = new AccountStore();
    const r = store.apply(blocks[1]!);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/genesis/);
  });

  it('is idempotent on a re-applied block', () => {
    const { blocks } = buildChain(2);
    const store = new AccountStore();
    store.apply(blocks[0]!);
    store.apply(blocks[1]!);
    expect(store.apply(blocks[1]!).ok).toBe(true);
    expect(store.blockCount()).toBe(2);
  });

  it('rejects a forged accumulator root', () => {
    const { k, blocks } = buildChain(1);
    const store = new AccountStore();
    store.apply(blocks[0]!);
    // A correctly-signed index-1 block built on a DIFFERENT (bogus) accumulator history.
    const bogus = new AccountAccumulator();
    bogus.append('ab'.repeat(32));
    const bad = createBlock(
      {
        accountId: k.pub,
        index: 1,
        type: 'send',
        previousHash: blocks[0]!.hash,
        shard: blocks[0]!.shard,
        timestamp: 1001,
        balance: 999_999n,
        recipient: '00',
        amount: 1n,
      },
      k.priv,
      bogus,
    );
    const r = store.apply(bad);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/accumulator/);
  });

  it('rejects a conflicting block at an existing height', () => {
    const { k, blocks } = buildChain(2);
    const store = new AccountStore();
    store.apply(blocks[0]!);
    store.apply(blocks[1]!);
    // alternate index-1 block on a correct accumulator (different timestamp → different hash)
    const acc2 = new AccountAccumulator();
    acc2.append(blocks[0]!.hash);
    const fork = createBlock(
      {
        accountId: k.pub,
        index: 1,
        type: 'send',
        previousHash: blocks[0]!.hash,
        shard: blocks[0]!.shard,
        timestamp: 9999,
        balance: 999_999n,
        recipient: '00',
        amount: 1n,
      },
      k.priv,
      acc2,
    );
    const r = store.apply(fork);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/conflicting|stale/);
  });
});
