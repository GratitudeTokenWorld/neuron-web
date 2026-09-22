import { describe, it, expect } from 'vitest';
import { ProviderLedger, GB_BYTES, MAX_HEARTBEATS_PER_EPOCH, HEARTBEAT_INTERVAL_MS, REWARD_EPOCH_MS } from './provider-ledger.js';
import { receiptPayload, MAX_RECEIPTS_PER_SETTLEMENT, MIN_DISTINCT_READERS, PER_READER_EPOCH_CAP_BYTES, type ReadReceipt } from './read-receipts.js';
import { generateKeyPair, sign } from '../core/keys.js';
import { createBlock, type Block } from '../core/block.js';
import { AccountAccumulator } from '../core/accumulator.js';

/**
 * Hypothesis H-P10: a settlement can be validated identically by every node,
 * without any of them sharing receipt history.
 *
 * Disproved by two nodes reaching different verdicts on the same block — which
 * is what the FIRST attempt did, because it read attestation out of local
 * state. A correctly-issued block was then rejected by any peer that had not
 * seen the same receipts, stranding every block behind it.
 *
 * This is the test that makes "every other node rejects a larger figure" a
 * statement about running code rather than about an intention.
 */

const PROVIDER = generateKeyPair();
const DAY = 100 * REWARD_EPOCH_MS;

function signedReceipt(reader: ReturnType<typeof generateKeyPair>, bytesTotal: number, counter = 1) {
  const receipt: ReadReceipt = {
    reader: reader.pub, provider: PROVIDER.pub,
    counter, bytesTotal, readsTotal: counter, lastLatencyMs: 120, ts: DAY,
  };
  return { receipt, signature: sign(receiptPayload(receipt), reader.priv) };
}

/** A registered, live provider. */
function ledgerWithProvider(): ProviderLedger {
  const pl = new ProviderLedger();
  const at = DAY - REWARD_EPOCH_MS;
  pl.apply(block('storage-register', at, { capacityGB: 100, deviceId: 'dev-1' }), at);
  for (let i = 0; i < MAX_HEARTBEATS_PER_EPOCH; i++) {
    const ts = DAY + i * HEARTBEAT_INTERVAL_MS;
    pl.apply(block('storage-heartbeat', ts, { storedBytes: 10 * GB_BYTES }), ts);
  }
  return pl;
}

let index = 0;
function block(type: string, ts: number, storage: Record<string, unknown>, amount?: bigint): Block {
  // A throwaway accumulator per candidate: these tests exercise the SETTLEMENT
  // rules, not chain linkage, so each block is judged on its own content.
  return createBlock({
    accountId: PROVIDER.pub, index: index++, type: type as never,
    previousHash: '0'.repeat(64), shard: 0, timestamp: ts, balance: 0n,
    storage: storage as never, ...(amount !== undefined ? { amount } : {}),
  }, PROVIDER.priv, new AccountAccumulator());
}

function settleBlock(receipts: ReturnType<typeof signedReceipt>[], amount: bigint, periodIndex = 0): Block {
  return block('storage-settle', DAY + REWARD_EPOCH_MS, { periodIndex, receipts }, amount);
}

describe('H-P10: two nodes with different history agree exactly', () => {
  it('lets a peer that has never seen a receipt validate the block', () => {
    const readers = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const receipts = readers.map(r => signedReceipt(r, 1_000_000));
    const blk = settleBlock(receipts, 3_000_000n);

    // The issuer, which holds every receipt locally.
    const issuer = ledgerWithProvider();
    // A peer that holds nothing but the chain.
    const peer = ledgerWithProvider();

    expect(issuer.validate(blk, DAY + REWARD_EPOCH_MS)).toBeNull();
    expect(peer.validate(blk, DAY + REWARD_EPOCH_MS)).toBeNull();
    expect(peer.settlementCredit(blk)).toEqual(issuer.settlementCredit(blk));
  });

  it('REJECTS an inflated figure — on every node, from the block alone', () => {
    const readers = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const receipts = readers.map(r => signedReceipt(r, 1_000_000));
    // The provider signs this block and is paid by it, and still cannot choose
    // the number.
    const inflated = settleBlock(receipts, 99_000_000n);
    for (const node of [ledgerWithProvider(), ledgerWithProvider()]) {
      expect(node.validate(inflated, DAY + REWARD_EPOCH_MS)).toMatch(/exceeds .* supported by receipts/);
    }
  });
});

