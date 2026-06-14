import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair, publicKeyFromPrivate } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';
import { bytesToHex, type Hex } from '../engine/core/hash.js';
import { castCommitteeVote } from '../engine/consensus/finality.js';

/**
 * Phase 2 step 2 (V5): committee finality wired into the ledger. Real bonded
 * validators self-sort and vote a block to `final` — the status above optimistic
 * `confirmed` — and a vote-equivocating member is slashed.
 *
 * Deterministic keys make the VRF draws reproducible: 8 equal-weight validators
 * yield ~65 committee seats (quorum is ⌈2/3·64⌉ = 43) and any single validator
 * holds well under quorum, so the tests are stable, not statistical.
 */

const attester = generateKeyPair();
const MINT = 1_000_000_000n;

/** Deterministic engine key from a small scalar. */
function keyFromScalar(i: number): SignerKeys {
  const bytes = new Uint8Array(32);
  let x = BigInt(i + 101);
  for (let j = 31; j >= 0; j--) {
    bytes[j] = Number(x & 0xffn);
    x >>= 8n;
  }
  const priv = bytesToHex(bytes);
  return { priv, pub: publicKeyFromPrivate(priv) };
}

async function openAcct(ledger: EngineLedger, keys: SignerKeys, nullifier: string, bond: boolean): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  return ledger.openAccount(
    keys.pub,
    keys,
    { nullifier, attestations: [createAttestation('personhood', commitment, attester)] },
    { bond },
  );
}

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

function vote(ledger: EngineLedger, voter: SignerKeys, block: { hash: Hex; shard: number }) {
  return castCommitteeVote(
    voter.priv,
    voter.pub,
    block,
    ledger.currentSeed(),
    ledger.currentEpoch,
    ledger.validatorWeight(voter.pub),
    ledger.totalValidatorWeight(),
    ledger.committeeSize,
  );
}

describe('committee finality in EngineLedger', () => {
  it('a bonded committee finalizes a block to `final`', async () => {
    const ledger = new EngineLedger('testnet');
    const validators = Array.from({ length: 8 }, (_, i) => keyFromScalar(i));
    for (let i = 0; i < validators.length; i++) await openAcct(ledger, validators[i]!, `val-${i}`, true);

    // A non-validator payer (unbonded ⇒ spendable) sends; the committee finalizes it.
    const payer = keyFromScalar(50);
    await openAcct(ledger, payer, 'payer', false);
    const recipient = generateKeyPair();
    ledger.registerAccount({ username: 'rcpt', pub: recipient.pub });
    const send = (await ledger.createSend(payer.pub, recipient.pub, 1000, payer)).block!;
    expect(send).toBeDefined();
    expect(ledger.getBlockStatus(send.hash)).toBe('confirmed'); // optimistic, pre-finality

    let finalized = false;
    for (const v of validators) {
      const cv = vote(ledger, v, send);
      if (!cv) continue; // didn't win seats this draw
      const r = ledger.applyCommitteeVote(cv);
      if (r.finalized === send.hash) finalized = true;
    }

    expect(finalized).toBe(true);
    expect(ledger.isFinal(send.hash)).toBe(true);
    expect(ledger.getBlockStatus(send.hash)).toBe('final');
  });

  it('verifies a late, cross-epoch vote against the epoch weight snapshot', async () => {
    const ledger = new EngineLedger('testnet');
    const validators = Array.from({ length: 8 }, (_, i) => keyFromScalar(i));
    for (let i = 0; i < validators.length; i++) await openAcct(ledger, validators[i]!, `val-${i}`, true);

    // Move to epoch 1 (freezes the epoch-1 weight snapshot), then cast votes there.
    ledger.advanceEpoch([], validators.map((v) => v.pub));
    expect(ledger.currentEpoch).toBe(1);

    const payer = keyFromScalar(50);
    await openAcct(ledger, payer, 'payer', false);
    const recipient = generateKeyPair();
    ledger.registerAccount({ username: 'rcpt', pub: recipient.pub });
    const send = (await ledger.createSend(payer.pub, recipient.pub, 1000, payer)).block!;
    const epoch1Votes = validators.map((v) => vote(ledger, v, send)).filter(Boolean) as NonNullable<ReturnType<typeof vote>>[];

    // Time passes: advance two more epochs (weights drift via activity credit) before
    // the epoch-1 votes are finally applied. They must still verify (snapshot, not live).
    ledger.advanceEpoch([], validators.map((v) => v.pub));
    ledger.advanceEpoch([], validators.map((v) => v.pub));
    expect(ledger.currentEpoch).toBe(3);

    let finalized = false;
    for (const v of epoch1Votes) {
      const r = ledger.applyCommitteeVote(v);
      expect(r.reason).not.toBe('invalid sortition proof'); // snapshot weights still match
      if (r.finalized === send.hash) finalized = true;
    }
    expect(finalized).toBe(true);
    expect(ledger.getBlockStatus(send.hash)).toBe('final');
  });

  it('slashes a committee member that equivocates across a fork', async () => {
    const ledger = new EngineLedger('testnet');
    // 8 bonded validators dilute the pool so no single member reaches quorum alone.
    const validators = Array.from({ length: 8 }, (_, i) => keyFromScalar(i));
    for (let i = 0; i < validators.length; i++) await openAcct(ledger, validators[i]!, `val-${i}`, true);
    const equivocator = validators[0]!;

    // Two sibling blocks by a separate author (same accountId:previousHash).
    const author = keyFromScalar(60);
    const open = await openAcct(ledger, author, 'author', false);
    const a = craftSend(author, open, 'x', 100_000n, 1);
    const b = craftSend(author, open, 'y', 200_000n, 2);
    expect(ledger.addBlock(a).success).toBe(true);
    expect(ledger.addBlock(b).success).toBe(false); // conflicting, but retained for fork tally

    // The validator votes for BOTH siblings — equivocation (neither alone is quorum).
    const va = vote(ledger, equivocator, { hash: a.hash, shard: a.shard })!;
    const vb = vote(ledger, equivocator, { hash: b.hash, shard: b.shard })!;
    expect(ledger.applyCommitteeVote(va).accepted).toBe(true);
    const r = ledger.applyCommitteeVote(vb);

    expect(r.reason).toBe('equivocation');
    expect(ledger.isSlashed(equivocator.pub)).toBe(true);
    expect(ledger.validatorWeight(equivocator.pub)).toBe(0);
  });
});
