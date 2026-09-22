/**
 * Replication driven by measured SATURATION instead of a guessed read rate.
 *
 * Lucian, 2026-09-22: give each node a concurrent-read limit set by what kind
 * of device it is — a phone cannot take what a server can — and when a CID's
 * holders reach that limit, place another permanent copy. When demand falls,
 * shed back down to `REDUNDANCY_TARGET`. "This will ensure the network is never
 * over capacity and makes it performant."
 *
 * This replaces an open loop with a closed one, and that is the whole gain.
 * `replicaTarget` maps a read RATE to a holder count through a curve calibrated
 * on nothing: it cannot know how big the object is, how fast the holders are,
 * or whether caches already absorbed the spike. Saturation is the quantity we
 * actually care about — can readers be served now? — measured rather than
 * inferred, which is why `sim/demand-replication.ts` ended up concluding that
 * the curve was the wrong question.
 *
 * It also serves Principle 1 directly. A uniform read limit is a resource floor
 * in disguise: it either excludes small devices or lets them be assigned work
 * they cannot do. Declaring capacity lets a phone participate honestly at a
 * phone's scale, which is what "runs on as many kinds of device as possible"
 * has to mean operationally.
 *
 * ## The security condition, which changes the design
 *
 * **Saturation must be observed by READERS, never self-reported by holders.**
 * A holder that can say "I am full" and thereby cause the network to make
 * another copy has a lever that turns one cheap message into real storage on
 * someone else's disk. That is capacity conscription, and it is the same defect
 * as the self-metered reward (SCREENING.md → 11) pointed at storage instead of
 * money. So `declaredCapacity` here is only ever used to interpret what readers
 * measured; the trigger is reader-side.
 *
 * The declaration is still attackable, in the direction that is easy to miss:
 * **under-declaring is the attack**, not over-declaring. Claiming to be a phone
 * wins a holder a smaller share of the work while still counting toward the
 * replica floor. Over-declaring is self-punishing, because failing to serve is
 * what the reader measures. Under-declaring is answered by the same rule that
 * answers everything else here — credit follows observed service, so a node
 * that declares little earns little (CUSTODY-PROOFS.md → reciprocity).
 */

/**
 * What a node is, for the purpose of how many reads it can serve at once.
 *
 * A coarse ladder on purpose: the precise number is measured later
 * (`calibratedCapacity`), and a long enum would imply a precision the
 * declaration does not have.
 */
export type DeviceClass = 'sbc' | 'phone' | 'tablet' | 'laptop' | 'desktop' | 'server';

/**
 * Default concurrent reads by class.
 *
 * ASSUMED, every one of them — these are starting points for a measurement,
 * not measurements. They are ordered and spaced by roughly what uplink and CPU
 * allow, and `calibratedCapacity` is expected to move them. Do not treat these
 * numbers as findings; the honest label is "plausible until observed".
 */
export const DEFAULT_CONCURRENCY: Record<DeviceClass, number> = {
  sbc: 2,
  phone: 3,
  tablet: 4,
  laptop: 8,
  desktop: 16,
  server: 64,
};

/**
 * Browser hints, used only to pre-fill the declaration the operator can change.
 *
 * Every one of these is spoofable and several are wrong on honest machines, so
 * this is a CONVENIENCE, not evidence. It exists so that a phone user is not
 * asked a question they have no way to answer.
 */
export function suggestDeviceClass(hints: {
  mobile?: boolean;
  cores?: number;
  memoryGB?: number;
  /** Rough downlink in Mbit/s, if the platform offers it. */
  downlinkMbps?: number;
}): DeviceClass {
  const cores = hints.cores ?? 0;
  const mem = hints.memoryGB ?? 0;
  if (hints.mobile) return mem >= 6 || cores >= 8 ? 'tablet' : 'phone';
  if (cores <= 4 && mem > 0 && mem <= 2) return 'sbc';
  if (cores >= 16 && mem >= 32 && (hints.downlinkMbps ?? 0) >= 100) return 'server';
  if (cores >= 8 && mem >= 16) return 'desktop';
  return 'laptop';
}

/**
 * Refine a declared capacity with what the node was actually observed doing.
 *
 * The declaration says what a node believes; this says what it demonstrated.
 * Capacity is raised only to what has genuinely been served concurrently, and
 * lowered whenever failures appear at a concurrency below the declaration —
 * so an over-declaring node is corrected by its own behaviour rather than by
 * anyone's judgement.
 *
 * `peakServedConcurrent` and `failuresAtPeak` come from the serving node's own
 * request handler, which makes them self-reported for that node. They are used
 * only to *lower* the number others rely on, never to raise it above what a
 * reader has observed, so the only lie available is "I am worse than I am" —
 * which is the direction that costs the liar.
 */
