/**
 * Measuring what a node can actually serve, instead of asking it.
 *
 * Lucian, 2026-09-22: a node generates a small file and a big one, an
 * increasing number of REAL peers fetch them, and the point where delivery
 * degrades is that node's capacity. Mandatory for storage providers.
 *
 * This is the missing half of `device-capacity.ts`. That module decides how
 * many holders a CID needs from each holder's concurrent-read limit, and those
 * limits were `DEFAULT_CONCURRENCY` — a table of plausible numbers, labelled
 * ASSUMED because that is what they were. Principle 5 says a number that can be
 * measured must be measured, and this is how: the device class becomes a
 * starting rung on a ladder rather than an answer.
 *
 * Two file sizes because they measure different limits and a single size would
 * hide one of them. The small file is dominated by per-request overhead —
 * connection setup, scheduling, the request path — and finds the *concurrency*
 * ceiling. The large file is dominated by bandwidth and finds the *throughput*
 * ceiling. A phone on fibre and a server on ADSL fail in opposite ways, and one
 * number could not tell them apart.
 *
 * ## Screened before building (PRINCIPLES.md → 4)
 *
 * **Security.** Three things had to change from the obvious version:
 *
 * 1. **A node may only ask for probes of ITSELF.** "Everybody fetch from that
 *    address" is a reflected DoS with the network as the amplifier. The probe
 *    request is signed by the target and the target is the signer — there is no
 *    field for a third party, deliberately.
 * 2. **The result is what the PROBERS measured, not what the target reports.**
 *    A self-timed benchmark is a self-report wearing a lab coat, and the whole
 *    reason this exists is that self-reports were deciding custody. Samples
 *    carry the prober's identity and `confident` requires several distinct
 *    ones, so a target colluding with one friendly prober proves nothing.
 * 3. **Under-declaring stays possible and stays answered elsewhere.** A node
 *    can still refuse to be calibrated or sandbag; what it cannot do is claim a
 *    capacity nobody observed. Credit follows observed service
 *    (CUSTODY-PROOFS.md → reciprocity), so sandbagging costs the sandbagger.
 *
 * **Performance.** The cost is real bandwidth — the large file times the number
 * of probers — so it is infrequent, bounded by the ladder, and stops early at
 * the first sign of degradation rather than running every rung.
 *
 * **Decentralisation, and this is the Principle 1 line:** calibration sets **how
 * much** a node serves, never **whether** it may participate. The ladder starts
 * at 1, so a device that passes only the first rung is a valid provider with a
 * capacity of 1. A node that cannot serve even one concurrent read has a
 * measured capacity of zero — which is a fact about its connectivity, not a
 * judgement about its worth, and it can still read, publish and use the network
 * in full.
 */

/** Small file: measures the concurrency ceiling, dominated by per-request overhead. */
export const CALIBRATION_SMALL_BYTES = 64 * 1024;

/** Large file: measures the throughput ceiling, dominated by bandwidth. */
export const CALIBRATION_LARGE_BYTES = 8 * 1024 * 1024;

/**
 * Concurrency rungs. Doubling, because the interesting quantity spans three
 * orders of magnitude across the device classes we expect and a linear ladder
 * would spend all its probes in the boring part.
 */
export const LADDER: readonly number[] = [1, 2, 4, 8, 16, 32, 64, 128];

/**
 * Samples a rung needs before it may be judged.
 *
 * The same rule as everywhere else here: one slow fetch is weather, not
 * capacity. A rung below this is reported as untested rather than as passed.
 */
export const MIN_SAMPLES_PER_LEVEL = 3;

/**
 * Distinct probers a result needs before it is `confident`.
 *
 * Without this, a node and one accomplice can manufacture any capacity they
 * like. Three is the smallest number for which a single colluding prober is
 * outvoted by evidence rather than by policy.
 */
export const MIN_DISTINCT_PROBERS = 3;

/** Latency multiple over the level-1 baseline that counts as degraded. */
export const DEGRADATION_FACTOR = 3;

/** Failure rate at a rung that counts as degraded regardless of latency. */
export const MAX_FAILURE_RATE = 0.1;

export interface ProbeSample {
  /** Concurrency rung this sample was taken at. */
  level: number;
  /** Which file — the two measure different ceilings. */
  size: 'small' | 'large';
  ok: boolean;
  latencyMs: number;
  /** Identity of the node that performed the fetch and timed it. */
  prober: string;
}

