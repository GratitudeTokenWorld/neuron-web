import { describe, it, expect } from 'vitest';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { VERIFICATION_MINT_AMOUNT } from '../core/dag-block.js';
import { EngineLedger, type OpenIdentity } from './engine-ledger.js';

const attester = generateKeyPair();

function identityFor(pub: string, human: string): OpenIdentity {
  const commitment = deriveCommitment(human, pub);
  return { nullifier: human, attestations: [createAttestation('personhood', commitment, attester)] };
}

describe('EngineLedger (core flow on the new engine)', () => {
  it('opens accounts, deduplicates by human, and mints the genesis balance', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    ledger.registerAccount({ username: 'alice', pub: alice.pub });
    const open = await ledger.openAccount(alice.pub, alice, identityFor(alice.pub, 'human-alice'));

    expect(open.type).toBe('open');
    expect(ledger.getAccountBalance(alice.pub)).toBe(VERIFICATION_MINT_AMOUNT);
    expect(ledger.getAccountHead(alice.pub)!.shard).toBe(ledger.getShardOf(alice.pub));

    // same human, different key → rejected (one human, one account)
    const alice2 = generateKeyPair();
    await expect(ledger.openAccount(alice2.pub, alice2, identityFor(alice2.pub, 'human-alice'))).rejects.toThrow(/already used/);
  });

  it('sends and receives between accounts, tracking balances and unclaimed sends', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    ledger.registerAccount({ username: 'alice', pub: alice.pub });
    ledger.registerAccount({ username: 'bob', pub: bob.pub });
    await ledger.openAccount(alice.pub, alice, identityFor(alice.pub, 'human-alice'));
    await ledger.openAccount(bob.pub, bob, identityFor(bob.pub, 'human-bob'));

    const send = await ledger.createSend(alice.pub, 'bob', 250_000, alice);
    expect(send.error).toBeUndefined();
    expect(ledger.getAccountBalance(alice.pub)).toBe(VERIFICATION_MINT_AMOUNT - 250_000);
    expect(ledger.getUnclaimedForAccount(bob.pub)).toHaveLength(1);

    const recv = await ledger.createReceive(bob.pub, send.block!.hash, bob);
    expect(recv.error).toBeUndefined();
    expect(ledger.getAccountBalance(bob.pub)).toBe(VERIFICATION_MINT_AMOUNT + 250_000);
    expect(ledger.getUnclaimedForAccount(bob.pub)).toHaveLength(0);
  });

  it('rejects an overspend', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    ledger.registerAccount({ username: 'bob', pub: bob.pub });
    await ledger.openAccount(alice.pub, alice, identityFor(alice.pub, 'human-alice'));
    const r = await ledger.createSend(alice.pub, bob.pub, VERIFICATION_MINT_AMOUNT + 1, alice);
    expect(r.error).toMatch(/Insufficient/);
  });

  it('applies remote blocks from peers (open + send) and confirms them', async () => {
    // Source ledger builds a chain; a second ledger applies the same blocks as a peer would.
    const src = new EngineLedger('testnet');
    const dst = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const open = await src.openAccount(alice.pub, alice, identityFor(alice.pub, 'human-alice'));
    src.registerAccount({ username: 'bob', pub: bob.pub });
    const send = await src.createSend(alice.pub, bob.pub, 100_000, alice);

    expect(dst.addBlock(open).success).toBe(true);
    expect(dst.addBlock(send.block!).success).toBe(true);
    expect(dst.getAccountBalance(alice.pub)).toBe(VERIFICATION_MINT_AMOUNT - 100_000);
    expect(dst.getUnclaimedForAccount(bob.pub)).toHaveLength(1);
  });
});
