import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { type Block } from '../engine/core/block.js';

/**
 * Replay-ordering soundness. Blocks can replay/sync in any cross-account order. A
 * receive that applies BEFORE its source send must not let the send be re-offered
 * as unclaimed (that double-spends — observed as bob holding 75 UNIT from 50 sent),
 * and an NFT send replayed after its receive must not clobber the new owner.
 */

const attester = generateKeyPair();

async function openAcct(ledger: EngineLedger, keys: SignerKeys, username: string, nullifier: string): Promise<Block> {
  const c = deriveCommitment(nullifier, keys.pub);
  const open = await ledger.openAccount(keys.pub, keys, { nullifier, attestations: [createAttestation('personhood', c, attester)] });
  ledger.registerAccount({ username, pub: keys.pub });
  return open;
}

describe('replay-order soundness', () => {
  it('a payment is not double-claimed when the receive replays before the send', async () => {
    const src = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(src, alice, 'alice', 'human-alice');
    await openAcct(src, bob, 'bob', 'human-bob');
    const send = (await src.createSend(alice.pub, 'bob', 25, alice)).block!;
    src.addBlock(send);
    const recv = (await src.createReceive(bob.pub, send.hash, bob)).block!;

    // Fresh node, problematic order: opens → bob's RECEIVE → alice's SEND.
    const dst = new EngineLedger('testnet');
    expect(dst.addBlock(src.getAccountChain(alice.pub)[0]!).success).toBe(true);
    expect(dst.addBlock(src.getAccountChain(bob.pub)[0]!).success).toBe(true);
    expect(dst.addBlock(recv).success).toBe(true);   // receive before its source
    expect(dst.addBlock(send).success).toBe(true);   // source after

    // The send must NOT be claimable again.
    expect(dst.unclaimedSends.has(send.hash)).toBe(false);
    expect(dst.getUnclaimedForAccount(bob.pub)).toHaveLength(0);
    expect(dst.getAccountBalance(bob.pub)).toBe(dst.getAccountBalance(alice.pub) + 50); // bob 1e9+25, alice 1e9-25 → diff 50
  });

  it('NFT ownership survives an nft-send replayed after its receive', async () => {
    const src = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(src, alice, 'alice', 'human-alice');
    await openAcct(src, bob, 'bob', 'human-bob');
    const { tokenId } = await src.createMintNft(alice.pub, 'cid', {}, alice);
    const nsend = (await src.createTransferNft(alice.pub, tokenId!, 'bob', alice)).block!;
    src.addBlock(nsend);
    const nrecv = (await src.createReceiveNft(bob.pub, nsend.hash, bob)).block!;

    const dst = new EngineLedger('testnet');
    dst.addBlock(src.getAccountChain(alice.pub)[0]!);
    dst.addBlock(src.getAccountChain(bob.pub)[0]!);
    dst.addBlock(src.getAccountChain(alice.pub)[1]!); // nft-mint
    expect(dst.addBlock(nrecv).success).toBe(true);   // receive before its source send
    expect(dst.addBlock(nsend).success).toBe(true);   // source send after (tolerated)

    expect(dst.getNftOwner(tokenId!)).toBe(bob.pub);            // bob still owns it
    expect(dst.getUnclaimedNftsForAccount(bob.pub)).toHaveLength(0);
  });

  it('a round-tripped NFT does not hop back when the sender send block is missing', async () => {
    // The live failure (2026-08-10): alice -> bob -> alice. Alice claimed the
    // return by PROOF, so bob's nft-send lived only in memory, while bob's
    // chain up to his older nft-receive was persisted. On reload the newest
    // evidence about bob was "bob received it", so the token hopped back to him
    // and vanished from alice's wallet on every refresh.
    const source = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(source, alice, 'alice', 'human-alice');
    await openAcct(source, bob, 'bob', 'human-bob');

    const mint = await source.createMintNft(alice.pub, 'cid-art', {}, alice);
    const tokenId = mint.block!.tokenId!;
    const out = await source.createTransferNft(alice.pub, tokenId, bob.pub, alice);
    await source.createReceiveNft(bob.pub, out.block!.hash, bob);
    const back = await source.createTransferNft(bob.pub, tokenId, alice.pub, bob);
    await source.createReceiveNft(alice.pub, back.block!.hash, alice);
    expect(source.getNftOwner(tokenId)).toBe(alice.pub);

    const aliceChain = [...source.getAccountChain(alice.pub)];
    // What a proof-claiming node actually persisted of bob: everything EXCEPT
    // the final nft-send (registered in memory at claim time).
    const bobPersisted = source.getAccountChain(bob.pub).filter(b => b.hash !== back.block!.hash);

    for (const aliceFirst of [true, false]) {
      const replay = new EngineLedger('testnet');
      for (const b of aliceFirst ? [...aliceChain, ...bobPersisted] : [...bobPersisted, ...aliceChain]) {
        replay.addBlock(b);
      }
      // Custody is per-account and index-ordered, so alice's receive is her
      // latest word and bob's receive is his — ambiguous until his send is
      // restored, which is exactly why the node now persists it.
      replay.restoreVerifiedBlock(back.block!);
      expect(replay.getNftOwner(tokenId)).toBe(alice.pub);
      expect(replay.getNftsOwnedBy(bob.pub)).toHaveLength(0);
    }
  });

  it('a proof-claimed NFT survives reload: kept mint + send blocks re-seat it', async () => {
    // A proof claim holds NONE of the counterparty chains, so on reload
    // addBlock rejects those blocks and the token would render as nothing.
    const source = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(source, alice, 'alice', 'human-alice');
    await openAcct(source, bob, 'bob', 'human-bob');
    const mint = await source.createMintNft(alice.pub, 'cid-art', { name: 'Piece' }, alice);
    const tokenId = mint.block!.tokenId!;
    const out = await source.createTransferNft(alice.pub, tokenId, bob.pub, alice);

    // Bob claims by proof, holding nothing of alice's chain.
    const bobLedger = new EngineLedger('testnet');
    await openAcct(bobLedger, bob, 'bob', 'human-bob');
    bobLedger.registerVerifiedMint(source.buildMintProof(alice.pub, tokenId)!, tokenId);
    bobLedger.registerVerifiedSend(source.buildCounterpartyPacket(alice.pub, out.block!.hash)!, bob.pub);
    await bobLedger.createReceiveNft(bob.pub, out.block!.hash, bob);
    expect(bobLedger.getNftsOwnedBy(bob.pub)).toHaveLength(1);

    // Reload: bob's OWN chain replays; the retained foreign blocks do not.
    const reloaded = new EngineLedger('testnet');
    for (const b of bobLedger.getAccountChain(bob.pub)) reloaded.addBlock(b);
    expect(reloaded.addBlock(mint.block!).success).toBe(false);   // no minter chain
    expect(reloaded.getNftsOwnedBy(bob.pub)).toHaveLength(0);     // owned but unrenderable

    expect(reloaded.restoreVerifiedBlock(mint.block!)).toBe(true);
    const owned = reloaded.getNftsOwnedBy(bob.pub);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ tokenId, contentRef: 'cid-art', minter: alice.pub });

    // Tampered blocks are refused by the restore path too, and restoring a
    // send already claimed must not re-offer it.
    const fresh = new EngineLedger('testnet');
    expect(fresh.restoreVerifiedBlock({ ...mint.block!, contentRef: 'cid-evil' })).toBe(false);
    expect(reloaded.restoreVerifiedBlock(out.block!)).toBe(true);
    expect(reloaded.getUnclaimedNftsForAccount(bob.pub)).toHaveLength(0);
    expect(reloaded.getNftOwner(tokenId)).toBe(bob.pub);
  });

  it('still rejects a genuine non-owner nft-send forgery', async () => {
    const ledger = new EngineLedger('testnet');
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    await openAcct(ledger, alice, 'alice', 'human-alice');
    await openAcct(ledger, bob, 'bob', 'human-bob');
    const { tokenId } = await ledger.createMintNft(alice.pub, 'cid', {}, alice);
    // bob never owned it, no receive claimed it → forgery rejected.
    expect((await ledger.createTransferNft(bob.pub, tokenId!, 'alice', bob)).error).toBe('You do not own this NFT');
  });
});
