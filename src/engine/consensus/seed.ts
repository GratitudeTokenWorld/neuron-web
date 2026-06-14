import { hash, hashHex, hexToBytes, utf8ToBytes, type Hex } from '../core/hash.js';

/**
 * Accumulated-VRF epoch seed — the randomness that drives self-sortition
 * ({@link ./sortition}) WITHOUT a beacon node or coordinator (which would be a
 * single point of failure / bias).
 *
 *   seed[e+1] = H( seed[e] ‖ sorted committee VRF betas revealed during epoch e )
 *
 * Each committee member's beta is a VRF output it CANNOT choose (uniqueness), so
 * no participant can steer the next seed toward a committee it controls. The seed
 * is therefore intrinsic to the validator set: every honest node that observes the
 * same set of revealed betas derives the same next seed, and the value is
 * unpredictable until those betas are revealed.
 *
 * Betas are sorted + de-duplicated before hashing so the result is independent of
 * gossip arrival order (all nodes converge) and of a member voting twice.
 *
 * KNOWN RESIDUAL (roadmap, not this slice): a "last revealer" can bias the seed by
 * choosing whether to reveal its beta (withhold-or-publish = 1 bit of influence per
 * member). Standard mitigations — VRF-with-commit-reveal, a longer accumulation
 * window, or requiring reveals before seats count — are deferred; the fraud-proof
 * safety layer remains the backstop regardless of seed bias. Whether betas
 * accumulate per-shard or globally is a V5 wiring decision; this module is the pure
 * derivation either way.
 */

/** Fixed genesis seed for epoch 0. Domain-separated and versioned. */
export const GENESIS_SEED: Hex = hashHex(utf8ToBytes('neuron-epoch-seed/genesis/v1'));

/**
 * Derive the next epoch's seed from this epoch's seed + the committee betas
 * revealed during it. Pure, deterministic, order- and duplicate-independent.
 */
export function deriveNextSeed(prevSeed: Hex, betas: readonly Hex[]): Hex {
  const unique = [...new Set(betas)].sort();
  // All parts are fixed-length (32-byte seed + 32-byte betas), so concatenation is
  // unambiguous without delimiters.
  const parts = [hexToBytes(prevSeed), ...unique.map((b) => hexToBytes(b))];
  return hashHex(...parts);
}

/**
 * The chain of epoch seeds. Seeds are produced strictly in order: epoch e+1 cannot
 * be derived until epoch e's contributing betas are committed.
 */
export class EpochSeeds {
  private readonly seeds = new Map<number, Hex>();

  constructor(genesis: Hex = GENESIS_SEED) {
    this.seeds.set(0, genesis);
  }

  /** Seed for `epoch`, or undefined if not yet derived. */
  seedFor(epoch: number): Hex | undefined {
    return this.seeds.get(epoch);
  }

  /** Highest epoch whose seed is known. */
  get currentEpoch(): number {
    let max = 0;
    for (const e of this.seeds.keys()) if (e > max) max = e;
    return max;
  }

  /**
   * Commit epoch `epoch`'s revealed betas, producing (and storing) the seed for
   * `epoch + 1`. Idempotent for the same betas; throws if `epoch`'s seed is unknown
   * (seeds must be built in order). Returns the next seed.
   */
  commit(epoch: number, betas: readonly Hex[]): Hex {
    const prev = this.seeds.get(epoch);
    if (prev === undefined) throw new Error(`cannot commit epoch ${epoch}: its seed is unknown`);
    const next = deriveNextSeed(prev, betas);
    this.seeds.set(epoch + 1, next);
    return next;
  }
}

/** Default epoch length in blocks (height-based epochs). Tunable. */
export const EPOCH_BLOCKS = 1024;

/** Which epoch a given chain height falls in. */
export function epochOfHeight(height: number, epochBlocks: number = EPOCH_BLOCKS): number {
  return Math.floor(Math.max(0, height) / epochBlocks);
}
