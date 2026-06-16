import { describe, it, expect } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';

/**
 * Native NFTs (Bucket B, slice B1). An NFT is a small ownership key transferred on
 * the block-lattice exactly like a payment (mint / send / receive / burn), with an
 * ownership index and balance-preserving + ownership-validated application.
 */

const attester = generateKeyPair();
const MINT = 1_000_000_000n;

async function openAcct(ledger: EngineLedger, keys: SignerKeys, username: string, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  const open = await ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
  ledger.registerAccount({ username, pub: keys.pub });
  return open;
}

/** Two accounts (alice/bob) on one ledger, plus a second "remote" ledger holding alice's open. */
async function setup() {
  const ledger = new EngineLedger('testnet');
  const alice = generateKeyPair();
  const bob = generateKeyPair();
  await openAcct(ledger, alice, 'alice', 'human-alice');
  await openAcct(ledger, bob, 'bob', 'human-bob');
  return { ledger, alice, bob };
}

describe('native NFTs', () => {
  it('mints an NFT owned by the minter with its content + metadata', async () => {
    const { ledger, alice } = await setup();
    const r = await ledger.createMintNft(alice.pub, 'cid-art-1', { name: 'My Page', kind: 'page' }, alice);
    expect(r.block?.type).toBe('nft-mint');
    expect(r.tokenId).toBeTruthy();
    expect(ledger.getNftOwner(r.tokenId!)).toBe(alice.pub);
    const info = ledger.getNftInfo(r.tokenId!);
    expect(info?.contentRef).toBe('cid-art-1');
    expect(info?.meta.name).toBe('My Page');
    expect(ledger.getNftsOwnedBy(alice.pub).map((n) => n.tokenId)).toContain(r.tokenId);
    expect(ledger.getAccountBalance(alice.pub)).toBe(Number(MINT)); // mint never touches balance
  });

  it('transfers ownership via send → receive (claim-on-receive, like a payment)', async () => {
    const { ledger, alice, bob } = await setup();
    const { tokenId } = await ledger.createMintNft(alice.pub, 'cid-1', {}, alice);

    const send = await ledger.createTransferNft(alice.pub, tokenId!, 'bob', alice);
    expect(send.block?.type).toBe('nft-send');
    expect(ledger.getNftOwner(tokenId!)).toBeUndefined();              // in flight
    expect(ledger.getNftsOwnedBy(alice.pub)).toHaveLength(0);          // left alice
    const pending = ledger.getUnclaimedNftsForAccount(bob.pub);
    expect(pending).toEqual([{ nftSendHash: send.block!.hash, tokenId, fromPub: alice.pub }]);

    const recv = await ledger.createReceiveNft(bob.pub, send.block!.hash, bob);
    expect(recv.block?.type).toBe('nft-receive');
    expect(ledger.getNftOwner(tokenId!)).toBe(bob.pub);               // bob owns it now
    expect(ledger.getUnclaimedNftsForAccount(bob.pub)).toHaveLength(0);
  });

  it('rejects transferring an NFT you do not own', async () => {
    const { ledger, alice, bob } = await setup();
    const { tokenId } = await ledger.createMintNft(alice.pub, 'cid-1', {}, alice);
    // bob tries to send alice's token
    expect((await ledger.createTransferNft(bob.pub, tokenId!, 'alice', bob)).error).toBe('You do not own this NFT');
  });

  it('burns an owned NFT (gone from ownership, marked burned)', async () => {
    const { ledger, alice } = await setup();
    const { tokenId } = await ledger.createMintNft(alice.pub, 'cid-1', {}, alice);
    expect((await ledger.createBurnNft(alice.pub, tokenId!, alice)).block?.type).toBe('nft-burn');
    expect(ledger.getNftOwner(tokenId!)).toBeUndefined();
    expect(ledger.isNftBurned(tokenId!)).toBe(true);
    // can't re-mint the same tokenId or transfer a burned one
    expect((await ledger.createTransferNft(alice.pub, tokenId!, 'alice', alice)).error).toBe('You do not own this NFT');
  });

  it('applies foreign NFT blocks on another node and rejects a non-owner forgery', async () => {
    const { ledger: src, alice, bob } = await setup();
    const { tokenId } = await src.createMintNft(alice.pub, 'cid-1', { name: 'X' }, alice);
    const send = (await src.createTransferNft(alice.pub, tokenId!, 'bob', alice)).block!;
    const recv = (await src.createReceiveNft(bob.pub, send.hash, bob)).block!;

    // A second node replays the chain (mint → send → receive) in order.
    const dst = new EngineLedger('testnet');
    for (const k of [alice, bob]) {
      const open = src.getAccountChain(k.pub)[0]!;
      expect(dst.addBlock(open).success).toBe(true);
    }
    const mint = src.getAccountChain(alice.pub)[1]!;
    expect(dst.addBlock(mint).success).toBe(true);
    expect(dst.getNftOwner(tokenId!)).toBe(alice.pub);
    expect(dst.addBlock(send).success).toBe(true);
    expect(dst.getNftOwner(tokenId!)).toBeUndefined();
    expect(dst.addBlock(recv).success).toBe(true);
    expect(dst.getNftOwner(tokenId!)).toBe(bob.pub);

    // Forgery: bob crafts an nft-send for a token he doesn't own → rejected.
    const acc = new AccountAccumulator();
    for (const b of dst.getAccountChain(alice.pub)) acc.append(b.hash);
    const aliceHead = dst.getAccountHead(alice.pub)!;
    const forged = createBlock(
      { accountId: alice.pub, index: aliceHead.index + 1, type: 'nft-send', previousHash: aliceHead.hash,
        shard: aliceHead.shard, timestamp: 9, balance: aliceHead.balance, tokenId, recipient: 'carol' },
      alice.priv, acc,
    );
    // alice no longer owns it (bob does), so even alice-signed it must fail.
    expect(dst.addBlock(forged).error).toBe('nft-send: not the owner');
  });

  it('rejects an nft block that tampers with balance', async () => {
    const { ledger, alice } = await setup();
    const head = ledger.getAccountHead(alice.pub)!;
    const acc = new AccountAccumulator();
    for (const b of ledger.getAccountChain(alice.pub)) acc.append(b.hash);
    const evil = createBlock(
      { accountId: alice.pub, index: head.index + 1, type: 'nft-mint', previousHash: head.hash, shard: head.shard,
        timestamp: 9, balance: head.balance + 5n, tokenId: 'aa'.repeat(32), contentRef: 'cid', nftMeta: {} },
      alice.priv, acc,
    );
    expect(ledger.addBlock(evil).error).toBe('nft-mint must preserve balance');
  });
});
