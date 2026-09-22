/**
 * Does any per-node structure grow monotonically over hours at target rates?
 *
 * Stress-test #1 in SCREENING.md, deferred through four sessions and the one
 * that keeps being described as "the test that would have found both limiter
 * leaks by construction". It would also have found four defects introduced
 * *this* session — an unbounded sample array, a quadratic sweep, two maps with
 * no remover — every one of which was caught by hand instead.
 *
 * The invariant has two dimensions (ARCHITECTURE.md). `O(own + followed)`
 * describes a moment; a map that only ever grows satisfies it at every instant
 * and still exhausts the box. This measures the second dimension directly:
 * drive the SHIPPING structures with a realistic mix of work over simulated
 * time, and assert that what they hold is bounded by counterparties and
 * interest rather than by elapsed time.
 *
 * It drives the real objects, never models of them — the lesson `repair.ts`
 * paid for, where a model of the policy passed while the policy failed.
 */

/** mulberry32 — seeded, so a leak found once is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LoadProfile {
  /** Simulated hours to run. */
  hours: number;
  /** Operations per simulated hour. */
  opsPerHour: number;
  /**
   * Distinct CIDs the node ever touches. Bounded, because a node reads its own
   * and followed content — the invariant's first dimension.
   */
  distinctCids: number;
  /** Distinct counterparties (readers, providers) it ever meets. */
  distinctPeers: number;
  /**
   * New peers introduced per hour, to model churn. This is the term that turns
   * a bounded structure into an unbounded one if nothing removes entries.
   */
  newPeersPerHour: number;
  seed?: number;
}

export const DEFAULT_LOAD: LoadProfile = {
  hours: 24 * 30,          // a month
  opsPerHour: 500,
  distinctCids: 2_000,
  distinctPeers: 200,
  newPeersPerHour: 5,
  seed: 11,
};

export interface Sample {
  atHour: number;
  sizes: Record<string, number>;
}

/**
 * One structure under test: how to feed it, how to sweep it, how big it is.
 *
 * Declaring the sweep alongside the structure is deliberate — SCREENING.md → 1
 * asks "what removes an entry?" of every keyed structure, and a subject that
 * cannot answer it fails this harness by construction rather than by
 * assertion.
 */
export interface Subject {
  name: string;
  /** Apply one operation at simulated time `now`. */
  step(now: number, cid: string, peer: string): void;
  /** Whatever the node would call periodically. */
  sweep?(now: number): void;
  /**
   * Entries currently held, measured at `now`.
   *
   * The clock is passed in deliberately. A first version let subjects call
   * `Date.now()`, which measured simulated data against wall-clock time — two
   * things measuring different things, the trap this codebase keeps paying
   * for, and it made a bounded structure look like it was growing.
   */
  size(now: number): number;
}

export interface LoadResult {
  samples: Sample[];
  /** Final size per subject. */
  finalSizes: Record<string, number>;
  /**
   * Growth between the second half's first and last sample, per subject.
   *
   * Measured over the SECOND half so warm-up is excluded: every structure grows
   * while it is filling, and that is not a leak. What matters is whether it is
   * still growing once it has seen everything it is going to see.
   */
  lateGrowth: Record<string, number>;
}

/**
 * Run the profile against a set of subjects.
 *
 * Time advances in whole hours and the sweep runs hourly, which is what a node
 * does: nothing here gets to prune on every operation, because real code does
 * not.
 */
export function runSustainedLoad(subjects: readonly Subject[], profile: LoadProfile = DEFAULT_LOAD): LoadResult {
  const rand = rng(profile.seed ?? 1);
  const HOUR = 3_600_000;
  const start = 1_700_000_000_000;

  const cids = Array.from({ length: profile.distinctCids }, (_, i) => `cid-${i}`);
  const peers: string[] = Array.from({ length: profile.distinctPeers }, (_, i) => `peer-${i}`);
  let nextPeer = peers.length;

  const samples: Sample[] = [];
  for (let h = 0; h < profile.hours; h++) {
    const now = start + h * HOUR;
    for (let i = 0; i < profile.newPeersPerHour; i++) peers.push(`peer-${nextPeer++}`);

    for (let op = 0; op < profile.opsPerHour; op++) {
      const cid = cids[Math.floor(rand() * cids.length)]!;
      // Weighted toward recent peers, which is what churn looks like: old ones
      // stop appearing rather than being formally removed.
      const window = Math.min(peers.length, profile.distinctPeers);
      const peer = peers[peers.length - 1 - Math.floor(rand() * window)]!;
      const at = now + Math.floor((op / profile.opsPerHour) * HOUR);
      for (const s of subjects) s.step(at, cid, peer);
    }

    for (const s of subjects) s.sweep?.(now + HOUR);
    if (h % Math.max(1, Math.floor(profile.hours / 24)) === 0 || h === profile.hours - 1) {
      const sizes: Record<string, number> = {};
      for (const s of subjects) sizes[s.name] = s.size(now + HOUR);
      samples.push({ atHour: h, sizes });
    }
  }

  const finalSizes: Record<string, number> = {};
  const end = start + profile.hours * HOUR;
  for (const s of subjects) finalSizes[s.name] = s.size(end);

  const half = Math.floor(samples.length / 2);
  const lateGrowth: Record<string, number> = {};
  const first = samples[half];
  const last = samples[samples.length - 1];
  for (const s of subjects) {
    lateGrowth[s.name] = (last?.sizes[s.name] ?? 0) - (first?.sizes[s.name] ?? 0);
  }
  return { samples, finalSizes, lateGrowth };
}
