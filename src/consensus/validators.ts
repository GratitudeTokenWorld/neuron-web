import type { Hex } from '../core/hash.js';
import { votingWeight, STAKE_CAP } from './weight.js';

/**
 * The validator set: per-account bonded stake + activity-age, with bonding rules
 * and slashing. This is the on-chain state that consensus weight, committee
 * sortition, slashing, and the rate limiter all read from.
 *
 * Bonding rules (see docs/ARCHITECTURE.md, Subsystem 2):
 *   - bonding is opt-in and LOCKED while bonded (a human secures the network OR
 *     spends their mint, not both);
 *   - bonded stake is CAPPED per account (= the free mint);
 *   - a slashed validator's bond is burned and it is barred from re-counting.
 */

export interface ValidatorState {
  bonded: bigint;
  activityEpochs: number;
  slashed: boolean;
}

export class ValidatorRegistry {
  private readonly state = new Map<Hex, ValidatorState>();

  /**
   * @param cap     max bonded stake per account (default = free mint).
   * @param minBond minimum bond to be an eligible (committee-selectable) validator.
   *   NOTE: the roadmap's capital-gate refinement requires this minimum to be
   *   EARNED stake rather than the raw free mint; that policy is enforced by the
   *   caller deciding what it bonds. Here it is simply a threshold.
   */
  constructor(
    private readonly cap: bigint = STAKE_CAP,
    private readonly minBond: bigint = 1n,
  ) {}

  private ensure(id: Hex): ValidatorState {
    let s = this.state.get(id);
    if (!s) {
      s = { bonded: 0n, activityEpochs: 0, slashed: false };
      this.state.set(id, s);
    }
    return s;
  }

  bond(id: Hex, amount: bigint): { ok: boolean; reason?: string } {
    if (amount <= 0n) return { ok: false, reason: 'bond amount must be positive' };
    const s = this.ensure(id);
    if (s.slashed) return { ok: false, reason: 'validator is slashed' };
    if (s.bonded + amount > this.cap) return { ok: false, reason: `bond exceeds cap (${this.cap})` };
    s.bonded += amount;
    return { ok: true };
  }

  unbond(id: Hex, amount: bigint): { ok: boolean; reason?: string } {
    const s = this.state.get(id);
    if (!s || amount <= 0n || amount > s.bonded) return { ok: false, reason: 'invalid unbond amount' };
    s.bonded -= amount;
    return { ok: true };
  }

  /** Credit one or more epochs of sustained participation (activity-based age). */
  creditActivity(id: Hex, epochs = 1): void {
    if (epochs <= 0) return;
    this.ensure(id).activityEpochs += epochs;
  }

  /** Slash a validator: burn its entire bond and bar it. Returns the amount burned. */
  slash(id: Hex): bigint {
    const s = this.ensure(id);
    const burned = s.bonded;
    s.bonded = 0n;
    s.slashed = true;
    return burned;
  }

  bondedOf(id: Hex): bigint {
    return this.state.get(id)?.bonded ?? 0n;
  }

  activityOf(id: Hex): number {
    return this.state.get(id)?.activityEpochs ?? 0;
  }

  isSlashed(id: Hex): boolean {
    return this.state.get(id)?.slashed ?? false;
  }

  /** Eligible to be sampled into committees: bonded ≥ minBond and not slashed. */
  isValidator(id: Hex): boolean {
    const s = this.state.get(id);
    return !!s && !s.slashed && s.bonded >= this.minBond;
  }

  weightOf(id: Hex): number {
    const s = this.state.get(id);
    if (!s || s.slashed) return 0;
    return votingWeight(s.bonded, s.activityEpochs);
  }

  /** All currently-eligible validators. */
  validators(): Hex[] {
    const out: Hex[] = [];
    for (const [id, s] of this.state) {
      if (!s.slashed && s.bonded >= this.minBond) out.push(id);
    }
    return out;
  }
}