export interface CalibrationResult {
  /** Concurrent reads this node can serve — the knee of the small-file ladder. */
  maxConcurrentReads: number;
  /** Bytes per second at the best large-file rung, when measured. */
  throughputBytesPerSec?: number;
  /**
   * True when the ladder ran out before degrading: the node is at least this
   * fast and we do not know how much faster. A LOWER BOUND, not a measurement
   * of the maximum, and it must never be rendered as one.
   */
  lowerBoundOnly: boolean;
  /** Enough samples, at enough rungs, from enough distinct probers. */
  confident: boolean;
  /**
   * True when the knee is at or above what the PROBER itself can ingest — so
   * the number measured our own ceiling, not the target's.
   *
   * This matters most in the case it is easiest to run: two nodes, one prober
   * hammering one provider. The small file is read from the provider's disk and
   * held in the reader's RAM, which is the right asymmetry, but N concurrent
   * fetches also cost the reader N parallel connections and N buffers. If the
   * reader tops out first, the "provider capacity" is a self-portrait.
   */
  proberBound: boolean;
  samples: number;
  distinctProbers: number;
  levelsJudged: number;
  reason: string;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx]!;
}

/**
 * Accumulates probe samples for one node and finds the knee.
 *
 * Deliberately not a timer or a network client: it is the judgement, kept pure
 * so it is testable at rungs and sample counts that would take a real network
 * hours to produce.
 */
export class CalibrationRun {
  private readonly samples: ProbeSample[] = [];

  /**
   * Samples retained per rung. Everything older is dropped.
   *
   * Without this the array grows for the life of the process — every spot check
   * adds one and nothing removes any — which is the sustained half of the
   * invariant failing, and it shows up twice: as memory, and as `analyze()`
   * getting slower forever. Measured before the cap: 100k samples took 17.9 ms
   * per analyse, and `analyze()` runs per holder per target computation.
   *
   * Recency is also correct on the merits. Capacity is a property of a machine
   * AND its current conditions, so a sample from last week is not evidence
   * about this afternoon.
   */
  static readonly MAX_PER_LEVEL = 32;

  add(s: ProbeSample): void {
    this.samples.push(s);
    this.trim(s.level, s.size);
  }

  /** Drop the oldest samples for this rung beyond the cap. */
  private trim(level: number, size: 'small' | 'large'): void {
    let count = 0;
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]!;
      if (s.level !== level || s.size !== size) continue;
      count++;
      if (count > CalibrationRun.MAX_PER_LEVEL) this.samples.splice(i, 1);
    }
  }

  size(): number {
    return this.samples.length;
  }

  /**
   * The knee: the highest rung that still served acceptably.
   *
   * Walks the ladder upward and stops at the first rung that is degraded — by
   * failure rate or by latency against the level-1 baseline — reporting the rung
   * below it. Rungs with too few samples are skipped rather than trusted, and a
   * ladder that never degrades yields `lowerBoundOnly`.
   */
  analyze(proberCeiling?: number): CalibrationResult {
    const probers = new Set(this.samples.map(s => s.prober));
    const small = this.samples.filter(s => s.size === 'small');
    const base: CalibrationResult = {
      maxConcurrentReads: 0,
      lowerBoundOnly: false,
      confident: false,
      proberBound: false,
      samples: this.samples.length,
      distinctProbers: probers.size,
      levelsJudged: 0,
      reason: 'no samples',
    };
    if (small.length === 0) return base;

    const byLevel = new Map<number, ProbeSample[]>();
    for (const s of small) {
      const arr = byLevel.get(s.level) ?? [];
      arr.push(s);
      byLevel.set(s.level, arr);
    }

    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const first = byLevel.get(levels[0]!)!;
    const baselineOk = first.filter(s => s.ok).map(s => s.latencyMs).sort((a, b) => a - b);
    if (first.length < MIN_SAMPLES_PER_LEVEL || baselineOk.length === 0) {
      return { ...base, reason: 'baseline rung has too few successful samples to judge anything against' };
    }
    const baseline = percentile(baselineOk, 0.5);

    let best = 0;
    let judged = 0;
    let degradedAt: number | undefined;

    for (const level of levels) {
      const at = byLevel.get(level)!;
      if (at.length < MIN_SAMPLES_PER_LEVEL) continue; // untested, not passed
      judged++;
      const failures = at.filter(s => !s.ok).length / at.length;
      const oks = at.filter(s => s.ok).map(s => s.latencyMs).sort((a, b) => a - b);
      const p95 = percentile(oks, 0.95);
      const degraded = failures > MAX_FAILURE_RATE
        || oks.length === 0
        || p95 > baseline * DEGRADATION_FACTOR;
      if (degraded) { degradedAt = level; break; }
      best = level;
    }

    // Large-file throughput at the best rung that succeeded.
    const large = this.samples.filter(s => s.size === 'large' && s.ok && s.latencyMs > 0);
    let throughput: number | undefined;
    if (large.length >= MIN_SAMPLES_PER_LEVEL) {
      const rates = large.map(s => (CALIBRATION_LARGE_BYTES * s.level) / (s.latencyMs / 1000)).sort((a, b) => a - b);
      throughput = percentile(rates, 0.5);
    }

    const lowerBoundOnly = degradedAt === undefined && best === Math.max(...levels);
    // If we stopped where WE stop, we measured ourselves. Reported, never
    // silently discarded: a prober-bound result is still a valid lower bound on
    // the target's capacity, it is simply not a measurement of its ceiling.
    const proberBound = proberCeiling !== undefined && best >= proberCeiling;
    const confident = probers.size >= MIN_DISTINCT_PROBERS && judged >= 2 && best > 0 && !proberBound;
    return {
      maxConcurrentReads: best,
      throughputBytesPerSec: throughput,
      lowerBoundOnly,
      confident,
      proberBound,
      samples: this.samples.length,
      distinctProbers: probers.size,
      levelsJudged: judged,
      reason: proberBound
        ? `stopped at ${best}, which is the prober's own ceiling — measures us, not them`
        : degradedAt !== undefined
        ? `degraded at ${degradedAt} concurrent — capacity ${best}`
        : lowerBoundOnly
          ? `served the whole ladder — capacity is at least ${best}, upper bound unknown`
          : `capacity ${best} from ${judged} rung(s)`,
    };
  }
}

