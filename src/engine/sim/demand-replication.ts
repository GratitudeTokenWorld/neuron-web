/**
 * What demand-scaled replication COSTS, per control law.
 *
 * Lucian's proposal (2026-09-22): "for every 10 new reads within one hour make
 * another copy". The rate part of that is right and is now what ships —
 * `CustodySignals` measures reads per window rather than per lifetime, so the
 * target can come back down. What this module measures is the other half: how
 * fast the copy count should rise with demand, which is a fleet-capacity
 * question and therefore not answerable by argument.
 *
 * The three candidate control laws:
 *
 *  - **fixed** — `REDUNDANCY_TARGET` always. Durability only, no response to
 *    demand at all. The baseline everything is measured against.
 *  - **linear** — one more copy per `READS_PER_COPY` reads in the window. Holds
 *    reads-per-holder CONSTANT, which is the textbook correct control law if
 *    assigned holders are the only servers.
 *  - **log** — what ships: `REDUNDANCY_TARGET + log2(rate / POPULARITY_FLOOR)`,
 *    capped. Sub-linear, so one viral object cannot conscript the fleet.
 *
 * The honest complication, and the reason this needs measuring rather than
 * deciding: **assigned holders are not the only servers.** Anyone who fetched a
 * CID can serve it, so serving capacity already grows with the audience for
 * free (ARCHITECTURE.md → Fan-IN, principle 2). The assigned set only has to
 * carry what caches miss. So the choice between linear and log depends on the
 * cache hit rate — a number we have NOT measured, which is why `cacheHitRate`
 * is an explicit ASSUMED input here and the sensitivity is reported rather than
 * hidden.
 *
 * Workload is Zipf, because content popularity is: a few objects take most of
 * the reads, and the tail is enormous. Using a uniform workload would make
 * every policy look affordable and would prove nothing.
 */

import { REDUNDANCY_TARGET, MAX_REPLICA_TARGET, POPULARITY_FLOOR, replicaTarget } from '../content/custody.js';

/** Reads per window that Lucian's rule buys one extra copy for. */
export const READS_PER_COPY = 10;

export interface Workload {
  /** Distinct objects in the network. */
  objects: number;
  /** Aggregate reads across all objects in one demand window. */
  totalReadsPerWindow: number;
  /** Zipf exponent. ~1 is the classic web/content value. */
  zipfExponent: number;
}

/**
 * Reads per window for each object, most popular first. MEASURED nowhere — this
 * is a modelled distribution, and every conclusion below inherits that.
 */
export function zipfRates(w: Workload): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let i = 1; i <= w.objects; i++) {
    const x = 1 / Math.pow(i, w.zipfExponent);
    weights.push(x);
    sum += x;
  }
  return weights.map(x => (x / sum) * w.totalReadsPerWindow);
}

export type TargetFn = (readsPerWindow: number) => number;

/** Durability only — no response to demand. */
export const fixedPolicy: TargetFn = () => REDUNDANCY_TARGET;

/** Lucian's rule: one more copy per `READS_PER_COPY` reads in the window. */
export const linearPolicy: TargetFn = (r) =>
  REDUNDANCY_TARGET + Math.floor(Math.max(0, r) / READS_PER_COPY);

/** Lucian's rule with the shipping cap applied. */
export const linearCappedPolicy: TargetFn = (r) =>
  Math.min(MAX_REPLICA_TARGET, linearPolicy(r));

/**
 * The log2 curve that shipped until 2026-09-22, kept as the comparison that
 * justified replacing it. No longer what runs.
 */
export const logPolicy: TargetFn = (r) => {
  if (!(r > POPULARITY_FLOOR)) return REDUNDANCY_TARGET;
  return Math.min(MAX_REPLICA_TARGET, REDUNDANCY_TARGET + Math.floor(Math.log2(r / POPULARITY_FLOOR)) + 1);
};

/** What ships — linear and capped, driving the real `replicaTarget`. */
export const shippingPolicy: TargetFn = (r) => replicaTarget(r);

export interface PolicyCost {
  name: string;
  /** Leased copies across the whole network. */
  totalCopies: number;
  /** …as a multiple of storing every object `REDUNDANCY_TARGET` times. */
  multipleOfFloor: number;
  /** Copies the single most popular object demands. */
  copiesForHottest: number;
  /**
   * Reads per window landing on ONE assigned holder of the hottest object,
   * after opportunistic caches absorb their share. This is the number that
   * decides whether a policy under-provisions.
   */
  peakHolderLoad: number;
  /** Objects whose target is pinned at the cap. */
  objectsAtCap: number;
}

export function policyCost(
  rates: readonly number[],
  policy: TargetFn,
  name: string,
  opts: { cacheHitRate: number },
): PolicyCost {
  let totalCopies = 0;
  let objectsAtCap = 0;
  for (const r of rates) {
    const t = policy(r);
    totalCopies += t;
    if (t >= MAX_REPLICA_TARGET) objectsAtCap++;
  }
  const hottest = rates[0] ?? 0;
  const copiesForHottest = policy(hottest);
  const servedByHolders = hottest * (1 - opts.cacheHitRate);
  return {
    name,
    totalCopies,
    multipleOfFloor: totalCopies / (rates.length * REDUNDANCY_TARGET),
    copiesForHottest,
    peakHolderLoad: servedByHolders / Math.max(1, copiesForHottest),
    objectsAtCap,
  };
}

/**
 * The break-even the whole question actually reduces to.
 *
 * NOT "which curve is steeper" — the first version of this asked what hit rate
 * the log policy needs to match the linear policy's load per holder, and got
 * 99.97%, which looks like a damning result and is a meaningless one: linear's
 * 10-reads-per-holder is an arbitrary target, not a capacity limit. Comparing
 * two policies to each other cannot say whether either one works.
 *
 * The decision-relevant question is absolute: **can a holder actually serve
 * what lands on it?** Above `holderCapacityPerWindow` the answer is no and more
 * copies (or more caching) are required; below it, the spare capacity is waste.
 *
 * Returns the cache hit rate this policy needs at this demand, `0` when it
 * copes unaided, and `>1` when no amount of caching saves it.
 */
export function requiredCacheHitRate(args: {
  hottestRate: number;
  policy: TargetFn;
  /**
   * Reads one holder can serve per window. ASSUMED — and it is the input that
   * decides everything here, so it must be measured before this analysis means
   * anything. Principle 1 makes it worse than a single number: a node may be a
   * single-board computer on a domestic uplink, so the fleet's capacity is a
   * distribution with a very long low tail, not a constant.
   */
  holderCapacityPerWindow: number;
}): number {
  const holders = args.policy(args.hottestRate);
  const servable = holders * args.holderCapacityPerWindow;
  if (servable >= args.hottestRate) return 0;
  return 1 - servable / args.hottestRate;
}

export const DEFAULT_WORKLOAD: Workload = {
  objects: 100_000,
  // 10M reads an hour across 100k objects — a small, busy network.
  totalReadsPerWindow: 10_000_000,
  zipfExponent: 1,
};

export { REDUNDANCY_TARGET, MAX_REPLICA_TARGET, POPULARITY_FLOOR };
