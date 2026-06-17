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
