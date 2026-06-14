import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, createOpenBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';

/**
 * Balance conservation in addBlock. Hash/signature/linkage all pass for a
 * self-signed block — only the arithmetic stops an account minting money from
 * nothing. The fraud-proof + committee layers do NOT cover this (a single,
 * internally-valid chain, no equivocation), so these checks are the soundness
 * floor of the ledger.
 */

const attester = generateKeyPair();
const MINT = 1_000_000_000n;

async function openAcct(ledger: EngineLedger, keys: SignerKeys, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  const open = await ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
  return open;
}

/** Craft an index-1 block off the open block with caller-controlled fields (not applied). */
function craft(keys: SignerKeys, open: Block, patch: Partial<Block>): Block {
  const acc = new AccountAccumulator();
  acc.append(open.hash);
  return createBlock(
    {
      accountId: keys.pub, index: 1, type: 'send', previousHash: open.hash, shard: open.shard,
      timestamp: 1, balance: MINT, ...patch,
    } as Block,
    keys.priv,
    acc,
  );
}

describe('balance conservation', () => {
  it('rejects an open that mints more than the genesis amount', () => {
    const ledger = new EngineLedger('testnet');
    const eve = generateKeyPair();
    const commitment = deriveCommitment('eve', eve.pub);
    const acc = new AccountAccumulator();
    const forgedOpen = createOpenBlock(
      { accountId: eve.pub, identityCommitment: commitment,
        attestations: [createAttestation('personhood', commitment, attester)],
        timestamp: 1, balance: MINT * 1000n },
      eve.priv,
      acc,
    );
    const r = ledger.addBlock(forgedOpen);
    expect(r.success).toBe(false);
    expect(r.error).toBe('open must mint exactly the genesis amount');
    expect(ledger.getAccountBalance(eve.pub)).toBe(0);
  });

  it('rejects a send that inflates its own balance', async () => {
    const ledger = new EngineLedger('testnet');
    const eve = generateKeyPair();
    const open = await openAcct(ledger, eve, 'eve');
    // Claim a huge balance while "sending" 1 unit — the classic self-mint.
    const inflate = craft(eve, open, { type: 'send', recipient: 'x', amount: 1n, balance: MINT * 1_000_000n });
    const r = ledger.addBlock(inflate);
    expect(r.success).toBe(false);
    expect(r.error).toBe('send balance inconsistent');
    expect(ledger.getAccountBalance(eve.pub)).toBe(Number(MINT)); // unchanged
  });

  it('rejects a send with non-positive amount', async () => {
    const ledger = new EngineLedger('testnet');
    const eve = generateKeyPair();
    const open = await openAcct(ledger, eve, 'eve');
    const r = ledger.addBlock(craft(eve, open, { type: 'send', recipient: 'x', amount: 0n, balance: MINT }));
    expect(r.success).toBe(false);
    expect(r.error).toBe('send amount must be positive');
  });

  it('accepts a correctly-balanced send', async () => {
    const ledger = new EngineLedger('testnet');
    const eve = generateKeyPair();
    const open = await openAcct(ledger, eve, 'eve');
    const ok = craft(eve, open, { type: 'send', recipient: 'x', amount: 100n, balance: MINT - 100n });
    expect(ledger.addBlock(ok).success).toBe(true);
  });

  it('rejects a receive whose balance delta != amount', async () => {
    const ledger = new EngineLedger('testnet');
    const eve = generateKeyPair();
    const open = await openAcct(ledger, eve, 'eve');
    const r = ledger.addBlock(craft(eve, open, { type: 'receive', sourceHash: 'deadbeef', amount: 1n, balance: MINT + 999n }));
    expect(r.success).toBe(false);
    expect(r.error).toBe('receive balance inconsistent');
  });

  it('rejects a receive that over-claims a known source send', async () => {
    const ledger = new EngineLedger('testnet');
    // Alice really sends Bob 100.
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(ledger, alice, 'alice');
    const bobOpen = await openAcct(ledger, bob, 'bob');
    ledger.registerAccount({ username: 'bob', pub: bob.pub });
    const send = (await ledger.createSend(alice.pub, bob.pub, 100, alice)).block!;
    expect(ledger.addBlock(send).success).toBe(true); // ledger now holds the source send

    // Bob crafts a receive claiming +1_000_000 from Alice's 100-unit send.
    const acc = new AccountAccumulator();
    acc.append(bobOpen.hash);
    const greedy = createBlock(
      { accountId: bob.pub, index: 1, type: 'receive', previousHash: bobOpen.hash, shard: bobOpen.shard,
        timestamp: 2, balance: MINT + 1_000_000n, sourceHash: send.hash, amount: 1_000_000n },
      bob.priv,
      acc,
    );
    const r = ledger.addBlock(greedy);
    expect(r.success).toBe(false);
    expect(r.error).toBe('receive does not match source send');
  });
});
