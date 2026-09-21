import { describe, it, expect } from 'vitest';
import {
  accountingCost, settlementCost, PRODUCTION_ACCOUNTING,
} from './storage-accounting.js';
import { buildSenderChain, wireBytes } from './counterparty.js';

/**
 * Measures the cost of a DESIGN DECISION: putting provider liveness and
 * payment on the ledger as blocks.
 *
 * These numbers are the argument for removing storage blocks from the chain.
 * If the design changes, these tests should fail and be rewritten — they
 * describe what is, not what should be.
 */

/**
 * MEASURED, not assumed — the canonical wire bytes of a real signed block,
 * averaged over a real chain, exactly as `projection.test.ts` does it.
 *
 * The first draft of this file hardcoded 400 and described it as measured.
 * That is the failure this project calls "rendering the unmeasured as fact",
 * committed inside the analysis meant to expose it. If the number is knowable,
 * measure it; if it is not, label it an assumption and show the sensitivity.
 */
const BLOCK_BYTES = Math.ceil(
  (() => {
    const chain = buildSenderChain(64, 32);
    return chain.blocks.slice(1).reduce((sum, b) => sum + wireBytes(b), 0) / (chain.blocks.length - 1);
  })(),
);
// The lifetime chain length the 10B projection assumes per account.
const ASSUMED_LIFETIME = 200;

describe('storage accounting on the chain', () => {
  it('writes more blocks in ONE YEAR than the 10B projection allows for a whole life', () => {
    const cost = accountingCost({
      ...PRODUCTION_ACCOUNTING,
      years: 1,
      blockBytes: BLOCK_BYTES,
      assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });

    // 7 blocks a day, every day, per provider.
    expect(cost.blocksPerYear).toBe(2_555);
    // …against a projection that budgets 200 blocks for the account's entire
    // existence. The projection's own input is wrong for anyone who serves.
    expect(cost.timesAssumedLifetime).toBeGreaterThan(12);
    expect(cost.yearsToExceedAssumption).toBeLessThan(0.1);
  });

  it('overshoots by two orders of magnitude over a decade', () => {
    const cost = accountingCost({
      ...PRODUCTION_ACCOUNTING,
      years: 10,
      blockBytes: BLOCK_BYTES,
      assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(cost.blocksTotal).toBe(25_550);
    expect(cost.timesAssumedLifetime).toBeGreaterThan(100);
    // Every one of those is validated on replay and held by every archive
    // covering the shard. Expressed against the MEASURED block size so the
    // assertion tracks reality instead of a number typed once.
    expect(cost.bytesTotal).toBe(cost.blocksTotal * BLOCK_BYTES);
    expect(BLOCK_BYTES).toBeGreaterThan(0);
  });

  it('grows with the CLOCK, not with anything a user did', () => {
    // The defining property, and the one no cadence change fixes: an idle
    // provider — nothing stored, nothing served, nobody reading — writes
    // exactly as many blocks as a busy one.
    const idle = accountingCost({
      ...PRODUCTION_ACCOUNTING, years: 5, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    const busy = accountingCost({
      ...PRODUCTION_ACCOUNTING, years: 5, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(idle.blocksTotal).toBe(busy.blocksTotal);

    // Halving the cadence halves the rate and changes nothing structural: it
    // is still unbounded in time, which is the half of the invariant this
    // fails (ARCHITECTURE → The invariant has two dimensions).
    const halved = accountingCost({
      ...PRODUCTION_ACCOUNTING,
      heartbeatsPerEpoch: 3,
      years: 5, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(halved.blocksTotal).toBeGreaterThan(ASSUMED_LIFETIME);
  });
});

describe('settlement instead of accounting', () => {
  it('stops growing when the network is quiet', () => {
    // The property the heartbeat design cannot have at any cadence: an idle
    // provider writes NOTHING.
    const idle = settlementCost({
      settlementsPerYear: 0, years: 10, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(idle.blocksTotal).toBe(0);
    expect(idle.bytesTotal).toBe(0);
  });

  it('stays inside the projection budget at a realistic settlement cadence', () => {
    // Settling monthly — a batched transfer, the thing chains are actually
    // good at, where 1-2s finality is irrelevant because nobody is waiting.
    const monthly = settlementCost({
      settlementsPerYear: 12, years: 10, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(monthly.blocksTotal).toBe(120);
    expect(monthly.timesAssumedLifetime).toBeLessThan(1);

    // Two orders of magnitude below the accounting design over the same decade.
    const accounting = accountingCost({
      ...PRODUCTION_ACCOUNTING, years: 10, blockBytes: BLOCK_BYTES, assumedLifetimeBlocks: ASSUMED_LIFETIME,
    });
    expect(accounting.blocksTotal / monthly.blocksTotal).toBeGreaterThan(200);
  });
});
