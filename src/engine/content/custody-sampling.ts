/**
 * Proving a provider still holds what it claims — by READING a random sample
 * of it, at a cost that scales per PROVIDER rather than per object.
 *
 * Lucian's requirement (2026-09-22): get rid of periodic on-chain heartbeats
 * and replace them with an updateable **replicas + reads** score, where the
 * proof of storage is a successful read. His reasoning about the read itself is
 * exactly right and worth stating because it is the foundation of everything
 * here: content is addressed by its hash, so **a provider cannot fake a
 * response**. Serving wrong bytes fails the CID check, and serving right bytes
 * requires having them. A successful read is therefore already a proof of
 * custody, costing no extra crypto and no extra latency.
 *
 * The only gap was content nobody reads. This closes it without a heartbeat and
 * without per-object polling.
 *
 * ## The trick: sample, and let time compound
 *
 * A provider claiming `n` objects is challenged on `k` of them, chosen
 * unpredictably. If it really holds a fraction `f`, it passes all `k` with
 * probability `f^k`. So one round catches a big liar cheaply and a small liar
 * expensively — and that asymmetry is the right one, because a provider shaving
 * 1% is not the threat; one holding 10% is.
 *
 * What makes it affordable is that **detection compounds over the lease**. Over
 * `w` rounds the provider must survive `k × w` challenges, so a handful per
 * round reaches near-certainty within days while costing `O(providers)`, not
 * `O(objects)`. That is the 833× problem in B2 solved: the per-object cost was
 * an artefact of checking everything, not of checking at all.
 *
 * ## Why the challenge must be unpredictable
 *
 * If a provider can predict which objects will be asked for, it keeps those and
 * discards the rest — the sample stops being a sample. Selection is therefore
 * seeded from a value the provider does not control and cannot grind: the
 * consensus VRF output already in `engine/consensus` (RFC 9381), which is
 * publicly verifiable, so anyone can check that the right objects were asked
 * for. A challenge nobody can audit is an invitation to collude with the
 * auditor.
 */

/**
 * Probability that `challenges` random reads catch a provider holding only
 * `heldFraction` of what it claims.
 *
 * `1 - f^k`. Returns 0 for an honest provider, which is the correct answer:
 * there is nothing to detect.
 */
export function detectionProbability(heldFraction: number, challenges: number): number {
  const f = Math.min(1, Math.max(0, heldFraction));
  if (challenges <= 0) return 0;
  return 1 - Math.pow(f, challenges);
}

/**
 * Detection accumulated over several rounds — the number that matters.
 *
 * A single round is deliberately weak. The provider has to survive every round
 * for the life of the lease, and each one is an independent draw, so cheating
 * is caught by persistence rather than by intensity.
 */
export function cumulativeDetection(args: {
  heldFraction: number;
  challengesPerRound: number;
  rounds: number;
}): number {
  return detectionProbability(args.heldFraction, args.challengesPerRound * args.rounds);
}

/** Challenges needed to reach `confidence` against a given level of cheating. */
export function challengesForConfidence(heldFraction: number, confidence: number): number {
  const f = Math.min(1 - 1e-12, Math.max(0, heldFraction));
  if (f === 0) return 1;
  const c = Math.min(1 - 1e-12, Math.max(0, confidence));
  return Math.ceil(Math.log(1 - c) / Math.log(f));
}

/**
 * Challenge cost per window, against the alternative of checking everything.
 *
 * The comparison B2 got wrong by assuming "prove custody by reads" meant
 * reading every object.
 */
export function samplingCost(args: {
  providers: number;
  objectsPerProvider: number;
  challengesPerProviderPerRound: number;
}): { sampled: number; exhaustive: number; ratio: number } {
  const sampled = args.providers * args.challengesPerProviderPerRound;
  const exhaustive = args.providers * args.objectsPerProvider;
  return { sampled, exhaustive, ratio: exhaustive / Math.max(1, sampled) };
}

/**
 * Which objects to challenge, from a seed the provider cannot choose.
 *
 * Deterministic in the seed so any observer can recompute the selection and
 * confirm the auditor asked for the right things — an unauditable challenge is
 * a place for the auditor and the provider to agree on an easy question.
 *
 * Sampling is WITHOUT replacement: asking the same object twice in one round
 * would overstate the evidence, which is the same defect as a test that cannot
 * fail.
 */
export function selectChallenges(seed: number, objectCount: number, challenges: number): number[] {
  const k = Math.min(Math.max(0, Math.floor(challenges)), objectCount);
  const chosen = new Set<number>();
  let a = (seed >>> 0) || 1;
  let guard = 0;
  while (chosen.size < k && guard++ < objectCount * 20) {
    a ^= a << 13; a >>>= 0;
    a ^= a >> 17;
    a ^= a << 5; a >>>= 0;
    chosen.add(a % objectCount);
  }
  return [...chosen].sort((x, y) => x - y);
}

/**
 * Is cheating worth it?
 *
 * The security question is economic, not cryptographic: a provider discards
 * some bytes, saves their storage cost, and risks its earnings if caught.
 * Returns the expected value of cheating — negative means honesty pays, which
 * is the only form of "secure" available here.
 *
 * Expressed in whatever unit the caller uses for both terms, since the ratio is
 * what decides it.
 */
export function cheatingExpectedValue(args: {
  /** Fraction of claimed bytes actually kept. */
  heldFraction: number;
  challengesPerRound: number;
  rounds: number;
  /** Saved by not storing the discarded share, over the period. */
  storageSaved: number;
  /** Lost if caught: forfeited earnings, lease, and future income. */
  penaltyIfCaught: number;
}): number {
  const caught = cumulativeDetection(args);
  return args.storageSaved * (1 - caught) - args.penaltyIfCaught * caught;
}
