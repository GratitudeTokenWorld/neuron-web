import { hashHex, utf8ToBytes, type Hex } from '../core/hash.js';
import type { ValidatorRegistry } from './validators.js';

/**
 * Per-shard committee sortition.
 *
 * For each (shard, epoch) a committee is sampled from the GLOBAL validator pool —
 * NOT from the accounts that happen to live in that shard. Each validator gets a
 * pseudo-random "ticket" = H(seed ‖ epoch ‖ shard ‖ validatorId); the lowest
 * tickets form the committee. The `seed` comes from an unbiasable epoch randomness
 * beacon.
 *
 * Why this shape (see docs/ARCHITECTURE.md, Subsystem 2 / Defense-in-depth):
 *   - UNBIASABLE: membership depends on the external seed, so it is unpredictable
 *     until the seed is revealed and cannot be ground out in advance.
 *   - NON-GRINDABLE PLACEMENT: a validator can't choose which shard it lands in —
 *     its ticket per shard is fixed by its id (a key bound to a unique human, so
 *     ids can't be cheaply ground either).
 *   - RANDOM SAMPLING: because committees are random global subsets, an attacker
 *     controlling fraction f of validators holds ≈ f of every committee. Taking a
 *     single shard therefore needs ≈ a GLOBAL majority, not a cheap local one —
 *     this is what defeats single-shard takeover.
 *
 * PRODUCTION NOTE: replace the string seed with a real distributed randomness
 * beacon and per-validator VRF proofs (so each member can prove its own selection
 * without revealing the others); the selection rule is otherwise unchanged.
 */

export interface CommitteeOptions {
  /** Target committee size. */
  committeeSize: number;
  /** Below this many eligible validators a shard cannot be safely operated. */
  minCommitteeSize: number;
  /** Optional floor on summed voting weight (aggregate seniority) of the committee. */
  minAggregateWeight?: number;
}

export interface Committee {
  shard: number;
  epoch: number;
  members: Hex[];
  totalWeight: number;
  /** Per-member voting weight, aligned with `members`. */
  weights: number[];
  /** False if the committee could not be safely formed (too few / too junior). */
  safe: boolean;
  reason?: string;
}

function ticket(seed: string, epoch: number, shard: number, id: Hex): Hex {
  return hashHex(utf8ToBytes(`${seed}:${epoch}:${shard}:${id}`));
}

export function selectCommittee(
  registry: ValidatorRegistry,
  shard: number,
  epoch: number,
  seed: string,
  opts: CommitteeOptions,
): Committee {
  const eligible = registry.validators();
  const base: Committee = { shard, epoch, members: [], totalWeight: 0, weights: [], safe: true };

  if (eligible.length < opts.minCommitteeSize) {
    return { ...base, safe: false, reason: `too few validators (${eligible.length} < ${opts.minCommitteeSize})` };
  }

  const ranked = eligible
    .map((id) => ({ id, t: ticket(seed, epoch, shard, id) }))
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  const members = ranked.slice(0, opts.committeeSize).map((x) => x.id);
  const weights = members.map((id) => registry.weightOf(id));
  const totalWeight = weights.reduce((s, w) => s + w, 0);

  let safe = true;
  let reason: string | undefined;
  if (members.length < opts.minCommitteeSize) {
    safe = false;
    reason = 'committee smaller than minimum';
  } else if (opts.minAggregateWeight !== undefined && totalWeight < opts.minAggregateWeight) {
    safe = false;
    reason = `insufficient aggregate seniority (${totalWeight.toFixed(1)} < ${opts.minAggregateWeight})`;
  }

  return { shard, epoch, members, totalWeight, weights, safe, reason };
}

/** Convenience: is `id` on the committee for (shard, epoch)? */
export function isOnCommittee(committee: Committee, id: Hex): boolean {
  return committee.members.includes(id);
}
