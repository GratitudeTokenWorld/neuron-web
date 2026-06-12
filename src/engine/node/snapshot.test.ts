import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../core/keys.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { createOpenBlock } from '../core/block.js';
import { createAttestation, type QuorumPolicy } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { getShard } from '../core/partition.js';
import { AccountStore } from './account-store.js';
import { createShardSnapshot, applyShardSnapshot } from './snapshot.js';

const at1 = generateKeyPair();
const at2 = generateKeyPair();
const policy: QuorumPolicy = { min: 2, requiredTypes: ['personhood', 'stake'] };

function openInto(store: AccountStore, numShards: number) {
  const k = generateKeyPair();
  const c = deriveCommitment(k.pub.slice(0, 16), k.pub);
  const acc = new AccountAccumulator();
  const open = createOpenBlock(
    { accountId: k.pub, identityCommitment: c, attestations: [createAttestation('personhood', c, at1), createAttestation('stake', c, at2)], timestamp: 1000, numShards },
    k.priv,
    acc,
  );
  store.apply(open);
  return k;
}

describe('per-shard snapshots', () => {
  it('snapshots only the target shard and bootstraps verified heads from proofs alone', () => {
    const numShards = 8;
    const store = new AccountStore();
    const first = openInto(store, numShards);
    for (let i = 0; i < 39; i++) openInto(store, numShards);

    const shard = getShard(first.pub, numShards);
    const snap = createShardSnapshot(store, shard, numShards);
    expect(snap.accounts.length).toBeGreaterThan(0);
    expect(snap.accounts.every((p) => getShard(p.openBlock.accountId, numShards) === shard)).toBe(true);

    const res = applyShardSnapshot(snap, policy);
    expect(res.rejected).toBe(0);
    expect(res.trusted.length).toBe(snap.accounts.length);
  });

  it('rejects a tampered head when applying a snapshot', () => {
    const store = new AccountStore();
    openInto(store, 1); // numShards 1 → everything in shard 0
    const snap = createShardSnapshot(store, 0, 1);
    snap.accounts[0]!.headBlock = { ...snap.accounts[0]!.headBlock, signature: '00'.repeat(64) };
    const res = applyShardSnapshot(snap, policy);
    expect(res.rejected).toBe(1);
    expect(res.trusted).toHaveLength(0);
  });
});
