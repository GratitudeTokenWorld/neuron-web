import { describe, it, expect } from 'vitest';
import { EngineLedger } from './engine-ledger.js';
import { generateKeyPair, sign } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { ReaderReceiptBook, receiptPayload, type SignedReceipt } from '../engine/content/read-receipts.js';
import { readCredit, DEFAULT_TAPER } from '../engine/content/read-credit.js';

/**
 * The round trip, end to end: readers read, sign receipts, the provider settles
 * them into a minted payout, and a node that saw none of it accepts the block.
 *
 * This is the test that closes "zero callers". Every previous piece was
 * verified in isolation — the receipt shape, the credit derivation, the
 * validation rule — while nothing actually produced a receipt or turned one
 * into money. If this passes, the path exists.
 */

const attester = generateKeyPair();

async function openProvider(ledger: EngineLedger, keys: ReturnType<typeof generateKeyPair>, name: string) {
  const nullifier = `nid-${name}`;
  await ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', deriveCommitment(nullifier, keys.pub), attester)],
  });
  await ledger.createStorageRegister(keys.pub, 100, keys, `dev-${name}`);
}

/** A reader that has fetched `reads` blocks of `bytes` each from `provider`. */
function readerAttesting(provider: string, reads: number, bytes: number) {
  const keys = generateKeyPair();
  const book = new ReaderReceiptBook(keys.pub);
  let last = null as ReturnType<ReaderReceiptBook['record']>;
  for (let i = 1; i <= reads; i++) {
    // Each read is of a DIFFERENT file, so the per-file taper credits each in
    // full — which is what honest breadth looks like.
    const credited = Math.round(bytes * readCredit(1, DEFAULT_TAPER));
    last = book.record({ provider, creditedBytes: credited, latencyMs: 50 });
  }
  const envelope: SignedReceipt = { receipt: last!, signature: sign(receiptPayload(last!), keys.priv) };
  return { keys, envelope };
}

describe('readers attest, the provider settles, a stranger validates', () => {
  it('mints exactly what the receipts support', async () => {
    const ledger = new EngineLedger('testnet');
    const provider = generateKeyPair();
    await openProvider(ledger, provider, 'provider');

    const readers = [
      readerAttesting(provider.pub, 4, 1_000_000),
      readerAttesting(provider.pub, 3, 1_000_000),
      readerAttesting(provider.pub, 5, 1_000_000),
    ];
    const envelopes = readers.map(r => r.envelope);

    const settled = await ledger.createStorageSettle(provider.pub, provider, envelopes, 0);
    expect(settled.error).toBeUndefined();
    expect(settled.block).toBeDefined();

    // 4 + 3 + 5 reads of 1 MB, each credited in full.
    expect(Number(settled.block!.amount)).toBe(12_000_000);

    // A node that has never seen any of these receipts accepts the block and
    // derives the same balance — the property the earlier version did not have.
    const stranger = new EngineLedger('testnet');
    for (const block of ledger.getAccountChain(provider.pub)) {
      expect(stranger.addBlock(block).success).toBe(true);
    }
    expect(stranger.getAccountBalance(provider.pub))
      .toBe(ledger.getAccountBalance(provider.pub));
  });

  it('refuses to issue a settlement it knows a peer would reject', async () => {
    // Issuance derives the amount with the validator's own function, so an
    // unpayable set cannot become a block at all.
    const ledger = new EngineLedger('testnet');
    const provider = generateKeyPair();
    await openProvider(ledger, provider, 'lonely');

    // Two readers — below the distinct-reader floor.
    const envelopes = [
      readerAttesting(provider.pub, 5, 1_000_000).envelope,
      readerAttesting(provider.pub, 5, 1_000_000).envelope,
    ];
    const settled = await ledger.createStorageSettle(provider.pub, provider, envelopes, 0);
    expect(settled.block).toBeUndefined();
    expect(settled.error).toMatch(/Nothing payable/);
  });

  it('pays only the delta on the next period', async () => {
    const ledger = new EngineLedger('testnet');
    const provider = generateKeyPair();
    await openProvider(ledger, provider, 'growing');

    // Three readers, each with one receipt of 3 MB.
    const books = [0, 1, 2].map(() => {
      const keys = generateKeyPair();
      return { keys, book: new ReaderReceiptBook(keys.pub) };
    });
    const sign1 = books.map(({ keys, book }) => {
      const r = book.record({ provider: provider.pub, creditedBytes: 3_000_000, latencyMs: 10 })!;
      return { receipt: r, signature: sign(receiptPayload(r), keys.priv) };
    });
    const first = await ledger.createStorageSettle(provider.pub, provider, sign1, 0);
    expect(Number(first.block!.amount)).toBe(9_000_000);

    // Each reads another 1 MB: the cumulative total is 4 MB, the DELTA is 1 MB.
    const sign2 = books.map(({ keys, book }) => {
      const r = book.record({ provider: provider.pub, creditedBytes: 1_000_000, latencyMs: 10 })!;
      return { receipt: r, signature: sign(receiptPayload(r), keys.priv) };
    });
    const second = await ledger.createStorageSettle(provider.pub, provider, sign2, 1);
    expect(Number(second.block!.amount)).toBe(3_000_000);

    // And the stranger still agrees about the balance after both.
    const stranger = new EngineLedger('testnet');
    for (const block of ledger.getAccountChain(provider.pub)) {
      expect(stranger.addBlock(block).success).toBe(true);
    }
    expect(stranger.getAccountBalance(provider.pub)).toBe(ledger.getAccountBalance(provider.pub));
  });

  it('cannot settle the same period twice', async () => {
    const ledger = new EngineLedger('testnet');
    const provider = generateKeyPair();
    await openProvider(ledger, provider, 'replayer');
    const envelopes = [0, 1, 2].map(() => readerAttesting(provider.pub, 2, 1_000_000).envelope);

    expect((await ledger.createStorageSettle(provider.pub, provider, envelopes, 7)).error).toBeUndefined();
    const replay = await ledger.createStorageSettle(provider.pub, provider, envelopes, 7);
    // Same receipts, same period: the baselines already moved past them.
    expect(replay.block).toBeUndefined();
  });
});
