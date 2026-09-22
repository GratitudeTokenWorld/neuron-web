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

/**
 * A finer-grained claim slot than a day.
 *
 * Lucian's concern (2026-09-22): a fixed day could still overwhelm the chain as
 * the network grows, because one day in thirty carries `accounts / 30` claims
 * however evenly they are spread across days.
 *
 * The cheap half of the fix is resolution. Spreading over *slots* rather than
 * days turns a daily spike into a continuous trickle at no cost: 30 days of
 * minutes is 43,200 slots, so 100M accounts land ~2,300 claims per minute
 * instead of 3.3M in one day. Deterministic, so a node computes its own slot
 * and nobody coordinates.
 */
export function claimSlotFor(accountId: string, slotsInPeriod: number): number {
  let h = 2166136261;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // A second mixing round: the raw FNV of short, similar ids clusters, and a
  // claim schedule that clusters is the herd this exists to prevent.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  // `^=` yields a SIGNED 32-bit result, so this must be forced back to
  // unsigned before the modulo. Without it the function returned NEGATIVE
  // slots — caught by measuring the spread and finding 77,740 distinct slots
  // in a 43,200-slot period, which is arithmetically impossible and would have
  // shipped as a scheduler that sometimes indexes backwards.
  h = (h ^ (h >>> 13)) >>> 0;
  return h % Math.max(1, slotsInPeriod);
}

/**
 * The expensive half of the fix, and the better one: **do not claim amounts too
 * small to be worth a block.**
 *
 * Most accounts earn a rounding error (see the projections above), so most
 * claims would write a block to move nearly nothing. A minimum threshold lets
 * those accruals ride — safely, because receipts are cumulative and the
 * baseline only moves at settlement, so nothing is lost by waiting.
 *
 * Returns claims per year for a fleet under a threshold.
 */
export function claimsUnderThreshold(args: {
  archetypes: readonly ProviderArchetype[];
  earningsPerYear: ReadonlyMap<string, number>;
  minClaim: number;
  maxClaimsPerYear: number;
}): { totalClaimsPerYear: number; claimingAccounts: number; byName: Map<string, number> } {
  const byName = new Map<string, number>();
  let total = 0;
  let claiming = 0;
  for (const a of args.archetypes) {
    const perYear = args.earningsPerYear.get(a.name) ?? 0;
    // How often this archetype crosses the threshold, capped by the cadence.
    const crossingsPerYear = args.minClaim > 0 ? perYear / args.minClaim : args.maxClaimsPerYear;
    const claims = Math.min(args.maxClaimsPerYear, crossingsPerYear);
    byName.set(a.name, claims);
    total += claims * a.count;
    if (claims >= 1) claiming += a.count;
  }
  return { totalClaimsPerYear: total, claimingAccounts: claiming, byName };
}

/**
 * What UNIT would have to be worth for a provider to cover its running costs.
 *
 * Lucian, 2026-09-22: the reward should not pay for the device, but it could
 * reasonably cover the cost of RUNNING it. That is a testable claim, and this
 * is the number that tests it — how much a UNIT must be worth before an
 * archetype breaks even.
 *
 * Returns the break-even price in whatever currency `annualCost` is given in.
 * `Infinity` means the archetype earns nothing and can never break even.
 */
export function breakEvenTokenPrice(args: {
  earningsPerYear: number;
  annualCost: number;
}): number {
  if (args.earningsPerYear <= 0) return Infinity;
  return args.annualCost / args.earningsPerYear;
}

/**
 * Annual running cost per archetype. ASSUMED, and openly rough: incremental
 * power at ~$0.20/kWh plus bandwidth where it is metered. These are the numbers
 * to replace first with real ones.
 */
export const ASSUMED_ANNUAL_COST: Record<string, number> = {
  phone: 1,           // ~0.5 W incremental, charged anyway
  laptop: 18,         // ~10 W incremental while awake
  'home server': 55,  // ~30 W continuous
  datacentre: 600,    // power plus metered egress
};


/**
 * The aggregate version of the break-even question, which is the useful one.
 *
 * Per-archetype break-even prices scatter because costs and earnings scale
 * differently. The network-level statement is simpler and harder to argue with:
 * **the annual emission must be worth roughly what the fleet costs to run**, or
 * providers are subsidising the network out of pocket.
 *
 * Returns the UNIT price at which the whole fleet breaks even, and the implied
 * market capitalisation — because with a capped percentage emission, the second
 * is what actually has to be true.
 */
