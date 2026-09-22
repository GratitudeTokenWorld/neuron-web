/**
 * What a payment rule does to the content nobody reads.
 *
 * Lucian proposes removing the heartbeat entirely and paying purely on read and
 * write volume: custody proven by successful reads, earnings set by how much
 * was served rather than by elapsed time.
 *
 * The question that decides whether that is safe is not about fraud. It is:
 * **if providers are paid only for serving, what happens to content nobody
 * asks for?** Providers have finite space and choose what to keep, so a payment
 * rule is not just an accounting choice — it is the thing that decides which
 * content survives.
 *
 * ## The model, and its assumption
 *
 * Providers are rational and capacity-bound: each holds a fixed number of
 * objects and fills its slots with whatever earns most. Reads for an object are
 * split among its replicas, so holding a popular object is worth less the more
 * others also hold it — a congestion game with an equilibrium.
 *
 * ASSUMED, and it drives everything: that providers optimise earnings at all.
 * Altruistic or hobbyist operators do not, and early networks run on them. This
 * measures the incentive, not the sociology, and the incentive is what remains
 * once a network is large enough that nobody knows anybody.
 *
 * ## The two rules compared
 *
 * - **Service-only** (`custodyWeight = 0`): earnings come from reads served.
 * - **Hybrid**: a base rate for bytes provably held, plus a service rate.
 *
 * Under service-only the equilibrium is exactly proportional: with reads split
 * among replicas, marginal value equalises when `replicas ∝ read rate`. Over a
 * Zipf workload that hands the tail a fraction of one replica, which is another
 * way of writing "deleted".
 */

export interface CoverageParams {
  /** Distinct objects in the network. */
  objects: number;
  /** Zipf exponent — content popularity is not uniform. */
  zipfExponent: number;
  /** Aggregate reads per window. */
  totalReadsPerWindow: number;
  /** Total object-slots across the whole fleet (providers × slots each). */
  totalSlots: number;
  /**
   * Earnings per unit of space HELD per window, whether or not it is read.
   *
   * Lucian, 2026-09-22: the real term is **bytes held**, not replica count — a
   * replica count is a network property a provider neither knows nor controls.
   * Modelled per slot here because the conclusion does not depend on the unit:
   * the term is constant per unit of space either way, so cold content earns
   * and is therefore kept.
   */
  custodyWeight: number;
  /** Earnings per read served. */
  serviceWeight: number;
  /** Replicas an object needs to be considered durable. */
  redundancyTarget: number;
}

export interface CoverageResult {
  /** Objects holding at least `redundancyTarget` replicas. */
  durable: number;
  /** …as a share of all objects. */
  durableShare: number;
  /** Objects with fewer than one replica — effectively lost. */
  lost: number;
  lostShare: number;
  /** Replicas the single most popular object attracts. */
  hottestReplicas: number;
  /** Replicas the median object attracts. */
  medianReplicas: number;
}

function zipf(objects: number, exponent: number, total: number): number[] {
  const w: number[] = [];
  let sum = 0;
  for (let i = 1; i <= objects; i++) {
    const x = 1 / Math.pow(i, exponent);
    w.push(x);
    sum += x;
  }
  return w.map(x => (x / sum) * total);
}

/**
 * Equilibrium replica counts under a payment rule.
 *
 * Two regimes, because the weights change the shape of the answer rather than
 * only its scale:
 *
 * - **`custodyWeight === 0`** — nothing is earned for merely holding, so slots
 *   chase reads and settle at `replicas ∝ rate`. Objects whose share is below
 *   one replica are not "under-replicated", they are gone.
 * - **`custodyWeight > 0`** — every object is worth holding even at zero reads,
 *   so providers first spread across distinct objects up to the redundancy
 *   target (that is the cheapest way to earn the base rate), and only surplus
 *   slots chase reads. Coverage then depends on whether the fleet has enough
 *   total space, which is a capacity question rather than an incentive one.
 */
export function coverage(p: CoverageParams): CoverageResult {
  const rates = zipf(p.objects, p.zipfExponent, p.totalReadsPerWindow);
  const replicas = new Array<number>(p.objects).fill(0);

  if (p.custodyWeight <= 0) {
    // Service-only: slots distribute in proportion to read rate.
    const totalRate = rates.reduce((a, b) => a + b, 0);
    for (let i = 0; i < p.objects; i++) {
      replicas[i] = totalRate > 0 ? (p.totalSlots * rates[i]!) / totalRate : 0;
    }
  } else {
    // Hybrid: cover the floor first, then let surplus chase reads.
    const floorSlots = Math.min(p.totalSlots, p.objects * p.redundancyTarget);
    const perObjectFloor = floorSlots / p.objects;
    const surplus = Math.max(0, p.totalSlots - floorSlots);
    const totalRate = rates.reduce((a, b) => a + b, 0);
    for (let i = 0; i < p.objects; i++) {
      replicas[i] = Math.min(perObjectFloor, p.redundancyTarget)
        + (totalRate > 0 ? (surplus * rates[i]!) / totalRate : 0);
    }
  }

  const durable = replicas.filter(r => r >= p.redundancyTarget).length;
  const lost = replicas.filter(r => r < 1).length;
  const sorted = [...replicas].sort((a, b) => b - a);
  return {
    durable,
    durableShare: durable / p.objects,
    lost,
    lostShare: lost / p.objects,
    hottestReplicas: sorted[0] ?? 0,
    medianReplicas: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

/**
 * Cheapest way to keep cold content alive: prove custody without paying by the
 * clock.
 *
 * The measured objection to the heartbeat was never liveness, it was that a
 * heartbeat is a BLOCK — 2,555 of them per provider per year, accruing with
 * time and nothing else (`storage-accounting.ts`). That cost is a property of
 * putting it *on the chain*, not of the beacon itself.
 *
 * This compares the per-window cost of the three ways to know a provider still
 * holds cold bytes, in messages rather than in blocks:
 *
 * - `onChainHeartbeat` — what ships: one block per interval per provider.
 * - `offChainBeacon` — the same signal, gossiped and never chained. Same
 *   liveness, zero chain growth.
 * - `spotCheckEverything` — what "custody is proven by reads" implies for
 *   content nobody reads: somebody has to issue synthetic reads, and that is
 *   per OBJECT, not per provider.
 */
export function custodyProofCost(args: {
  providers: number;
  objectsPerProvider: number;
  beatsPerWindow: number;
  spotChecksPerObjectPerWindow: number;
}): { onChainHeartbeat: number; offChainBeacon: number; spotCheckEverything: number } {
  const beats = args.providers * args.beatsPerWindow;
  return {
    onChainHeartbeat: beats,
    offChainBeacon: beats,
    spotCheckEverything:
      args.providers * args.objectsPerProvider * args.spotChecksPerObjectPerWindow,
  };
}
