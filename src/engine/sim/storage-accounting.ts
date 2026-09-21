/**
 * What storage ACCOUNTING costs the chain, measured rather than argued.
 *
 * The other sims in this directory measure what the network does. This one
 * measures what a design decision costs: putting provider liveness and payment
 * on the ledger as blocks.
 *
 * Today a provider writes `storage-heartbeat` blocks on its own chain at a
 * fixed cadence and one `storage-reward` per epoch. Those blocks are not
 * driven by anything a user did — they accrue with **time**. A provider that
 * serves nobody, stores nothing new and is read by no one still writes them,
 * forever.
 *
 * That is the second dimension of the invariant (ARCHITECTURE.md → *The
 * invariant has two dimensions*) failing inside the ledger itself: bounded at
 * any instant, unbounded over time, and growing at a rate no user action
 * controls.
 *
 * The number that matters is the comparison. `projection.ts` models 10B users
 * assuming **200 lifetime blocks per account**; this module computes how long
 * storage accounting alone takes to exceed that, and by how much it overshoots
 * over a realistic operating life.
 *
 * Pure arithmetic over measured constants, like `projection.ts` — no crypto and
 * no I/O, so it runs in the unit suite and its assumptions are visible.
 */

export interface AccountingAssumptions {
  /** Liveness proofs a provider writes per epoch (`MAX_HEARTBEATS_PER_EPOCH`). */
  heartbeatsPerEpoch: number;
  /** Reward claims per epoch — one, by the claimable-epoch rule. */
  rewardsPerEpoch: number;
  /** Epochs in a year. An epoch is a day at production timing. */
  epochsPerYear: number;
  /** Years of operation to project. */
  years: number;
  /** Measured canonical bytes of one engine block. */
  blockBytes: number;
  /** The lifetime chain length `projection.ts` assumes per account. */
  assumedLifetimeBlocks: number;
}

export interface AccountingCost {
  /** Blocks written per provider per year, by the clock alone. */
  blocksPerYear: number;
  /** Blocks after `years`. */
  blocksTotal: number;
  /** Bytes those blocks occupy on the provider's chain and in every archive. */
  bytesTotal: number;
  /**
   * How many times over the accounting exceeds the whole-life chain length the
   * 10B projection assumes. Above 1 means the projection's own input is wrong
   * for any account that serves storage.
   */
  timesAssumedLifetime: number;
  /** Years until accounting alone exceeds the assumed lifetime chain. */
  yearsToExceedAssumption: number;
}

export function accountingCost(a: AccountingAssumptions): AccountingCost {
  const blocksPerYear = (a.heartbeatsPerEpoch + a.rewardsPerEpoch) * a.epochsPerYear;
  const blocksTotal = blocksPerYear * a.years;
  return {
    blocksPerYear,
    blocksTotal,
    bytesTotal: blocksTotal * a.blockBytes,
    timesAssumedLifetime: blocksTotal / a.assumedLifetimeBlocks,
    yearsToExceedAssumption: a.assumedLifetimeBlocks / blocksPerYear,
  };
}

/**
 * The alternative being weighed: nothing on the chain except settlement.
 *
 * Liveness is established by the data path (a provider that answers reads is
 * demonstrably holding and serving; one that does not, is not), and payment is
 * a normal transfer made when a balance is actually settled — batched, and
 * driven by USE rather than by the clock.
 *
 * The point of this function is not that the number is small. It is that the
 * number is a function of **activity**, so an idle provider writes nothing and
 * the chain stops growing when the network is quiet. That is the property the
 * heartbeat design cannot have at any cadence.
 */
export function settlementCost(args: {
  settlementsPerYear: number;
  years: number;
  blockBytes: number;
  assumedLifetimeBlocks: number;
}): AccountingCost {
  const blocksPerYear = args.settlementsPerYear;
  const blocksTotal = blocksPerYear * args.years;
  return {
    blocksPerYear,
    blocksTotal,
    bytesTotal: blocksTotal * args.blockBytes,
    timesAssumedLifetime: blocksTotal / args.assumedLifetimeBlocks,
    yearsToExceedAssumption: blocksPerYear === 0
      ? Infinity
      : args.assumedLifetimeBlocks / blocksPerYear,
  };
}

/** Production defaults: 6 heartbeats + 1 reward per daily epoch. */
export const PRODUCTION_ACCOUNTING: Omit<AccountingAssumptions, 'blockBytes' | 'years' | 'assumedLifetimeBlocks'> = {
  heartbeatsPerEpoch: 6,
  rewardsPerEpoch: 1,
  epochsPerYear: 365,
};
