import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { type Block } from '../engine/core/block.js';

/**
 * B3: blocks denormalize the counterparty (pub + point-in-time username) so a
 * recipient can show "from alice" without holding the sender's chain (the
 * interest-scoped scale invariant means it discards that chain after claiming).
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

describe('counterparty denormalization', () => {
  it('a send carries the recipient name; a receive carries the sender pub + name', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(ledger, alice, 'alice', 'human-alice');
    await openAcct(ledger, bob, 'bob', 'human-bob');

    const send = (await ledger.createSend(alice.pub, 'bob', 100, alice)).block!;
    expect(send.recipient).toBe(bob.pub);
    expect(send.recipientName).toBe('bob');

    const recv = (await ledger.createReceive(bob.pub, send.hash, bob)).block!;
    expect(recv.senderPub).toBe(alice.pub);
    expect(recv.senderName).toBe('alice');
  });

  it('survives the wire round-trip (denormalized fields are part of the signed content)', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(ledger, alice, 'alice', 'human-alice');
    await openAcct(ledger, bob, 'bob', 'human-bob');
    const send = (await ledger.createSend(alice.pub, 'bob', 100, alice)).block!;
    const recv = (await ledger.createReceive(bob.pub, send.hash, bob)).block!;

    // A second node that holds neither chain can still ingest + read the sender.
    const dst = new EngineLedger('testnet');
    for (const k of [alice, bob]) expect(dst.addBlock(ledger.getAccountChain(k.pub)[0]!).success).toBe(true);
    expect(dst.addBlock(send).success).toBe(true);
    expect(dst.addBlock(recv).success).toBe(true);
    const stored = dst.getBlock(recv.hash)!;
    expect(stored.senderPub).toBe(alice.pub);
    expect(stored.senderName).toBe('alice');
  });

  it('an nft transfer denormalizes the counterparty too', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(ledger, alice, 'alice', 'human-alice');
    await openAcct(ledger, bob, 'bob', 'human-bob');
    const { tokenId } = await ledger.createMintNft(alice.pub, 'cid-1', { name: 'art' }, alice);
    const send = (await ledger.createTransferNft(alice.pub, tokenId!, 'bob', alice)).block!;
    expect(send.recipientName).toBe('bob');
    const recv = (await ledger.createReceiveNft(bob.pub, send.hash, bob)).block!;
    expect(recv.senderPub).toBe(alice.pub);
    expect(recv.senderName).toBe('alice');
  });
});
