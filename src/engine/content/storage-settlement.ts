/**
 * The two per-account records, and how they live on the chain.
 *
 * Lucian asked the concrete question: *how are the publish record and the
 * service record actually stored and updated?* This module is the answer, and
 * it is built on a mechanism the ledger already has rather than a new one.
 *
 * ## Where they live
 *
 * **The records themselves are off-chain and content-addressed.** The chain
 * carries only their **root hash**, one field each on the account:
 *
 * - `publishRoot` — commits to the account's own file index, as an uploader.
 *   What it stores and therefore what it burns.
 * - `serviceRoot` — commits to what it served, as a provider. What it is owed.
 *
 * Two roots rather than one because the roles have different authors and
 * different trust. A publish record is authored by its owner and is a
 * statement of intent — "these are my files". A service record is only
 * credible when it is built from receipts **other people signed**. Merging them
 * would let one signature cover both, which is the self-attestation defect the
 * whole design exists to remove.
 *
 * ## How an update is really an update
 *
 * The same way a balance is. Every block already carries `balance` as a *value*
 * rather than a delta, and `updates` already applies a signed patch to account
 * fields — the newest block wins, and older ones are history rather than state.
 * A settlement writes ONE block carrying the new roots, and the previous roots
 * are superseded completely.
 *
 * So the chain grows by one block per settlement — not per read, not per file.
 * At a 30-day cadence with a minimum-claim threshold, that is a handful of
 * blocks per account per year against the heartbeat design's 2,555.
 *
 * ## What makes it unforgeable by the provider
 *
 * The provider signs the block — it is on its own chain, and the payout is to
 * it. But it **cannot choose the numbers**. `settlementFromReceipts` derives
 * the credited bytes from reader-signed receipts, and `validateSettlement`
 * re-derives them from the same evidence. A provider that writes a larger
 * figure produces a block every other node rejects.
 *
 * That is the whole inversion: the provider owns the record, and the readers
 * own its contents.
 */

import type { ReceiptLedger } from './read-receipts.js';
import { MIN_DISTINCT_READERS } from './read-receipts.js';

/** Account fields the settlement replaces. Both are hashes of off-chain records. */
export interface StorageRoots {
  /** Commits to the uploader's file index — what it stores, and so what it burns. */
  publishRoot?: string;
  /** Commits to the provider's service record — what it served, and so what it is owed. */
  serviceRoot?: string;
}

/**
 * What a settlement block claims.
 *
 * Every number here is DERIVED from evidence, never asserted. The block is a
 * commitment to a calculation anyone can repeat, which is why it can be signed
 * by the party being paid without that being a problem.
 */
export interface SettlementClaim extends StorageRoots {
  /** Credited bytes served since the previous settlement, after taper and caps. */
  creditedBytes: number;
  /** Distinct HUMANS who attested — sub-accounts already collapsed to roots. */
  distinctReaders: number;
  /** Logical bytes the account stores, from its own publish record. */
  storedBytes: number;
  /** The settlement period this covers. */
  periodIndex: number;
}

export interface SettlementOutcome {
  /** UNITS minted for service. */
  minted: number;
  /** UNITS burned for storage. */
  burned: number;
  net: number;
}

/**
 * Build a claim from reader-signed receipts.
 *
 * `creditedBytes` comes out of the ledger, which already applies the per-reader
 * cap and the distinct-reader floor. The provider's own view of how much it
 * served appears nowhere.
 */
export function settlementFromReceipts(args: {
  provider: string;
  receipts: ReceiptLedger;
  storedBytes: number;
  periodIndex: number;
  roots: StorageRoots;
  /** Collapses sub-account keys to their human. */
  rootOf?: (id: string) => string;
}): SettlementClaim {
  const e = args.receipts.earnings(args.provider);
  return {
    ...args.roots,
    creditedBytes: e.payableBytes,
    distinctReaders: e.distinctReaders,
    storedBytes: args.storedBytes,
    periodIndex: args.periodIndex,
  };
}

/**
 * Re-derive the claim from the same evidence and reject any disagreement.
 *
 * Returns an error string, or null when the block may be applied. Every
 * rejection says why — a silent refusal is indistinguishable from a block that
 * never arrived.
 */
export function validateSettlement(args: {
  claim: SettlementClaim;
  provider: string;
  receipts: ReceiptLedger;
  /** The stored figure the validator computes from the account's publish record. */
  expectedStoredBytes: number;
  previousPeriodIndex: number;
}): string | null {
  const { claim } = args;
  if (!Number.isFinite(claim.creditedBytes) || claim.creditedBytes < 0) {
    return 'creditedBytes must be a finite, non-negative number';
  }
  if (claim.periodIndex <= args.previousPeriodIndex) {
    // A settlement may never re-cover a period: baselines have already moved,
    // so replaying one would pay twice for the same bytes.
    return `period ${claim.periodIndex} is not after ${args.previousPeriodIndex}`;
  }

  const derived = args.receipts.earnings(args.provider);
  if (claim.creditedBytes > derived.payableBytes) {
    // The one check that makes the provider's signature harmless.
    return `claimed ${claim.creditedBytes} credited bytes, receipts support ${derived.payableBytes}`;
  }
  if (claim.distinctReaders !== derived.distinctReaders) {
    return `claimed ${claim.distinctReaders} distinct readers, receipts show ${derived.distinctReaders}`;
  }
  if (derived.distinctReaders < MIN_DISTINCT_READERS && claim.creditedBytes > 0) {
    return `only ${derived.distinctReaders} distinct reader(s) — below the floor of ${MIN_DISTINCT_READERS}`;
  }
  if (claim.storedBytes !== args.expectedStoredBytes) {
    // Storage is what gets BURNED, so under-reporting it is the profitable
    // lie — the mirror of over-reporting what was served.
    return `claimed ${claim.storedBytes} stored bytes, publish record shows ${args.expectedStoredBytes}`;
  }
  return null;
}

/**
 * Mint and burn for one settlement, under the fixed store/serve exchange rate.
 *
 * Both sides in one place so they cannot drift: the same block that pays for
 * service charges for storage, and a provider storing more than it serves
 * settles negative.
 */
export function settlementOutcome(args: {
  claim: SettlementClaim;
  mintPerByteServed: number;
  costRatio: number;
  /** Bytes the account stores for free, not charged. */
  freeBytes: number;
}): SettlementOutcome {
  const minted = args.claim.creditedBytes * args.mintPerByteServed;
  const chargeable = Math.max(0, args.claim.storedBytes - args.freeBytes);
  const burned = chargeable * args.mintPerByteServed * args.costRatio;
  return { minted, burned, net: minted - burned };
}
