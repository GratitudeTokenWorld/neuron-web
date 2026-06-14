import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';
import { votingWeight } from '../engine/consensus/weight.js';

/**
 * Phase 2 step 2 (V4): validator state wired into EngineLedger — opt-in bonding of
 * the free mint (locked while bonded), activity-age credited per epoch, slashing on
 * a double-spend, and the accumulated-VRF epoch seed.
 */

const attester = generateKeyPair();
/** The ledger mints in milli-UNIT scale (VERIFICATION_MINT_AMOUNT = 1e6 UNIT × 1000). */
const MINT = 1_000_000_000n;

async function openAcct(
  ledger: EngineLedger,
  keys: SignerKeys,
  nullifier: string,
  opts?: { bond?: boolean },
): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  return ledger.openAccount(
    keys.pub,
    keys,
    { nullifier, attestations: [createAttestation('personhood', commitment, attester)] },
    opts,
  );
}

/** Craft an index-1 conflicting send off the open block (not applied). */
function craftSend(keys: SignerKeys, open: Block, recipient: string, amount: bigint, ts: number): Block {
  const acc = new AccountAccumulator();
  acc.append(open.hash);
  return createBlock(
    { accountId: keys.pub, index: 1, type: 'send', previousHash: open.hash, shard: open.shard,
      timestamp: ts, balance: MINT - amount, recipient, amount },
    keys.priv,
    acc,
  );
}

describe('validator state in EngineLedger', () => {
  it('opening with bond makes the account a validator with positive weight', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'human-alice', { bond: true });

    expect(ledger.isValidator(alice.pub)).toBe(true);
    expect(ledger.bondedOf(alice.pub)).toBe(MINT);
    expect(ledger.validatorWeight(alice.pub)).toBeGreaterThan(0);
    expect(ledger.totalValidatorWeight()).toBeCloseTo(ledger.validatorWeight(alice.pub));
  });

  it('opening without bond is a zero-weight non-validator', async () => {
    const ledger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(ledger, bob, 'human-bob');
    expect(ledger.isValidator(bob.pub)).toBe(false);
    expect(ledger.validatorWeight(bob.pub)).toBe(0);
  });

  it('bonded stake is locked — it cannot be spent', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'human-lock', { bond: true });
    const bob = generateKeyPair();
    ledger.registerAccount({ username: 'bob', pub: bob.pub });

    // Entire mint is bonded ⇒ no free balance ⇒ any send is rejected.
    const r = await ledger.createSend(alice.pub, bob.pub, 1, alice);
    expect(r.error).toBe('Insufficient balance');
    expect(r.block).toBeUndefined();
  });

  it('only free (un-bonded) balance is spendable', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'human-partial');
    const bob = generateKeyPair();
    ledger.registerAccount({ username: 'bob', pub: bob.pub });

    ledger.bondStake(alice.pub, MINT - 500n); // leave 500 free
    expect((await ledger.createSend(alice.pub, bob.pub, 600, alice)).error).toBe('Insufficient balance');
    expect((await ledger.createSend(alice.pub, bob.pub, 400, alice)).block).toBeDefined();
  });

  it('advancing epochs credits activity-age, raising voting weight', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'human-age', { bond: true });

    const before = ledger.validatorWeight(alice.pub);
    for (let i = 0; i < 10; i++) ledger.advanceEpoch([], [alice.pub]);
    expect(ledger.currentEpoch).toBe(10);
    expect(ledger.validatorWeight(alice.pub)).toBeGreaterThan(before);
    expect(ledger.validatorWeight(alice.pub)).toBeCloseTo(votingWeight(MINT, 10));
  });

  it('a double-spend slashes the bonded validator (weight → 0, barred)', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const open = await openAcct(ledger, alice, 'human-slash', { bond: true });
    expect(ledger.validatorWeight(alice.pub)).toBeGreaterThan(0);

    const s1 = craftSend(alice, open, 'bob', 100_000n, 1001);
    const s2 = craftSend(alice, open, 'carol', 200_000n, 1002); // same-height fork
    expect(ledger.addBlock(s1).success).toBe(true);
    expect(ledger.addBlock(s2).success).toBe(false);

    expect(ledger.isEquivocated(alice.pub)).toBe(true);
    expect(ledger.isSlashed(alice.pub)).toBe(true);
    expect(ledger.validatorWeight(alice.pub)).toBe(0);
    expect(ledger.bondedOf(alice.pub)).toBe(0n);
    expect(ledger.totalValidatorWeight()).toBe(0);
  });

  it('the epoch seed advances and is reproducible from committed betas', async () => {
    const ledger = new EngineLedger('testnet');
    const genesis = ledger.currentSeed();
    ledger.advanceEpoch([], []);
    const next = ledger.currentSeed();
    expect(next).not.toBe(genesis);
    expect(ledger.seedFor(0)).toBe(genesis);
    expect(ledger.seedFor(1)).toBe(next);
  });

  it('reset clears validator + epoch state', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(ledger, alice, 'human-reset', { bond: true });
    ledger.advanceEpoch([], [alice.pub]);

    ledger.reset();
    expect(ledger.currentEpoch).toBe(0);
    expect(ledger.isValidator(alice.pub)).toBe(false);
    expect(ledger.totalValidatorWeight()).toBe(0);
  });
});
