/**
 * Where to put the weight in the reward formula, and what people would earn.
 *
 * The formula under test (Lucian, 2026-09-22):
 *
 * ```
 * weight = custodyRate x verifiedBytesHeld  +  serviceRate x bytesServed
 * share  = weight / totalWeight
 * payout = share x cappedEmission
 * ```
 *
 * Two questions it has to answer, and they pull in opposite directions:
 *
 * 1. **Does cold content still get stored?** That needs the custody term to be
 *    worth enough on its own, or providers chase popularity and the tail dies
 *    (`incentive-coverage.ts`).
 * 2. **Is serving worth doing?** That needs the service term to be visible, or
 *    a provider's cheapest strategy is to hold bytes and refuse to serve them —
 *    which is the free-rider version of the same failure.
 *
 * The balance between them is a number, so it is measured here rather than
 * argued, and the projections carry their assumptions explicitly (PRINCIPLES.md
 * → 5).
 *
 * ## What is MEASURED and what is ASSUMED
 *
 * MEASURED, from elsewhere in the tree: emission is capped at `inflationPpm` of
 * supply and split proportionally (`economy/rewards.ts`); device concurrency
 * defaults (`content/device-capacity.ts`); the Zipf shape of demand
 * (`sim/demand-replication.ts`).
 *
 * ASSUMED, and every projection inherits them: the number of providers, the mix
 * of device classes, how much each holds, how much the network reads, and the
 * token's value. **None of these are measurements. A projection is not a
 * measurement**, and the sensitivity below is the honest part of the answer.
 */

export interface ProviderArchetype {
  name: string;
  /** Bytes this provider holds and can prove (B2 sampling). */
  bytesHeld: number;
  /** Bytes it serves per window. */
  bytesServed: number;
  /** How many of this kind exist. */
  count: number;
}

export interface FormulaWeights {
  /** Weight per byte held per window. */
  custodyRate: number;
  /** Weight per byte served. */
  serviceRate: number;
  /**
   * Concavity applied to the byte totals: `weight ∝ bytes^alpha`.
   *
   * `1` is linear and is what a naive formula does — and it makes a datacentre
   * earn ~14,000x a phone, which is Principle 1 failing in the economics rather
   * than in the code. Below 1 compresses that range and gives small devices a
   * reason to exist.
   *
   * **A concave weight has a Sybil incentive built into it**, because splitting
   * one large holding into N smaller ones earns `N^(1-alpha)` times more. That
   * is safe ONLY if the exponent is applied to the per-HUMAN total — see
   * `splittingGain` and `core/sub-accounts.ts`. Applied per key, it turns
   * sub-accounts into a yield-farming instrument.
   */
  alpha?: number;
}

export interface EarningsRow {
  name: string;
  /** This archetype's share of total network weight, per provider. */
  sharePerProvider: number;
  /** Units earned per window by ONE provider of this kind. */
  perWindow: number;
  /** …per year. */
  perYear: number;
  /** Share of its earnings that came from holding rather than serving. */
  custodyShare: number;
}

/**
 * Split a capped emission across archetypes by the formula.
 *
 * `emissionPerWindow` is the pool, not a per-provider rate: this is a
 * proportional split, so one provider earning more necessarily means others
 * earn less. That property is what makes wash-reading dilutive rather than
 * inflationary (CUSTODY-PROOFS.md → B5).
 */
export function projectEarnings(args: {
  archetypes: readonly ProviderArchetype[];
  weights: FormulaWeights;
  emissionPerWindow: number;
  windowsPerYear: number;
}): { rows: EarningsRow[]; totalWeight: number } {
  const { archetypes, weights, emissionPerWindow, windowsPerYear } = args;
  const alpha = weights.alpha ?? 1;
  const shape = (x: number) => (alpha === 1 ? x : Math.pow(Math.max(0, x), alpha));
  const weightOf = (a: ProviderArchetype) =>
    weights.custodyRate * shape(a.bytesHeld) + weights.serviceRate * shape(a.bytesServed);

  const totalWeight = archetypes.reduce((sum, a) => sum + weightOf(a) * a.count, 0);
  const rows = archetypes.map(a => {
    const w = weightOf(a);
    const share = totalWeight > 0 ? w / totalWeight : 0;
    const perWindow = share * emissionPerWindow;
    const custodyPart = weights.custodyRate * shape(a.bytesHeld);
    return {
      name: a.name,
      sharePerProvider: share,
      perWindow,
      perYear: perWindow * windowsPerYear,
      custodyShare: w > 0 ? custodyPart / w : 0,
    };
  });
  return { rows, totalWeight };
}

/**
 * The balance question, as one number.
 *
 * Returns the fraction of a typical provider's earnings that comes from
 * holding. At 1 the service term is invisible and nobody has a reason to
 * answer a read; at 0 the custody term is invisible and cold content is
 * abandoned. Neither extreme is survivable, which is why this is a ratio to
 * tune rather than a choice between two designs.
 */
