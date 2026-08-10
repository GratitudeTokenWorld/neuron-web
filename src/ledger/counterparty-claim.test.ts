import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import type { Block } from '../engine/core/block.js';

/**
 * G2 — claim a payment via a counterparty proof packet, holding NOTHING of the
 * sender's chain. Alice's ledger is the "holder" (a super-node's view) and
 * serves the packet; Bob's ledger is a fresh light client that verifies the
 * packet, registers exactly one block (the send), and claims. Adversarial
 * cases: tampering, mis-addressing, replayed claims, frozen senders.
 */

const attester = generateKeyPair();

async function openAcct(ledger: EngineLedger, keys: SignerKeys, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  return ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
}

/** Alice's world: a chain with some noise sends and one payment to `to`. */
async function senderLedgerWithPayment(to: string, amount: number) {
  const ledger = new EngineLedger('testnet');
  const alice = generateKeyPair();
  await openAcct(ledger, alice, 'human-alice');
  // createSend resolves recipients through the account registry — register them.
  const noise = generateKeyPair().pub;
  ledger.registerAccount({ username: 'noise', pub: noise });
  ledger.registerAccount({ username: 'recipient', pub: to });
  await ledger.createSend(alice.pub, noise, 5, alice); // unrelated noise
  const { block: send } = await ledger.createSend(alice.pub, to, amount, alice);
  await ledger.createSend(alice.pub, noise, 7, alice); // chain grows past the send
  return { ledger, alice, send: send! };
}

