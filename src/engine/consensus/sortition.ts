import { utf8ToBytes, hexToBytes, type Hex } from '../core/hash.js';
import { vrfProve, vrfVerify } from './vrf.js';

/**
 * Weighted VRF self-sortition (Algorand-style cryptographic sortition).
 *
 * Instead of a coordinator sampling a committee from a beacon seed
 * ({@link ./committee} `selectCommittee` — the beacon is a SPOF), each validator
 * sorts ITSELF in: it runs a VRF over (seed ‖ epoch ‖ shard) and the output maps
 * to a number of committee "seats" it has won, scaled by its voting weight. The
 * VRF proof `pi` lets anyone verify that seat count against the validator's public
 * key — no one can grind their own membership (VRF uniqueness) and no one can
 * predict a future committee (VRF pseudorandomness). No beacon, no coordinator.
 *
 * Seat count follows the binomial B(units, p): a validator of integer weight
 * `units` holds that many independent lottery tickets, each winning with
 * probability p = committeeSize / totalWeight. So the EXPECTED total seats across
 * all validators is committeeSize, and an attacker holding fraction f of total
 * weight wins ≈ f of the committee (random sampling ⇒ taking one shard needs a
 * near-global majority — see {@link ./committee} rationale). The mapping is a pure,
 * deterministic function of (beta, weight, totalWeight, committeeSize), so every
 * node computes an identical seat count for a given proof.
 *
 * Builds on the spec-verified {@link ./vrf} ECVRF primitive.
 */

/** Domain-separated VRF input for a sortition draw. */
export function sortitionAlpha(seed: string, epoch: number, shard: number): Uint8Array {
  return utf8ToBytes(`neuron-sortition:${seed}:${epoch}:${shard}`);
}

/**
 * Map a VRF output to a uniform double in [0, 1). Uses the top 48 bits of beta —
 * exactly representable in a float64 mantissa, so the result is bit-identical on
 * every node (collision probability is negligible at 2^-48).
 */
function betaToRatio(betaHex: Hex): number {
  const b = hexToBytes(betaHex);
  let v = 0;
  for (let i = 0; i < 6; i++) v = v * 256 + (b[i] ?? 0);
  return v / 2 ** 48;
}

/**
 * Inverse binomial CDF: the smallest k whose cumulative B(·; units, p) mass exceeds
 * `ratio`. Computed incrementally (pmf(k) = pmf(k-1)·(units-k+1)/k·p/(1-p)) to avoid
 * binomial-coefficient overflow. This is the standard Algorand sortition rule.
 */
function selectedSeats(ratio: number, units: number, p: number): number {
  if (p <= 0 || units <= 0) return 0;
  if (p >= 1) return units;

  let pmf = Math.pow(1 - p, units); // B(0; units, p)
  let cum = pmf;
  let k = 0;
  const odds = p / (1 - p);
  while (ratio >= cum && k < units) {
    k += 1;
    pmf *= ((units - k + 1) / k) * odds;
    cum += pmf;
  }
  return k;
}

/** Quantise a float voting weight to an integer number of lottery tickets (≥ 1). */
function weightToUnits(weight: number): number {
  return Math.max(1, Math.round(weight));
}

/**
 * How many committee seats `beta` wins for a validator of `weight`, given the
 * shard's `totalWeight` and the target `committeeSize`. Pure + deterministic.
 */
export function seatsFromBeta(
  betaHex: Hex,
  weight: number,
  totalWeight: number,
  committeeSize: number,
): number {
  if (totalWeight <= 0 || committeeSize <= 0) return 0;
  const p = Math.min(1, committeeSize / totalWeight);
  return selectedSeats(betaToRatio(betaHex), weightToUnits(weight), p);
}

export interface SortitionProof {
  /** Number of committee seats won (0 ⇒ not selected). */
  seats: number;
  /** VRF proof of the draw, hex. */
  pi: Hex;
  /** VRF output the seat count derives from, hex. */
  beta: Hex;
}

/**
 * Self-sortition: prove how many committee seats this key wins for (seed, epoch,
 * shard) at the given weight. `seats === 0` means "drew nothing this epoch".
 */
export function proveSortition(
  privHex: Hex,
  seed: string,
  epoch: number,
  shard: number,
  weight: number,
  totalWeight: number,
  committeeSize: number,
): SortitionProof {
  const { pi, beta } = vrfProve(privHex, sortitionAlpha(seed, epoch, shard));
  const seats = seatsFromBeta(beta, weight, totalWeight, committeeSize);
  return { seats, pi, beta };
}

/**
 * Verify a claimed sortition: returns the seat count (≥ 0) iff `pi` is a valid VRF
 * proof by `pubHex` for (seed, epoch, shard); null if the proof is invalid. The
 * caller must independently trust `weight`/`totalWeight` (from validator state).
 */
export function verifySortition(
  pubHex: Hex,
  seed: string,
  epoch: number,
  shard: number,
  weight: number,
  totalWeight: number,
  committeeSize: number,
  piHex: Hex,
): number | null {
  const beta = vrfVerify(pubHex, sortitionAlpha(seed, epoch, shard), piHex);
  if (beta === null) return null;
  return seatsFromBeta(beta, weight, totalWeight, committeeSize);
}
