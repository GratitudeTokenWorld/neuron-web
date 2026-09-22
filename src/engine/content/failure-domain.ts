/**
 * Telling independent replicas from replicas that merely look independent.
 *
 * A replica only buys durability if it fails separately from the others. The
 * first attempt at this (2026-09-22) grouped holders by `deviceId`, and that is
 * **not a security control**: `getDeviceId()` is `crypto.randomUUID()` kept in
 * localStorage, so it is self-asserted and an attacker changes it by typing. It
 * catches one honest user running two accounts in one browser, which is worth
 * having, and it stops there. Anyone who wants ten replicas on one machine gets
 * them for the price of ten UUIDs.
 *
 * The fix is the rule the reciprocity work arrived at from the other direction:
 * **observation replaces testimony.** Do not ask a node what machine it is on;
 * watch when it fails. Two holders that go down together are one failure
 * domain, whatever they claim, and the only way to look independent is to BE
 * independent — to have genuinely uncorrelated downtime, which costs real
 * separate infrastructure rather than a new identifier.
 *
 * ## What is actually measured
 *
 * **Co-failure, not co-availability.** Two honest holders that are both up all
 * month are perfectly correlated and completely unrelated; correlating
 * availability would mark the whole healthy fleet as one domain. Only joint
 * DOWN events carry information, so a pair is judged on its failures and is
 * left `unknown` until enough of them have been seen.
 *
 * The statistic is the phi coefficient over a 2×2 table of jointly-observed
 * buckets, which is Pearson correlation for binary variables. It is compared
 * against `MIN_JOINT_FAILURES` first: with two shared outages, any pair looks
 * perfectly correlated, and reporting that as a domain would be the project's
 * oldest mistake — rendering an unmeasured thing as fact. An aggregate here
 * carries its sample size or it is not returned at all.
 *
 * ## What this does NOT do, stated plainly
 *
 * - It is **evidence, not proof**. Correlated downtime is consistent with one
 *   machine, one datacentre, one ISP, or one bad afternoon.
 * - It needs **time**. A brand-new holder has no failure history, so it is
 *   `unknown` and must be treated as *possibly* independent — refusing to place
 *   on unknown holders would make joining impossible, which Principle 1
 *   forbids.
 * - An attacker who can DoS two honest holders simultaneously can make them
 *   *look* correlated and steer placement away from both. That costs a
 *   sustained attack on two nodes and degrades placement rather than stealing
 *   anything, so it is a real but poor trade for them — recorded, not solved.
 *
 * Pure and tested, like the rest of `content/`: the network layer that will
 * call it has no tests of its own.
 */

import { HEARTBEAT_INTERVAL_MS } from './provider-ledger.js';

/**
 * Joint failures a pair needs before any correlation is reported.
 *
 * Three, not one: a single shared outage is a coincidence and two is a thin
 * one. This is the gate that stops the statistic being confidently wrong while
 * it knows nothing.
 */
export const MIN_JOINT_FAILURES = 3;

/**
 * Phi above which a pair is treated as one domain.
 *
 * 0.8 is deliberately high. A false positive here *reduces* redundancy — the
 * network believes it has fewer independent copies than it does and places
 * more — which wastes capacity, while a false negative leaves correlated
 * copies counted, which loses data. Both are bad, but only one of them is
 * recoverable, so the threshold leans toward "not proven".
 */
export const DOMAIN_PHI_THRESHOLD = 0.8;

/**
 * Observation bucket. Derived from the heartbeat so it compresses with
 * `STORAGE_TIMING` like every other storage duration — a fixed bucket would
 * make this untestable under the fast profile.
 *
 * A function, not a constant: `HEARTBEAT_INTERVAL_MS` is an `export let`
 * reassigned by `applyStorageTiming`, and capturing it at module load is the
 * mismatch this codebase keeps paying for.
 */
export function observationBucketMs(): number {
  return HEARTBEAT_INTERVAL_MS;
}

export interface PairEvidence {
  /** Buckets where both holders were observed. */
  joint: number;
  /** Buckets where both were DOWN — the only ones carrying information. */
  jointFailures: number;
  /** Phi coefficient, or `undefined` when the sample is too thin to report. */
  phi?: number;
}

/**
 * Availability history per holder, as a sparse set of observed buckets.
 *
 * Bounded by construction: `retainBuckets` is the only memory, and every
 * accessor prunes past it. Unbounded observation history keyed by a holder an
 * outsider chooses is precisely the shape that has leaked twice already
 * (SCREENING.md → 1).
 */
export class FailureCorrelation {
  private readonly up = new Map<string, Set<number>>();
  private readonly down = new Map<string, Set<number>>();

  constructor(private readonly retainBuckets = 168) {}

  private bucketOf(now: number): number {
    return Math.floor(now / observationBucketMs());
  }

