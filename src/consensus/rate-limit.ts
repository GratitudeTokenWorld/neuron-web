import type { Hex } from '../core/hash.js';
import type { ValidatorRegistry } from './validators.js';
import { ageMultiplier, stakeWeight, STAKE_CAP } from './weight.js';

/**
 * Stake-bonded write/fork rate limit — the anti-spam moat.
 *
 * Block creation is not free: each account gets a per-epoch write budget that
 * scales with its bonded stake (concavely, √) and its activity-age. No wasted PoW,
 * no per-post fee; the cost of spamming forks is tied to the same scarce bond that
 * secures consensus. A spammer must bond (and risk) real stake to raise its budget.
 */

/** Floor budget so a minimally-bonded honest account can still act. */
export const MIN_WRITE_BUDGET = 2;
/** Divisor mapping √stake×age into a per-epoch budget (√1e6 = 1000 → up to ~40). */
const BUDGET_DIVISOR = 100;

export function writeBudget(bonded: bigint, activityEpochs: number): number {
  const scaled = (ageMultiplier(activityEpochs) * stakeWeight(bonded, STAKE_CAP)) / BUDGET_DIVISOR;
  return Math.max(MIN_WRITE_BUDGET, Math.floor(scaled));
}

/** Per-epoch consumption tracker. Rotate at each epoch boundary. */
export class RateLimiter {
  private used = new Map<Hex, number>();
  private epoch = 0;

  /** Advance to `epoch`, clearing consumption when it changes. */
  rotate(epoch: number): void {
    if (epoch !== this.epoch) {
      this.epoch = epoch;
      this.used.clear();
    }
  }

  budgetFor(registry: ValidatorRegistry, id: Hex): number {
    return writeBudget(registry.bondedOf(id), registry.activityOf(id));
  }

  consumed(id: Hex): number {
    return this.used.get(id) ?? 0;
  }

  /** Attempt to spend `cost` of `id`'s budget this epoch. Returns false if over budget. */
  tryConsume(registry: ValidatorRegistry, id: Hex, cost = 1): boolean {
    const used = this.used.get(id) ?? 0;
    if (used + cost > this.budgetFor(registry, id)) return false;
    this.used.set(id, used + cost);
    return true;
  }
}