describe('G2 — counterparty proof claims (no sender chain held)', () => {
  it('bob claims from the packet alone and never holds alice’s chain', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');
    const before = bobLedger.getAccountBalance(bob.pub);

    const { ledger: aliceLedger, alice, send } = await senderLedgerWithPayment(bob.pub, 1234);
    const packet = aliceLedger.buildCounterpartyPacket(alice.pub, send.hash)!;
    expect(packet).not.toBeNull();

    // Bob's ledger: verify + register the send, then the NORMAL claim path.
    const reg = bobLedger.registerVerifiedSend(packet, bob.pub);
    expect(reg).toEqual({ ok: true });
    const unclaimed = bobLedger.getUnclaimedForAccount(bob.pub);
    expect(unclaimed).toHaveLength(1);
    const receive = await bobLedger.createReceive(bob.pub, send.hash, bob);
    expect(receive.block).toBeDefined();
    expect(bobLedger.addBlock(receive.block!).success).toBe(true);

    expect(bobLedger.getAccountBalance(bob.pub)).toBe(before + 1234);
    // The scale invariant, literally: bob holds his own chain and nothing else.
    expect(bobLedger.getAccountChain(alice.pub)).toHaveLength(0);
    expect(bobLedger.getAccountChain(bob.pub).length).toBeGreaterThan(0);
  });

  it('rejects forged packets: tampered amount, wrong recipient, foreign send', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');

    const { ledger: aliceLedger, alice, send } = await senderLedgerWithPayment(bob.pub, 500);
    const packet = aliceLedger.buildCounterpartyPacket(alice.pub, send.hash)!;

    // Tampered amount — content hash breaks.
    const tampered = { ...packet, sendBlock: { ...packet.sendBlock, amount: 999_999n } };
    expect(bobLedger.registerVerifiedSend(tampered, bob.pub).ok).toBe(false);

    // Addressed to someone else — mallory cannot claim bob's payment.
    expect(bobLedger.registerVerifiedSend(packet, generateKeyPair().pub).ok).toBe(false);

    // A valid send from a DIFFERENT chain swapped in — inclusion proof fails.
    const other = await senderLedgerWithPayment(bob.pub, 500);
    const swapped = {
      ...packet,
      sendBlock: other.send,
      sendInclusionProof: other.ledger.buildCounterpartyPacket(other.alice.pub, other.send.hash)!.sendInclusionProof,
    };
    expect(bobLedger.registerVerifiedSend(swapped, bob.pub).ok).toBe(false);

    // Truncated proof.
    const truncated = { ...packet, sendInclusionProof: packet.sendInclusionProof.slice(1) };
    expect(bobLedger.registerVerifiedSend(truncated, bob.pub).ok).toBe(false);

    // Nothing slipped into bob's unclaimed set along the way.
    expect(bobLedger.getUnclaimedForAccount(bob.pub)).toHaveLength(0);
  });

  it('a packet cannot be claimed twice', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');

    const { ledger: aliceLedger, alice, send } = await senderLedgerWithPayment(bob.pub, 100);
    const packet = aliceLedger.buildCounterpartyPacket(alice.pub, send.hash)!;

    expect(bobLedger.registerVerifiedSend(packet, bob.pub).ok).toBe(true);
    const r1 = await bobLedger.createReceive(bob.pub, send.hash, bob);
    bobLedger.addBlock(r1.block!);
    const balance = bobLedger.getAccountBalance(bob.pub);

    // Re-registering after the claim is refused, and no unclaimed entry returns.
    const again = bobLedger.registerVerifiedSend(packet, bob.pub);
    expect(again.ok).toBe(false);
    expect(again.error).toBe('already claimed');
    expect(bobLedger.getUnclaimedForAccount(bob.pub)).toHaveLength(0);
    const r2 = await bobLedger.createReceive(bob.pub, send.hash, bob);
    expect(r2.block).toBeUndefined();
    expect(bobLedger.getAccountBalance(bob.pub)).toBe(balance);
  });

  it('claims an NFT from proofs alone — transfer packet + mint proof', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');

    // Alice's world: she mints a token and sends it to bob.
    const aliceLedger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(aliceLedger, alice, 'human-alice');
    aliceLedger.registerAccount({ username: 'bob', pub: bob.pub });
    const mint = await aliceLedger.createMintNft(alice.pub, 'cid-of-the-art', { name: 'Piece' }, alice);
    const tokenId = mint.block!.tokenId!;
    const xfer = await aliceLedger.createTransferNft(alice.pub, tokenId, bob.pub, alice);

    const packet = aliceLedger.buildCounterpartyPacket(alice.pub, xfer.block!.hash)!;
    const mintProof = aliceLedger.buildMintProof(alice.pub, tokenId)!;
    expect(mintProof).not.toBeNull();

    // Bob holds nothing of alice's chain. Mint first (so the token is never
    // claimable-but-unrenderable), then the transfer, then the normal claim.
    expect(bobLedger.registerVerifiedMint(mintProof, tokenId)).toEqual({ ok: true });
    expect(bobLedger.registerVerifiedSend(packet, bob.pub)).toEqual({ ok: true });
    const recv = await bobLedger.createReceiveNft(bob.pub, xfer.block!.hash, bob);
    expect(recv.block).toBeDefined();
    expect(bobLedger.addBlock(recv.block!).success).toBe(true);

    // Owned, renderable, and none of alice's chain retained.
    expect(bobLedger.getNftOwner(tokenId)).toBe(bob.pub);
    const owned = bobLedger.getNftsOwnedBy(bob.pub);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ tokenId, contentRef: 'cid-of-the-art', minter: alice.pub });
    expect(bobLedger.getAccountChain(alice.pub)).toHaveLength(0);
  });

  it('rejects forged mint proofs: wrong token, non-mint block, foreign chain', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');

    const aliceLedger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    await openAcct(aliceLedger, alice, 'human-alice');
    const mintA = await aliceLedger.createMintNft(alice.pub, 'cid-a', {}, alice);
    const mintB = await aliceLedger.createMintNft(alice.pub, 'cid-b', {}, alice);
    const tokenA = mintA.block!.tokenId!;
    const tokenB = mintB.block!.tokenId!;
    const proofA = aliceLedger.buildMintProof(alice.pub, tokenA)!;

    // A proof for token A cannot register token B (content swap).
    expect(bobLedger.registerVerifiedMint(proofA, tokenB).ok).toBe(false);
    expect(bobLedger.getNftInfo(tokenB)).toBeUndefined();

    // Tampered content reference — the block's content hash breaks.
    const tampered = { ...proofA, mintBlock: { ...proofA.mintBlock, contentRef: 'cid-evil' } };
    expect(bobLedger.registerVerifiedMint(tampered, tokenA).ok).toBe(false);

    // A non-mint block dressed up as one.
    const notAMint = { ...proofA, mintBlock: aliceLedger.getAccountChain(alice.pub)[0]! };
    expect(bobLedger.registerVerifiedMint(notAMint, tokenA).ok).toBe(false);

    // Mint from a DIFFERENT chain: valid in isolation, not committed by this head.
    const malloryLedger = new EngineLedger('testnet');
    const mallory = generateKeyPair();
    await openAcct(malloryLedger, mallory, 'human-mallory');
    const mintM = await malloryLedger.createMintNft(mallory.pub, 'cid-m', {}, mallory);
    const swapped = { ...proofA, mintBlock: mintM.block! };
    expect(bobLedger.registerVerifiedMint(swapped, mintM.block!.tokenId!).ok).toBe(false);

    expect(bobLedger.getNftInfo(tokenA)).toBeUndefined();
  });

  it('refuses packets from a sender proven to have equivocated', async () => {
    const bobLedger = new EngineLedger('testnet');
    const bob = generateKeyPair();
    await openAcct(bobLedger, bob, 'human-bob');

    const { ledger: aliceLedger, alice, send } = await senderLedgerWithPayment(bob.pub, 100);
    const packet = aliceLedger.buildCounterpartyPacket(alice.pub, send.hash)!;

    // Bob's node learns (via gossiped, self-verifying evidence) that alice
    // double-spent: two signed sends at the same height from HER OWN key.
    const chain = aliceLedger.getAccountChain(alice.pub);
    const evidenceLedger = new EngineLedger('testnet');
    // Rebuild the fork: alice's real block at index 1 vs a crafted sibling.
    const { AccountAccumulator } = await import('../engine/core/accumulator.js');
    const { createBlock } = await import('../engine/core/block.js');
    const acc = new AccountAccumulator();
    acc.append(chain[0]!.hash);
    const sibling = createBlock(
      {
        accountId: alice.pub, index: 1, type: 'send', previousHash: chain[0]!.hash,
        shard: chain[0]!.shard, timestamp: 9_999, balance: chain[0]!.balance - 1n,
        recipient: 'ff'.repeat(33), amount: 1n,
      },
      alice.priv,
      acc,
    );
    expect(bobLedger.applyEvidenceFromBlocks(chain[1]!, sibling)).toBe(true);
    expect(bobLedger.isEquivocated(alice.pub)).toBe(true);

    // The frozen sender's packet is refused even though it verifies.
    const reg = bobLedger.registerVerifiedSend(packet, bob.pub);
    expect(reg.ok).toBe(false);
    expect(reg.error).toBe('sender equivocated');
  });
});
