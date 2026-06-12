import type { Hex } from '../core/hash.js';

/**
 * Modest, capped reward inflation — the incentive layer.
 *
 * Each epoch a bounded amount of new UNIT is minted and split among active
 * contributors (validators who produced/voted, storage providers with receipts)
 * in proportion to a contribution weight. Two guards keep this from diluting
 * holders or being gamed:
 *   - emission is capped at `inflationPpm` parts-per-million of current supply
 *     (with a small absolute floor for the bootstrap phase when supply is tiny);
 *   - nothing is minted when there are no contributors.
 *
 * This is the "allow modest minting for rewards" decision from the roadmap: the
 * 1M free mint is the primary issuance; this is the bounded top-up that funds the
 * bonded validators / super-nodes / storage providers that secure and serve the
 * network.
 */

export interface RewardConfig {
  /** Max emission per epoch as parts-per-million of current supply. */
  inflationPpm: bigint;
  /** Absolute minimum emission per epoch (bootstrap). */
  baseEmission: bigint;
}

export interface Distribution {
  minted: bigint;
  perRecipient: Map<Hex, bigint>;
}

export class RewardLedger {
  private supply: bigint;
  private readonly earned = new Map<Hex, bigint>();

  constructor(initialSupply: bigint, private readonly cfg: RewardConfig) {
    this.supply = initialSupply;
  }

  totalSupply(): bigint {
    return this.supply;
  }

  earnedBy(id: Hex): bigint {
    return this.earned.get(id) ?? 0n;
  }

  /** The capped emission this epoch given current supply. */
  epochEmission(): bigint {
    const byRate = (this.supply * this.cfg.inflationPpm) / 1_000_000n;
    return byRate > this.cfg.baseEmission ? byRate : this.cfg.baseEmission;
  }

  /**
   * Mint the epoch's emission and split it across contributors by weight. Weights
   * are arbitrary positive numbers (e.g. voting weight, receipts served); only
   * their ratios matter. Returns the amount actually minted (≤ epochEmission; dust
   * from integer division is left unminted).
   */
  distribute(contributions: Map<Hex, number>): Distribution {
    const perRecipient = new Map<Hex, bigint>();
    const emission = this.epochEmission();
    if (emission <= 0n || contributions.size === 0) return { minted: 0n, perRecipient };

    // Scale float weights to integers to keep the split deterministic and exact.
    const scaled = new Map<Hex, bigint>();
    let totalScaled = 0n;
    for (const [id, w] of contributions) {
      if (w <= 0) continue;
      const s = BigInt(Math.max(1, Math.floor(w * 1_000_000)));
      scaled.set(id, s);
      totalScaled += s;
    }
    if (totalScaled === 0n) return { minted: 0n, perRecipient };

    let minted = 0n;
    for (const [id, s] of scaled) {
      const share = (emission * s) / totalScaled;
      if (share > 0n) {
        perRecipient.set(id, share);
        this.earned.set(id, this.earnedBy(id) + share);
        minted += share;
      }
    }
    this.supply += minted;
    return { minted, perRecipient };
  }
}