describe('what the receipts must survive', () => {
  it('ignores a receipt whose signature does not verify', () => {
    const good = [generateKeyPair(), generateKeyPair(), generateKeyPair()].map(r => signedReceipt(r, 1_000_000));
    const forged = signedReceipt(generateKeyPair(), 50_000_000);
    forged.signature = 'ff'.repeat(64);
    const blk = settleBlock([...good, forged], 3_000_000n);
    const pl = ledgerWithProvider();
    // The forged one contributes nothing, so the honest total still stands.
    expect(pl.settlementCredit(blk).payableBytes).toBe(3_000_000);
    expect(pl.validate(blk, DAY + REWARD_EPOCH_MS)).toBeNull();
  });

  it('refuses a provider vouching for itself', () => {
    const selfReceipt = signedReceipt(PROVIDER, 50_000_000);
    const others = [generateKeyPair(), generateKeyPair()].map(r => signedReceipt(r, 1_000_000));
    const blk = settleBlock([selfReceipt, ...others], 2_000_000n);
    const pl = ledgerWithProvider();
    // Only the two real readers count — below the floor, so nothing is payable.
    expect(pl.settlementCredit(blk).distinctReaders).toBe(2);
    expect(pl.validate(blk, DAY + REWARD_EPOCH_MS)).toMatch(/distinct reader/);
  });

  it('counts a duplicated reader once', () => {
    const r1 = generateKeyPair();
    const dup = [signedReceipt(r1, 1_000_000, 1), signedReceipt(r1, 9_000_000, 2)];
    const rest = [generateKeyPair(), generateKeyPair()].map(r => signedReceipt(r, 1_000_000));
    const blk = settleBlock([...dup, ...rest], 3_000_000n);
    const pl = ledgerWithProvider();
    // The first receipt for the pair wins; the second cannot stack on it.
    expect(pl.settlementCredit(blk).distinctReaders).toBe(3);
    expect(pl.settlementCredit(blk).payableBytes).toBe(3_000_000);
  });

  it('caps what any single reader can be worth', () => {
    const whale = signedReceipt(generateKeyPair(), PER_READER_EPOCH_CAP_BYTES * 100);
    const rest = [generateKeyPair(), generateKeyPair()].map(r => signedReceipt(r, 1_000_000));
    const pl = ledgerWithProvider();
    const credit = pl.settlementCredit(settleBlock([whale, ...rest], 1n));
    expect(credit.payableBytes).toBe(PER_READER_EPOCH_CAP_BYTES + 2_000_000);
  });

  it('needs the distinct-reader floor', () => {
    const two = [generateKeyPair(), generateKeyPair()].map(r => signedReceipt(r, 1_000_000));
    expect(MIN_DISTINCT_READERS).toBe(3);
    const pl = ledgerWithProvider();
    expect(pl.validate(settleBlock(two, 2_000_000n), DAY + REWARD_EPOCH_MS)).toMatch(/distinct reader/);
  });
});

describe('the same bytes cannot settle twice', () => {
  it('moves the baselines, so a repeat settles nothing', () => {
    const readers = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const receipts = readers.map(r => signedReceipt(r, 1_000_000));
    const pl = ledgerWithProvider();
    const first = settleBlock(receipts, 3_000_000n, 0);
    expect(pl.validate(first, DAY + REWARD_EPOCH_MS)).toBeNull();
    pl.apply(first, DAY + REWARD_EPOCH_MS);

    // Same receipts, next period: the deltas are now zero.
    const repeat = settleBlock(receipts, 3_000_000n, 1);
    expect(pl.settlementCredit(repeat).payableBytes).toBe(0);
    expect(pl.validate(repeat, DAY + REWARD_EPOCH_MS)).toMatch(/distinct reader|exceeds/);
  });

  it('pays only the DELTA when readers come back with more', () => {
    const readers = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const pl = ledgerWithProvider();
    const first = settleBlock(readers.map(r => signedReceipt(r, 1_000_000)), 3_000_000n, 0);
    pl.apply(first, DAY + REWARD_EPOCH_MS);

    const grown = settleBlock(readers.map(r => signedReceipt(r, 2_500_000, 2)), 1n, 1);
    expect(pl.settlementCredit(grown).payableBytes).toBe(3 * 1_500_000);
  });

  it('refuses a replayed period', () => {
    const readers = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const pl = ledgerWithProvider();
    const first = settleBlock(readers.map(r => signedReceipt(r, 1_000_000)), 3_000_000n, 5);
    pl.apply(first, DAY + REWARD_EPOCH_MS);
    const replay = settleBlock(readers.map(r => signedReceipt(r, 9_000_000, 2)), 1n, 5);
    expect(pl.validate(replay, DAY + REWARD_EPOCH_MS)).toMatch(/is not after/);
  });
});

describe('block size is bounded', () => {
  it('refuses more receipts than the cap', () => {
    const many = Array.from({ length: MAX_RECEIPTS_PER_SETTLEMENT + 1 },
      () => signedReceipt(generateKeyPair(), 1_000));
    const pl = ledgerWithProvider();
    expect(pl.validate(settleBlock(many, 1n), DAY + REWARD_EPOCH_MS)).toMatch(/exceeds 256/);
  });

  it('accepts exactly the cap, so the bound is not off by one', () => {
    const exact = Array.from({ length: MAX_RECEIPTS_PER_SETTLEMENT },
      () => signedReceipt(generateKeyPair(), 1_000));
    const pl = ledgerWithProvider();
    expect(pl.validate(settleBlock(exact, 1n), DAY + REWARD_EPOCH_MS)).toBeNull();
  });
});
