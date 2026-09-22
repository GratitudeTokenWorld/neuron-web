/**
 * How much a read is worth, per file, with diminishing returns.
 *
 * Lucian's refinement (2026-09-22): allow at least one paid read of **every
 * file a provider holds**, per reader, per cache-expiry window — so anyone can
 * read the whole catalogue and cache it — and then either stop counting or
 * taper repeats from the same reader.
 *
 * ## Why per-FILE is the right granularity
 *
 * It separates the two behaviours cleanly, which a flat byte cap cannot:
 *
 * - **Honest reading is BROAD** — many distinct files, once each, then cached.
 * - **Wash-reading is DEEP** — the same file over and over, because an attacker
 *   has only so much content and re-reading it is free.
 *
 * A flat per-pair byte cap punishes breadth (a provider holding ten thousand
 * files legitimately serves ten thousand distinct reads to one reader and hits
 * the cap) while barely inconveniencing depth. Per-file inverts that: breadth
 * is unlimited, depth is worthless. The cap stops being a quota and becomes a
 * shape.
 *
 * ## Why the window is the CACHE lifetime
 *
 * The only legitimate reason to fetch the same file twice is that the first
 * copy is gone — evicted, expired, or on another device. So the free read
 * should regenerate exactly as fast as caches expire. Tying it to anything else
 * would either charge honest re-reads or hand attackers a free refill.
 */

/**
 * Paid reads of one file, by one reader, from one provider, per cache window.
 *
 * One, because one is what a reader legitimately needs: fetch it, cache it,
 * done.
 */
export const FREE_READS_PER_FILE_PER_WINDOW = 1;

export type TaperPolicy =
  /** Nothing after the free read. Simplest, and slightly unfair to genuine re-reads. */
  | { kind: 'hard' }
  /** The nth read is worth `1/n`. Unbounded but logarithmic. */
  | { kind: 'harmonic' }
  /** The nth read is worth `ratio^(n-1)`. Bounded total, the tightest option. */
  | { kind: 'geometric'; ratio: number };

/**
 * Credit for the `nth` read of a file by the same reader in one window
 * (1-based). The first `FREE_READS_PER_FILE_PER_WINDOW` are worth full value.
 */
export function readCredit(nth: number, policy: TaperPolicy): number {
  if (nth <= 0) return 0;
  if (nth <= FREE_READS_PER_FILE_PER_WINDOW) return 1;
  const extra = nth - FREE_READS_PER_FILE_PER_WINDOW;
  switch (policy.kind) {
    case 'hard':
      return 0;
    case 'harmonic':
      return 1 / (extra + 1);
    case 'geometric':
      return Math.pow(policy.ratio, extra);
  }
}

/** Total credit for `reads` reads of ONE file by one reader in one window. */
export function cumulativeCredit(reads: number, policy: TaperPolicy): number {
  if (reads <= 0) return 0;
  let total = 0;
  // Closed forms exist for both tapers, but the loop is exact for the small
  // counts that matter and cannot drift from `readCredit` — the two agreeing is
  // the property worth keeping.
  const cap = Math.min(reads, 10_000);
  for (let n = 1; n <= cap; n++) total += readCredit(n, policy);
  if (reads > cap && policy.kind === 'harmonic') {
    // Tail of the harmonic series, so a huge count is still answered exactly
    // enough to compare against.
    total += Math.log(reads / cap);
  }
  return total;
}

/**
 * The ceiling on what repeating ONE file can ever be worth.
 *
 * `Infinity` for harmonic — it grows without bound, just very slowly — and a
 * finite number for geometric. Reported rather than hidden, because "bounded"
 * and "grows like a logarithm" are different promises and only one of them is
 * a guarantee.
 */
export function maxCreditPerFile(policy: TaperPolicy): number {
  switch (policy.kind) {
    case 'hard':
      return FREE_READS_PER_FILE_PER_WINDOW;
    case 'harmonic':
      return Infinity;
    case 'geometric':
      return FREE_READS_PER_FILE_PER_WINDOW + policy.ratio / (1 - policy.ratio);
  }
}

/**
 * What a provider can earn from one reader in a window, across its catalogue.
 *
 * The number that replaces the flat byte cap: it scales with how much DISTINCT
 * content the provider holds, which is the thing a big honest provider actually
 * has and an attacker has to pay to fake — every file it claims must survive
 * sampled custody challenges.
 */
export function providerCeilingPerReader(args: {
  filesHeld: number;
  policy: TaperPolicy;
  avgFileBytes: number;
}): { creditedReads: number; creditedBytes: number } {
  const perFile = maxCreditPerFile(args.policy);
  const credited = Number.isFinite(perFile)
    ? args.filesHeld * perFile
    : Infinity;
  return { creditedReads: credited, creditedBytes: credited * args.avgFileBytes };
}

/**
 * **Where the per-file counting must NOT live.**
 *
 * Per-file granularity would destroy the receipt design's compression if it
 * leaked into stored state: `ReceiptLedger` keeps one cumulative record per
 * (reader, provider) pair, which is what makes it `O(counterparties)` instead
 * of `O(interactions)`. Tracking every file would make it `O(files)` and undo
 * exactly the property "replace, don't append" was for.
 *
 * So the taper is applied **by the reader, as it reads**, and folded into the
 * cumulative *credited* total the receipt already carries. The reader knows
 * which files it fetched and how recently; nobody else needs to.
 *
 * This adds no new trust. The receipt was always the reader's attestation, and
 * a colluding reader could always lie about the total — the per-file taper is
 * one more thing an honest reader computes and a dishonest one misreports,
 * bounded by the same per-human caps and distinct-reader floor. What it
 * changes is the ATTACK SHAPE, and that is where the gain is: an attacker who
 * misreports now has to fake breadth (many distinct files, each of which must
 * survive sampled custody challenges) rather than depth (one file, many
 * times), and breadth costs real storage.
 */
export const TAPER_IS_APPLIED_READER_SIDE = true;

/** The recommended policy, and why. */
export const DEFAULT_TAPER: TaperPolicy = { kind: 'geometric', ratio: 0.5 };
