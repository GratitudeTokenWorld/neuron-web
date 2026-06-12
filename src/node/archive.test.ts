import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../core/keys.js';
import { AccountAccumulator, verifyInclusion } from '../core/accumulator.js';
import { createOpenBlock, createBlock, verifyBlock, encodeBlock, decodeBlock, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { ContentStore } from '../content/content-store.js';
import { BlockArchive } from './archive.js';
import { ArchivingStore } from './archiving-store.js';

function buildChain(len: number) {
  const k = generateKeyPair();
  const at = generateKeyPair();
  const c = deriveCommitment(k.pub.slice(0, 16), k.pub);
  const acc = new AccountAccumulator();
  const blocks: Block[] = [
    createOpenBlock({ accountId: k.pub, identityCommitment: c, attestations: [createAttestation('personhood', c, at)], timestamp: 1000 }, k.priv, acc),
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

describe('block encode/decode', () => {
  it('round-trips a block (bigint-safe) preserving verifiability', () => {
    const { blocks } = buildChain(2);
    for (const b of blocks) {
      const decoded = decodeBlock(encodeBlock(b));
      expect(decoded.balance).toBe(b.balance);
      expect(decoded.hash).toBe(b.hash);
      expect(verifyBlock(decoded)).toBe(true);
    }
  });
});

describe('archival tiering (invariant #7 — no destructive history loss)', () => {
  it('bounds hot memory, archives the rest, and keeps every block provable + retrievable', () => {
    const { k, blocks } = buildChain(300);
    const archiveStore = new ContentStore(50 * 1024 * 1024);
    const store = new ArchivingStore(new BlockArchive(archiveStore), 50);

    for (const b of blocks) expect(store.apply(b).ok).toBe(true);

    // Hot memory is bounded by the window; the rest is archived (nothing dropped).
    expect(store.hotCount()).toBe(50);
    expect(store.archivedCount()).toBe(250);
    expect(store.length(k.pub)).toBe(300);

    // An OLD archived block is fully recovered (no loss) and provable against the root.
    const pv = store.getProven(k.pub, 3);
    expect(pv).not.toBeNull();
    expect(verifyBlock(pv!.block)).toBe(true);
    expect(pv!.block.hash).toBe(blocks[3]!.hash);
    expect(verifyInclusion(pv!.root, pv!.block.hash, 3, pv!.treeSize, pv!.proof)).toBe(true);

    // A recent (hot) block is equally provable.
    const hot = store.getProven(k.pub, 299)!;
    expect(verifyInclusion(hot.root, hot.block.hash, 299, hot.treeSize, hot.proof)).toBe(true);
  });

  it('detects a corrupt/missing archived body on retrieval', () => {
    const { blocks } = buildChain(2);
    const store = new ContentStore(1024 * 1024);
    const archive = new BlockArchive(store);
    const ref = archive.archive(blocks[1]!);
    expect(archive.retrieve(ref)).not.toBeNull();
    // a reference to content the store doesn't hold → null
    expect(archive.retrieve({ ...ref, cid: 'deadbeef'.repeat(8) })).toBeNull();
    // a reference whose expected hash doesn't match the stored body → null
    expect(archive.retrieve({ ...ref, hash: '00'.repeat(32) })).toBeNull();
  });
});