/**
 * Deterministic bytes for a calibration file.
 *
 * Generated from a seed rather than stored, so the two files cost no disk and
 * any peer can verify it received the right content by regenerating it. The
 * seed is per node and per round, so a prober cannot serve a cached copy from
 * a previous round and call it a fetch.
 */
export function calibrationPayload(seed: number, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let a = (seed >>> 0) || 1;
  for (let i = 0; i < bytes; i++) {
    a ^= a << 13; a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5; a >>>= 0;
    out[i] = a & 0xff;
  }
  return out;
}

/**
 * How long a calibration stands before it is an assumption again.
 *
 * A laptop moves from ethernet to a train. A phone's battery saver throttles
 * its radio. Capacity is a property of a machine *and its current conditions*,
 * so a stale measurement is exactly the "stale constant wearing a
 * measurement's clothes" Principle 5 warns about.
 */
export function calibrationStale(measuredAt: number, now: number, ttlMs: number): boolean {
  return !(measuredAt > 0) || now - measuredAt > ttlMs;
}

/**
 * The capacity to actually use for a provider.
 *
 * Order of preference, and it is the whole policy in one function: a confident
 * fresh measurement beats a declared class; a stale or unconfident measurement
 * falls back to the declared class rather than to nothing, because refusing to
 * act without perfect evidence would exclude every new node; and a node with no
 * declaration and no measurement gets the smallest rung, never a generous
 * default.
 */
export function effectiveCapacity(args: {
  measured?: CalibrationResult;
  measuredAt?: number;
  declared?: number;
  now: number;
  ttlMs: number;
  /**
   * Make calibration MANDATORY (Lucian, 2026-09-22): an uncalibrated provider
   * is credited with the smallest rung whatever it declares.
   *
   * This is the form of "mandatory" that has teeth without excluding anyone.
   * A node that has not been measured can still register, still hold replicas
   * and still count toward the durability floor — Principle 1 — but the network
   * will not *plan bandwidth* against a number nobody verified, which is
   * Principle 5 applied to capacity. The incentive is exact: calibrate and be
   * given work proportional to what you demonstrably serve.
   *
   * Rejecting uncalibrated providers outright would have been the other
   * reading, and it fails on a case that will be common: a node whose
   * connectivity prevents calibration completing is exactly a node that cannot
   * serve, and it should discover that as a capacity of one rather than as a
   * refusal it cannot interpret.
   */
  requireMeasured?: boolean;
}): { capacity: number; source: 'measured' | 'declared' | 'floor' } {
  const { measured, declared, now, ttlMs } = args;
  if (measured?.confident
    && measured.maxConcurrentReads > 0
    && !calibrationStale(args.measuredAt ?? 0, now, ttlMs)) {
    return { capacity: measured.maxConcurrentReads, source: 'measured' };
  }
  if (args.requireMeasured) return { capacity: 1, source: 'floor' };
  if (declared && declared > 0) return { capacity: declared, source: 'declared' };
  return { capacity: 1, source: 'floor' };
}
