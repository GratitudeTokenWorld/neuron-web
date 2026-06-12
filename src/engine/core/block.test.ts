import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './keys.js';
import { AccountAccumulator } from './accumulator.js';
import { createOpenBlock, createBlock, verifyBlock, MINT_AMOUNT, GENESIS_PREV } from './block.js';
import { createAttestation } from './attestation.js';
import { deriveCommitment } from './identity.js';

function openAccount() {
  const account = generateKeyPair();
  const attester = generateKeyPair();
  const nullifier = account.pub.slice(0, 16);
  const commitment = deriveCommitment(nullifier, account.pub);
  const attestations = [createAttestation('personhood', commitment, attester)];
  const acc = new AccountAccumulator();
  const open = createOpenBlock(
    { accountId: account.pub, identityCommitment: commitment, attestations, timestamp: 1000 },
    account.priv,
    acc,
  );
  return { account, acc, open };
}

describe('block', () => {
  it('builds a verifiable open block with the free mint and genesis parent', () => {
    const { open } = openAccount();
    expect(verifyBlock(open)).toBe(true);
    expect(open.balance).toBe(MINT_AMOUNT);
    expect(open.previousHash).toBe(GENESIS_PREV);
    expect(open.index).toBe(0);
    expect(open.type).toBe('open');
  });

  it('fails verification when content is tampered', () => {
    const { open } = openAccount();
    expect(verifyBlock({ ...open, balance: open.balance + 1n })).toBe(false);
  });

  it('fails verification when the signature is replaced', () => {
    const { open } = openAccount();
    expect(verifyBlock({ ...open, signature: '00'.repeat(64) })).toBe(false);
  });

  it('appends a send block that chains from the previous block', () => {
    const { account, acc, open } = openAccount();
    const send = createBlock(
      {
        accountId: account.pub,
        index: 1,
        type: 'send',
        previousHash: open.hash,
        shard: open.shard,
        timestamp: 1001,
        balance: open.balance - 100n,
        recipient: 'cc33',
        amount: 100n,
      },
      account.priv,
      acc,
    );
    expect(verifyBlock(send)).toBe(true);
    expect(send.previousHash).toBe(open.hash);
    expect(send.accumulatorRoot).not.toBe(open.accumulatorRoot);
  });
});