export function calibratedCapacity(args: {
  declared: number;
  peakServedConcurrent: number;
  failuresAtPeak: number;
  /** Concurrency at which readers observed failures, if any. */
  observedFailureConcurrency?: number;
}): number {
  const { declared, peakServedConcurrent, failuresAtPeak } = args;
  let cap = Math.min(declared, Math.max(1, peakServedConcurrent || declared));
  if (failuresAtPeak > 0 && peakServedConcurrent > 1) {
    // It fell over at this level, so this level is not the capacity.
    cap = Math.min(cap, peakServedConcurrent - 1);
  }
  if (args.observedFailureConcurrency !== undefined) {
    cap = Math.min(cap, Math.max(1, args.observedFailureConcurrency - 1));
  }
  return Math.max(1, Math.floor(cap));
}

/**
 * Fraction of aggregate capacity in use at which another holder is placed.
 *
 * Below 1 deliberately: placing a copy takes a transfer, so by the time the new
 * holder is serving, demand has moved. A loop that waits for saturation before
 * reacting is always late, and the lateness is exactly one replication delay.
 */
export const HIGH_WATER = 0.75;

/**
 * Fraction below which a holder is released. The gap to `HIGH_WATER` is the
 * hysteresis band, and it has to be wide: releasing a holder RAISES the ratio,
 * so a narrow band would release, re-saturate, and re-place forever — an
 * oscillation that costs a transfer every cycle and holds the same number of
 * copies.
 */
export const LOW_WATER = 0.35;

export interface SaturationPlan {
  /** Aggregate concurrent reads the current holders can serve. */
  capacity: number;
  /** Measured utilisation, `demand / capacity`. */
  ratio: number;
  /** Holders wanted now — never below `floor`, never above `cap`. */
  target: number;
  /** Why, in one phrase, for the log line and the UI. */
  reason: string;
}

/**
 * How many holders this CID should have, from measured demand and the
 * capacities of the holders it already has.
 *
 * `demandConcurrent` is the number of concurrent readers OBSERVED BY READERS —
 * see the security condition at the top of this file. Passing a holder's own
 * claim here reintroduces exactly the conscription lever the design avoids.
 *
 * `cap` remains, and is not a tuning choice: demand is ultimately a number an
 * attacker can generate, so an uncapped loop converts fake reads into real
 * storage on strangers' disks. The cap is what bounds that, and it is the
 * reason this is still not a fully closed loop.
 */
export function planBySaturation(args: {
  holderCapacities: readonly number[];
  demandConcurrent: number;
  floor: number;
  cap: number;
  /** Typical capacity of a holder we might add. Defaults to the current mean. */
  typicalCapacity?: number;
}): SaturationPlan {
  const { holderCapacities, demandConcurrent, floor, cap } = args;
  const capacity = holderCapacities.reduce((a, b) => a + b, 0);
  const holders = holderCapacities.length;
  const mean = holders > 0 ? capacity / holders : 1;
  const typical = Math.max(1, args.typicalCapacity ?? mean);

  if (capacity <= 0) {
    return { capacity: 0, ratio: Infinity, target: Math.max(floor, holders), reason: 'no serving capacity — cannot judge' };
  }
  const ratio = demandConcurrent / capacity;

  if (ratio > HIGH_WATER) {
    // Add enough that the ratio lands back at HIGH_WATER, not merely one copy:
    // a spike that doubles demand needs the whole gap closed, and adding one at
    // a time makes the loop take a replication delay per increment.
    const wanted = demandConcurrent / HIGH_WATER;
    const extra = Math.ceil((wanted - capacity) / typical);
    return {
      capacity, ratio,
      target: Math.min(cap, Math.max(floor, holders + extra)),
      reason: `saturated at ${(ratio * 100).toFixed(0)}% — placing ${extra} more`,
    };
  }

  if (ratio < LOW_WATER && holders > floor) {
    // Shed only down to where the ratio would still sit below HIGH_WATER, so
    // releasing cannot itself cause saturation.
    const minCapacity = demandConcurrent / HIGH_WATER;
    let target = holders;
    let remaining = capacity;
    const ordered = [...holderCapacities].sort((a, b) => a - b);
    for (const c of ordered) {
      if (target <= floor) break;
      if (remaining - c < minCapacity) break;
      remaining -= c;
      target--;
    }
    return {
      capacity, ratio,
      target: Math.max(floor, target),
      reason: target < holders
        ? `demand at ${(ratio * 100).toFixed(0)}% — releasing ${holders - target}`
        : `demand at ${(ratio * 100).toFixed(0)}% — nothing safe to release`,
    };
  }

  return { capacity, ratio, target: Math.max(floor, holders), reason: `steady at ${(ratio * 100).toFixed(0)}%` };
}
