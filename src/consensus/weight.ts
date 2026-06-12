import { MINT_AMOUNT } from '../core/block.js';

/**
 * Voting weight — age-weighted personhood.
 *
 *   weight = ageMultiplier(activity) × stakeWeight(bonded, capped)
 *
 * Design (see docs/ARCHITECTURE.md, Subsystem 2):
 *   - Stake is CAPPED at the free-mint amount, so no whale can out-bond anyone.
 *     With cap = mint, the stake term is ≈ flat for committed validators and AGE
 *     is the real differentiator → "one verified human, one age-weighted vote".
 *   - Stake is weighted CONCAVELY (√). That is only safe because one human = one
 *     account: see {@link splittingIsProfitableWithoutOneHumanOneAccount}. Pure-PoS
 *     chains can't use concave weight (a whale would split into a Sybil swarm); the
 *     identity layer is precisely what unlocks it here.
 *   - Age is ACTIVITY-based and SATURATING, so it rewards sustained participation
 *     without creating immortal early-cohort oligarchs, and resists sleeper/aged-
 *     account farming.
 */

/** Max bonded stake counted toward weight, per account. Equal to the free mint. */
export const STAKE_CAP = MINT_AMOUNT;

/** Active epochs needed for the age multiplier to fully mature. */
export const AGE_SATURATION_EPOCHS = 52;

/** A fully-aged validator counts this many times a brand-new one (same stake). */
export const MAX_AGE_MULTIPLIER = 4;

/** Saturating, activity-based age multiplier in [1, MAX_AGE_MULTIPLIER]. */
export function ageMultiplier(activityEpochs: number): number {
  const a = Math.max(0, Math.min(activityEpochs, AGE_SATURATION_EPOCHS));
  return 1 + (MAX_AGE_MULTIPLIER - 1) * (a / AGE_SATURATION_EPOCHS);
}

/** Concave (√) stake weight of a bonded amount, capped at STAKE_CAP. */
export function stakeWeight(bonded: bigint, cap: bigint = STAKE_CAP): number {
  const capped = bonded < cap ? bonded : cap;
  return Math.sqrt(Number(capped));
}

/** Full voting weight of a validator. */
export function votingWeight(bonded: bigint, activityEpochs: number): number {
  return ageMultiplier(activityEpochs) * stakeWeight(bonded);
}

/**
 * Illustrates WHY one-human-one-account is a precondition for concave weighting:
 * splitting a stake `S` across `n` accounts multiplies total √-weight by √n. If
 * accounts could be Sybil'd freely this would be a fatal exploit; because each
 * human gets exactly one account, it cannot be done. Returned for documentation
 * and as a guarded invariant in tests — not used in production weighting.
 */
export function splittingIsProfitableWithoutOneHumanOneAccount(stake: bigint, splits: number): {
  single: number;
  split: number;
} {
  const single = stakeWeight(stake, stake + 1n); // no cap, to isolate the concavity effect
  const per = stake / BigInt(splits);
  const split = splits * stakeWeight(per, stake + 1n);
  return { single, split };
}
