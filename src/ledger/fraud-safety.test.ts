import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';

/**
 * Phase 2 (fraud-proof safety): a block-lattice "conflict" is an account
 * equivocating — signing two blocks at the same index/previousHash (a
 * double-spend). It must freeze the account on every node that sees the
 * self-verifying evidence, with no committee/vote.
 */

const attester = generateKeyPair();

async function openAcct(ledger: EngineLedger, keys: SignerKeys, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  return ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
}

/** Craft an index-1 send off the open block (NOT applied) — like engine fraud.test.ts. */
function craftSend(keys: SignerKeys, open: Block, recipient: string, amount: bigint, ts: number): Block {
  const acc = new AccountAccumulator();
  acc.append(open.hash);
  return createBlock(
    { accountId: keys.pub, index: 1, type: 'send', previousHash: open.hash, shard: open.shard,
      timestamp: ts, balance: 1_000_000n - amount, recipient, amount },
    keys.priv,
    acc,
  );
}

describe('fraud-proof conflict safety', () => {
  it('freezes an equivocating account and rejects the conflicting blocks', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const open = await openAcct(ledger, alice, 'human-alice');

    const s1 = craftSend(alice, open, 'bob', 100_000n, 1001);
    const s2 = craftSend(alice, open, 'carol', 200_000n, 1002); // same height, conflicting
    expect(s1.index).toBe(s2.index);
    expect(s1.hash).not.toBe(s2.hash);

    expect(ledger.addBlock(s1).success).toBe(true);
    expect(ledger.addBlock(s2).success).toBe(false); // conflict detected

    expect(ledger.isEquivocated(alice.pub)).toBe(true);
    expect(ledger.getBlockStatus(s1.hash)).toBe('rejected'); // frozen account
    expect(ledger.getAccountBalance(alice.pub)).toBe(0);     // balance void
  });

  it('does not freeze a normal, non-conflicting chain', async () => {
    const ledger = new EngineLedger('testnet');
    const dave = generateKeyPair();
    await openAcct(ledger, dave, 'human-dave');
    const eve = generateKeyPair();
    ledger.registerAccount({ username: 'eve', pub: eve.pub });

    const s = (await ledger.createSend(dave.pub, eve.pub, 100, dave)).block!;
    expect(ledger.addBlock(s).success).toBe(true);
    expect(ledger.isEquivocated(dave.pub)).toBe(false);
    expect(ledger.getBlockStatus(s.hash)).toBe('confirmed');
  });

  it('applies verified network evidence, and rejects a non-conflict as evidence', async () => {
    const src = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const open = await openAcct(src, alice, 'human-alice2');
    const s1 = craftSend(alice, open, 'bob', 100_000n, 1001);
    const s2 = craftSend(alice, open, 'bob', 200_000n, 1002);

    // A node that never held the blocks freezes purely from the evidence.
    const fresh = new EngineLedger('testnet');
    expect(fresh.applyEvidenceFromBlocks(s1, s2)).toBe(true);
    expect(fresh.isEquivocated(alice.pub)).toBe(true);

    // The same block twice is not a double-spend → not accepted as evidence.
    const fresh2 = new EngineLedger('testnet');
    expect(fresh2.applyEvidenceFromBlocks(s1, s1)).toBe(false);
    expect(fresh2.isEquivocated(alice.pub)).toBe(false);
  });
});