export function custodyShareOfEarnings(args: {
  weights: FormulaWeights;
  bytesHeld: number;
  bytesServed: number;
}): number {
  const custody = args.weights.custodyRate * args.bytesHeld;
  const service = args.weights.serviceRate * args.bytesServed;
  const total = custody + service;
  return total > 0 ? custody / total : 0;
}

/**
 * Is refusing to serve profitable?
 *
 * The free-rider check on the other side of the coverage result. A provider
 * that holds bytes but declines reads saves bandwidth and keeps its custody
 * earnings; if the service term is too small, that is the rational strategy and
 * the network becomes a write-only archive.
 *
 * Returns the ratio of what a serving provider earns to what an identical
 * hoarding one earns. At or below 1, serving is not worth doing.
 */
export function servingPremium(args: {
  weights: FormulaWeights;
  bytesHeld: number;
  bytesServed: number;
}): number {
  const hoarder = args.weights.custodyRate * args.bytesHeld;
  const server = hoarder + args.weights.serviceRate * args.bytesServed;
  return hoarder > 0 ? server / hoarder : Infinity;
}

/** A plausible fleet, for projections. ASSUMED in every term. */
export const DEFAULT_FLEET: ProviderArchetype[] = [
  // A phone: a little storage, serves rarely, often asleep.
  { name: 'phone', bytesHeld: 2 * 1024 ** 3, bytesServed: 200 * 1024 ** 2, count: 600_000 },
  // A laptop: a spare partition, serves while awake.
  { name: 'laptop', bytesHeld: 50 * 1024 ** 3, bytesServed: 5 * 1024 ** 3, count: 300_000 },
  // A home server or NAS: always on.
  { name: 'home server', bytesHeld: 2 * 1024 ** 4, bytesServed: 100 * 1024 ** 3, count: 90_000 },
  // A datacentre node: large and busy.
  { name: 'datacentre', bytesHeld: 50 * 1024 ** 4, bytesServed: 5 * 1024 ** 4, count: 10_000 },
];


/**
 * How much more an identical holding earns when split across `splits`
 * identities under a concave weight.
 *
 * `N^(1-alpha)`. At `alpha = 1` it is 1 — linear weighting has no splitting
 * incentive at all, which is its one virtue. At `alpha = 0.5`, splitting into
 * four earns double for the same bytes.
 *
 * This is the reason concavity is dangerous and the reason the exponent must be
 * applied to the per-HUMAN total: splitting then requires more humans, and the
 * identity gate is what prices them. Applied per key, with sub-accounts
 * available, it would be free.
 */
export function splittingGain(splits: number, alpha: number): number {
  if (splits <= 1) return 1;
  return Math.pow(splits, 1 - alpha);
}

/** Ratio between the largest and smallest archetype's earnings. */
export function inequalityRatio(rows: readonly EarningsRow[]): number {
  const vals = rows.map(r => r.perYear).filter(v => v > 0);
  if (vals.length === 0) return 0;
  return Math.max(...vals) / Math.min(...vals);
}

// ── Claim cadence ────────────────────────────────────────────────────────────

/**
 * What a claim policy costs the chain, and what it demands of evidence
 * retention.
 *
 * Lucian, 2026-09-22: a 24 h manual floor means 365 claims per user per year;
 * auto-claiming once every 30 days and removing the manual option would be
 * better for the network. Measured here rather than argued.
 *
 * The second number is the one that is easy to miss. A claim must be
 * *validatable*, so the evidence behind it has to still exist when it lands.
 * Stretching the claim period stretches the retention requirement with it, and
 * evidence pruned too early does not produce a smaller payout — it produces a
 * block that every node rejects, which strands the chain behind it. That
 * failure is already documented for the reward path (`claimableEpochDay`).
 */
export function claimCost(args: {
  accounts: number;
  claimsPerYear: number;
  blockBytes: number;
  /** Windows of evidence that must survive for the claim to validate. */
  windowsPerYear: number;
}): {
  blocksPerAccountPerYear: number;
  blocksPerYear: number;
  bytesPerYear: number;
  /** Windows of evidence retention the cadence requires, plus slack. */
  retentionWindows: number;
} {
  const perAccount = args.claimsPerYear;
  const blocks = perAccount * args.accounts;
  // Retention has to cover a full claim interval and then some: a node that
  // comes back online just after its window must still be able to prove what
  // it did. Two intervals is the cheapest thing that is not a cliff.
  const interval = args.windowsPerYear / Math.max(1, args.claimsPerYear);
  return {
    blocksPerAccountPerYear: perAccount,
    blocksPerYear: blocks,
    bytesPerYear: blocks * args.blockBytes,
    retentionWindows: Math.ceil(interval * 2),
  };
}

/**
 * Spread automatic claims so they do not all land at once.
 *
 * A 30-day auto-claim for everyone is a synchronised herd: one day in thirty
 * carries the entire network's settlement traffic, and the other twenty-nine
 * are idle. Deriving the claim day from the account id spreads them uniformly
 * with no coordination, no timer negotiation and nothing to agree on — the same
 * trick as jittered polling, made deterministic so it is also verifiable.
 */
export function claimDayFor(accountId: string, periodDays: number): number {
  let h = 2166136261;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % Math.max(1, periodDays);
}
