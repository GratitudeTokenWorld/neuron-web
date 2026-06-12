import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './keys.js';
import { AccountAccumulator } from './accumulator.js';
import { createOpenBlock, createBlock, type Block } from './block.js';
import { createAttestation, type QuorumPolicy } from './attestation.js';
import { deriveCommitment } from './identity.js';
import { verifyAccountHead, type AccountHeadProof } from './light-verify.js';

/**
 * Build an account chain of `length` blocks and produce the compact head proof a
 * light client would receive: the open block, the head block, and an inclusion
 * proof of the open block (leaf 0) under the head's accumulator root.
 */
function buildChain(length: number) {
  const account = generateKeyPair();
  const at1 = generateKeyPair();
  const at2 = generateKeyPair();
  const nullifier = account.pub.slice(0, 16);
  const commitment = deriveCommitment(nullifier, account.pub);
  const attestations = [
    createAttestation('personhood', commitment, at1),
    createAttestation('stake', commitment, at2),
  ];

  const acc = new AccountAccumulator();
  const blocks: Block[] = [];
  const open = createOpenBlock(
    { accountId: account.pub, identityCommitment: commitment, attestations, timestamp: 1000 },
    account.priv,
    acc,
  );
  blocks.push(open);

  let balance = open.balance;
  for (let i = 1; i < length; i++) {
    balance -= 1n;
    blocks.push(
      createBlock(
        {
          accountId: account.pub,
          index: i,
          type: 'send',
          previousHash: blocks[i - 1]!.hash,
          shard: open.shard,
          timestamp: 1000 + i,
          balance,
          recipient: 'ffff',
          amount: 1n,
        },
        account.priv,
        acc,
      ),
    );
  }

  const proof: AccountHeadProof = {
    openBlock: open,
    headBlock: blocks[length - 1]!,
    openInclusionProof: acc.proofHex(0),
  };
  const policy: QuorumPolicy = { min: 2, requiredTypes: ['personhood', 'stake'] };
  return { account, blocks, proof, policy };
}

describe('light-verify — Phase 0 validation criterion', () => {
  it('verifies a followed account head from a proof alone', () => {
    const { proof, policy } = buildChain(10);
    const r = verifyAccountHead(proof, policy);
    expect(r.ok).toBe(true);
    expect(r.accountId).toBe(proof.headBlock.accountId);
    expect(r.balance).toBe(proof.headBlock.balance);
  });

  it('verifies a one-block chain (head equals open)', () => {
    const { proof, policy } = buildChain(1);
    expect(verifyAccountHead(proof, policy).ok).toBe(true);
  });

  it('rejects an insufficient identity quorum', () => {
    const { proof } = buildChain(5);
    expect(verifyAccountHead(proof, { min: 3 }).ok).toBe(false);
  });

  it('rejects a forged head signature', () => {
    const { proof, policy } = buildChain(5);
    const forged: Block = { ...proof.headBlock, signature: '00'.repeat(64) };
    expect(verifyAccountHead({ ...proof, headBlock: forged }, policy).ok).toBe(false);
  });

  it('rejects a head whose accumulator does not commit the open block', () => {
    const { proof, policy } = buildChain(8);
    const broken = { ...proof, openInclusionProof: proof.openInclusionProof.slice(1) };
    expect(verifyAccountHead(broken, policy).ok).toBe(false);
  });

  it('rejects a head spliced from a different account', () => {
    const { proof, policy } = buildChain(5);
    const other = buildChain(5);
    const spliced: AccountHeadProof = {
      openBlock: proof.openBlock,
      headBlock: other.proof.headBlock,
      openInclusionProof: proof.openInclusionProof,
    };
    expect(verifyAccountHead(spliced, policy).ok).toBe(false);
  });
});