export function fleetBreakEven(args: {
  archetypes: readonly ProviderArchetype[];
  annualCostByName: Readonly<Record<string, number>>;
  annualEmissionUnits: number;
  supplyUnits: number;
}): { annualFleetCost: number; unitPrice: number; impliedMarketCap: number } {
  let cost = 0;
  for (const a of args.archetypes) cost += (args.annualCostByName[a.name] ?? 0) * a.count;
  const unitPrice = args.annualEmissionUnits > 0 ? cost / args.annualEmissionUnits : Infinity;
  return { annualFleetCost: cost, unitPrice, impliedMarketCap: unitPrice * args.supplyUnits };
}

// ── Calibrating the pool to a target earning ─────────────────────────────────

/**
 * Reward driven by SERVICE alone (Lucian, 2026-09-22).
 *
 * "A datacentre hosting a lot of content means nothing if that content is not
 * read. Storing alone does not pay anything." So the weight is **bytes
 * served**, which already contains both halves of "total file size + their
 * reads": serving one 5 MB file ten times is 50 MB, and so is serving ten
 * 5 MB files once.
 *
 * This is coherent — and it needs one condition stated, because without it the
 * coverage result in `incentive-coverage.ts` bites. Paying only for service is
 * safe when **custody is an assigned obligation rather than a free choice**: a
 * provider takes a lease, must keep the bytes (verified by sampled challenges,
 * `content/custody-sampling.ts`), and is paid when they are read. Cold content
 * survives because dropping it breaks the lease and costs the provider its
 * standing, not because holding it pays.
 *
 * The earlier objection assumed providers pick what to hold. Under assigned,
 * sampling-enforced custody they do not, and it does not apply.
 */
export function serviceWeight(bytesServed: number): number {
  return Math.max(0, bytesServed);
}

/**
 * Bytes a provider serves in a period, from the shape of what it holds.
 *
 * `readsPerFile` is the average over the period, so this is
 * `files × fileSize × reads` — the estimate Lucian asked for, with its inputs
 * visible rather than folded into a constant.
 */
export function bytesServedFrom(args: {
  bytesHeld: number;
  avgFileBytes: number;
  avgReadsPerFilePerPeriod: number;
}): { files: number; reads: number; bytesServed: number } {
  const files = args.avgFileBytes > 0 ? args.bytesHeld / args.avgFileBytes : 0;
  const reads = files * args.avgReadsPerFilePerPeriod;
  return { files, reads, bytesServed: reads * args.avgFileBytes };
}

/**
 * What the network's supply and emission must be for a given node to earn a
 * given amount.
 *
 * The question Lucian asked — "adjust the formula so a 100 GB node earns 1000
 * units per 30 days" — has an answer the formula cannot give, and saying so is
 * the point. Earnings are a **share of a capped pool**, so an individual's
 * payout depends on everyone else's weight. No choice of `custodyRate`,
 * `serviceRate` or `alpha` sets an absolute number; they only set *relative*
 * shares.
 *
 * What DOES set the absolute number is the size of the pool. So this inverts
 * the question: given a target earning and a fleet, how large must the annual
 * emission — and therefore the supply — be?
 */
export function supplyForTargetEarning(args: {
  /** What one reference node should earn per period. */
  targetPerPeriod: number;
  periodsPerYear: number;
  /** Weight of the reference node. */
  referenceWeight: number;
  /** Total weight of the whole network, including the reference node. */
  totalNetworkWeight: number;
  /** Emission cap as parts-per-million of supply, per YEAR. */
  inflationPpm: number;
}): { emissionPerPeriod: number; annualEmission: number; requiredSupply: number } {
  const share = args.totalNetworkWeight > 0 ? args.referenceWeight / args.totalNetworkWeight : 0;
  if (share <= 0) return { emissionPerPeriod: Infinity, annualEmission: Infinity, requiredSupply: Infinity };
  const emissionPerPeriod = args.targetPerPeriod / share;
  const annualEmission = emissionPerPeriod * args.periodsPerYear;
  return {
    emissionPerPeriod,
    annualEmission,
    requiredSupply: (annualEmission * 1_000_000) / args.inflationPpm,
  };
}

/**
 * The inverse, and the one to reason with day to day: given a supply, what
 * does the reference node actually earn?
 *
 * Pair this with `supplyForTargetEarning` and the pair says something blunt:
 * **"1000 units per month" is a denomination choice, not an economic one.**
 * What is economically real is the SHARE — one millionth of the pool, in a
 * million-node network — and no formula parameter changes that. Picking the
 * supply is picking whether that share is called 1 unit or 1000.
 */
export function earningForSupply(args: {
  supplyUnits: number;
  inflationPpm: number;
  periodsPerYear: number;
  referenceWeight: number;
  totalNetworkWeight: number;
}): number {
  const annualEmission = (args.supplyUnits * args.inflationPpm) / 1_000_000;
  const perPeriod = annualEmission / args.periodsPerYear;
  const share = args.totalNetworkWeight > 0 ? args.referenceWeight / args.totalNetworkWeight : 0;
  return perPeriod * share;
}
