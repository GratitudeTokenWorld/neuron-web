import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';

/**
 * On-chain account-update block (un-defers EngineLedger.createUpdate): a signed
 * metadata patch on the account's own chain, balance-preserving and ordered like
 * any other block — the verifiable replacement for off-chain account-record sync.
 */

const attester = generateKeyPair();

async function openAcct(ledger: EngineLedger, keys: SignerKeys, username: string, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  const open = await ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
  ledger.registerAccount({ username, pub: keys.pub });
  return open;
}

describe('account-update block', () => {
  it('updates the username on-chain and re-indexes the lookup', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'alice', 'human-alice');

    const r = await ledger.createUpdate(alice.pub, { username: 'alice2', bio: 'gm' }, alice);
    expect(r.block?.type).toBe('update');
    expect(ledger.getAccountByUsername('alice2')?.pub).toBe(alice.pub);
    expect(ledger.getAccountByUsername('alice')).toBeUndefined(); // old name freed
    expect(ledger.resolveToPublicKey('alice2')).toBe(alice.pub);
  });

  it('preserves balance and chains after the prior head', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const open = await openAcct(ledger, alice, 'a', 'human-a');
    const before = ledger.getAccountBalance(alice.pub);

    const r = await ledger.createUpdate(alice.pub, { displayName: 'Alice' }, alice);
    expect(r.block!.index).toBe(open.index + 1);
    expect(r.block!.previousHash).toBe(open.hash);
    expect(r.block!.balance).toBe(open.balance);
    expect(ledger.getAccountBalance(alice.pub)).toBe(before); // unchanged
  });

  it('applies a foreign update block on another node', async () => {
    const src = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(src, alice, 'alice', 'human-alice');
    const update = (await src.createUpdate(alice.pub, { username: 'alice_x', avatar: 'cid123' }, alice)).block!;

    // A second node that already holds alice's open block ingests the update.
    const dst = new EngineLedger('testnet');
    const openBlock = src.getAccountChain(alice.pub)[0]!;
    expect(dst.addBlock(openBlock).success).toBe(true);
    dst.registerAccount({ username: 'alice', pub: alice.pub });
    expect(dst.addBlock(update).success).toBe(true);
    expect(dst.getAccountByUsername('alice_x')?.pub).toBe(alice.pub);
  });

  it('rejects an update block that tampers with balance', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const open = await openAcct(ledger, alice, 'a', 'human-a');

    // Craft a balance-inflating "update" off the open block.
    const acc = new AccountAccumulator();
    acc.append(open.hash);
    const evil = createBlock(
      { accountId: alice.pub, index: 1, type: 'update', previousHash: open.hash, shard: open.shard,
        timestamp: 2, balance: open.balance + 999_999n, updates: { username: 'rich' } },
      alice.priv,
      acc,
    );
    const res = ledger.addBlock(evil);
    expect(res.success).toBe(false);
    expect(res.error).toBe('update must preserve balance');
    expect(ledger.getAccountByUsername('rich')).toBeUndefined();
  });

  it('refuses updates on an unopened or frozen account', async () => {
    const ledger = new EngineLedger('testnet');
    const ghost = generateKeyPair();
    expect((await ledger.createUpdate(ghost.pub, { bio: 'x' }, ghost)).error).toBe('Account not opened');

    const alice = generateKeyPair();
    const open = await openAcct(ledger, alice, 'a', 'human-a');
    // Force-freeze alice via a double-spend, then confirm updates are barred.
    const mk = (recipient: string, amount: bigint, ts: number) => {
      const acc = new AccountAccumulator();
      acc.append(open.hash);
      return createBlock(
        { accountId: alice.pub, index: 1, type: 'send', previousHash: open.hash, shard: open.shard,
          timestamp: ts, balance: open.balance - amount, recipient, amount },
        alice.priv, acc,
      );
    };
    ledger.addBlock(mk('b', 1n, 1));
    ledger.addBlock(mk('c', 2n, 2)); // conflicting → freezes alice
    expect(ledger.isEquivocated(alice.pub)).toBe(true);
    expect((await ledger.createUpdate(alice.pub, { bio: 'x' }, alice)).error).toBe('Account frozen');
  });
});