  /** Record one observation. `ok` is whether the holder served/answered. */
  record(holder: string, ok: boolean, now: number = Date.now()): void {
    const b = this.bucketOf(now);
    const target = ok ? this.up : this.down;
    const other = ok ? this.down : this.up;
    let set = target.get(holder);
    if (!set) { set = new Set<number>(); target.set(holder, set); }
    set.add(b);
    // A bucket is up or down, never both: the latest observation in a bucket
    // wins, so a holder that recovered within the bucket is not also counted as
    // having failed in it.
    other.get(holder)?.delete(b);
    this.prune(holder, b);
  }

  private prune(holder: string, current: number): void {
    const cutoff = current - this.retainBuckets;
    for (const m of [this.up, this.down]) {
      const set = m.get(holder);
      if (!set) continue;
      for (const b of set) if (b < cutoff) set.delete(b);
      if (set.size === 0) m.delete(holder);
    }
  }

  /** Forget a holder entirely. */
  forget(holder: string): void {
    this.up.delete(holder);
    this.down.delete(holder);
  }

  /** Holders with any history. */
  holders(): string[] {
    return [...new Set([...this.up.keys(), ...this.down.keys()])];
  }

  /**
   * Co-failure evidence for one pair. `phi` is omitted — not zeroed — when the
   * pair has not failed together often enough to say anything.
   */
  evidence(a: string, b: string): PairEvidence {
    const aUp = this.up.get(a) ?? new Set<number>();
    const aDown = this.down.get(a) ?? new Set<number>();
    const bUp = this.up.get(b) ?? new Set<number>();
    const bDown = this.down.get(b) ?? new Set<number>();

    // n11 = both down, n10 = a down/b up, n01 = a up/b down, n00 = both up.
    let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
    for (const bucket of aDown) {
      if (bDown.has(bucket)) n11++;
      else if (bUp.has(bucket)) n10++;
    }
    for (const bucket of aUp) {
      if (bDown.has(bucket)) n01++;
      else if (bUp.has(bucket)) n00++;
    }
    const joint = n11 + n10 + n01 + n00;

    if (n11 < MIN_JOINT_FAILURES) return { joint, jointFailures: n11 };

    const num = n11 * n00 - n10 * n01;
    const den = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
    // A zero denominator means one variable never varied — no information,
    // which is a different statement from "no correlation".
    if (den === 0) return { joint, jointFailures: n11 };
    return { joint, jointFailures: n11, phi: num / den };
  }

  /** Is this pair, on the evidence, the same failure domain? */
  sameDomain(a: string, b: string): boolean {
    const e = this.evidence(a, b);
    return e.phi !== undefined && e.phi >= DOMAIN_PHI_THRESHOLD;
  }
}

/**
 * Group holders into inferred failure domains.
 *
 * Union-find over the `sameDomain` relation, because the relation is not
 * transitive on the evidence but domains are: if A correlates with B and B with
 * C, all three share a fate even when A and C have never been observed failing
 * together. Taking the transitive closure is the conservative reading, and
 * conservative here means "assume less redundancy than claimed".
 *
 * `declared` is the self-asserted hint (today, `deviceId`). It can only MERGE
 * holders, never split them: a node admitting it shares a machine is believable
 * because the admission costs it something, while a node claiming to be
 * separate is exactly the lie this module exists to catch.
 */
export function inferDomains(args: {
  holders: readonly string[];
  correlation: FailureCorrelation;
  declared?: (holder: string) => string | undefined;
}): Map<string, string> {
  const { holders, correlation, declared } = args;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = parent.get(x) ?? x;
    if (r !== x) { r = find(r); parent.set(x, r); }
    return r;
  };
  const union = (x: string, y: string) => {
    const rx = find(x), ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };
  for (const h of holders) parent.set(h, h);

  // Self-asserted hints first — they can only merge.
  if (declared) {
    const byDeclared = new Map<string, string>();
    for (const h of holders) {
      const d = declared(h);
      if (!d) continue;
      const seen = byDeclared.get(d);
      if (seen) union(h, seen); else byDeclared.set(d, h);
    }
  }

  for (let i = 0; i < holders.length; i++) {
    for (let j = i + 1; j < holders.length; j++) {
      if (correlation.sameDomain(holders[i]!, holders[j]!)) union(holders[i]!, holders[j]!);
    }
  }

  const out = new Map<string, string>();
  for (const h of holders) out.set(h, find(h));
  return out;
}

/**
 * Independent holders among a set — the number that may satisfy a redundancy
 * target.
 */
export function independentCount(args: {
  holders: readonly string[];
  correlation: FailureCorrelation;
  declared?: (holder: string) => string | undefined;
}): number {
  return new Set(inferDomains(args).values()).size;
}
