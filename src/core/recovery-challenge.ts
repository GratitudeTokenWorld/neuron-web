/**
 * Challenge-trajectory verification for the recovery-share release gate.
 *
 * PURE — no I/O, no face DB, no crypto. The relay imports `verifyTrajectory`
 * to judge a release attempt and vitest imports it to pin the acceptance rules,
 * which matters doubly here: relay/server.ts is covered by no typecheck and no
 * test, so every releasable piece of its logic belongs in a module like this.
 *
 * What this closes, exactly. Before it, the release gate was a single
 * descriptor match: one still photo of the victim, run through face-api
 * offline, passed. A photo produces ONE facial geometry, so it cannot yield a
 * sequence of expression deltas in a server-chosen order. Demanding that
 * sequence — anchored to descriptors that match the enrolled identity — raises
 * the entry bar from "possess a photo" to "possess video/a reenactment of the
 * victim, or fabricate the numbers with custom tooling".
 *
 * And the honest ceiling, stated where the code lives: every number verified
 * here is CLIENT-COMPUTED. The relay never sees pixels, so a custom client can
 * fabricate plausible trajectories around a photo-derived descriptor. This
 * gate therefore buys (a) the stock client + photo attack is dead, (b) replay
 * of a sniffed legit session is dead (the action set/order is redrawn per
 * challenge: 3 ordered draws from 5 ≈ 1-in-60 per attempt, under the release
 * backoff), (c) fabrication requires per-victim tooling — cost, not
 * impossibility. Certainty would need the verifier to see trusted sensor data;
 * that is the documented heavier road (ARCHITECTURE, Subsystem 5), not this.
 */

/**
 * Actions the relay may demand. `close-eyes` is excluded on purpose: its client
 * threshold is dynamic (derived from the user's measured eye jitter against a
 * rolling reference), so there is no fixed server-side floor to hold its proof
 * against. The five below all measure as simple deltas from the neutral frame.
 */
export const RECOVERY_ACTIONS = ['smile', 'mouth-open', 'raise-brows', 'look-left', 'look-right'] as const;
export type RecoveryAction = typeof RECOVERY_ACTIONS[number];

/** How many actions one relay demands per release challenge. */
export const RECOVERY_SEQUENCE_LENGTH = 3;

/** One performed action, as reported by the client's own detector. */
export interface ActionProof {
  action: string;
  /**
   * Weakest-signal ratio of measured delta over the client detector's
   * threshold at the moment the action armed (≥ 1 when the detector passed).
   * Action-agnostic on purpose — the relay does not re-implement per-action
   * geometry, it checks the client's detector genuinely fired.
   */
  ratio: number;
  /** Client clock at the pass moment — only DIFFERENCES are judged. */
  t: number;
  /** 128-D recognition descriptor captured right after the action passed. */
  descriptor: number[];
}

export interface TrajectoryProof {
  /** Descriptor of the relaxed face, captured at calibration. */
  neutralDescriptor: number[];
  actions: ActionProof[];
}

/**
 * Acceptance floor on the client-reported ratio. Below 1.0 because the
 * detector's own hysteresis (HOLD_FRACTION 0.75) can legitimately report the
 * arming frame a whisker under the peak; 0.9 keeps honest passes while a photo
 * still reports ~0 on every expression it cannot make.
 */
export const MIN_ACTION_RATIO = 0.9;

/**
 * Pacing floor between consecutive action passes. The client's own SUSTAIN_MS
 * is 320 ms plus a ~1 s inter-action hold, so honest runs sit far above this;
 * a fabricated packet with all timestamps bunched together sits below it.
 */
export const MIN_ACTION_GAP_MS = 300;

/** A whole performance faster than this is not a human doing 3 expressions. */
export const MIN_TOTAL_MS = 1_500;
export const MAX_TOTAL_MS = 10 * 60 * 1000;

/**
 * Same-person consistency band across ALL submitted descriptors (neutral +
 * actions), pairwise Euclidean. The ceiling is MATCH_THRESHOLD's rationale —
 * two descriptors further apart than distinct people are allowed to be means a
 * person swap mid-sequence. The floor rejects the LAZIEST replay (byte-identical
 * descriptor pasted into every slot); it is deliberately tiny because honest
 * consecutive frames of a still face measure ~0.05-0.15 apart and we must never
 * reject a real user for holding admirably still. (A fabricator adds noise and
 * clears this — see the module header for what this gate does and does not buy.)
 */
export const DESCRIPTOR_MAX_PAIRWISE = 0.45;
export const DESCRIPTOR_MIN_PAIRWISE = 0.001;

export type TrajectoryVerdict = { ok: true } | { ok: false; reason: string };

function validDescriptor(d: unknown): d is number[] {
  return Array.isArray(d) && d.length === 128 &&
    d.every(v => typeof v === 'number' && Number.isFinite(v) && v > -2 && v < 2);
}

function dist(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < 128; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Draw a challenge sequence: `len` DISTINCT actions in a server-chosen order.
 * `rng` defaults to Math.random (the relay); tests inject determinism.
 * Distinct, not with-replacement: "smile, smile, smile" would let one stolen
 * smile satisfy a third of the draw space.
 */
export function drawRecoverySequence(
  len = RECOVERY_SEQUENCE_LENGTH,
  rng: () => number = Math.random,
): RecoveryAction[] {
  const pool = [...RECOVERY_ACTIONS];
  const seq: RecoveryAction[] = [];
  for (let i = 0; i < len && pool.length; i++) {
    seq.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return seq;
}

/**
 * Judge a proof against the sequence this relay drew. Every rejection names
 * its rule — a released share is irreversible, so a refused legit user must be
 * able to see (via the relay log) exactly which bar they missed.
 */
export function verifyTrajectory(sequence: readonly string[], proof: TrajectoryProof): TrajectoryVerdict {
  if (!proof || !validDescriptor(proof.neutralDescriptor)) {
    return { ok: false, reason: 'neutral descriptor missing or malformed' };
  }
  if (!Array.isArray(proof.actions) || proof.actions.length !== sequence.length) {
    return { ok: false, reason: `expected ${sequence.length} action proofs, got ${proof.actions?.length ?? 0}` };
  }
  for (let i = 0; i < sequence.length; i++) {
    const p = proof.actions[i];
    if (!p || p.action !== sequence[i]) {
      return { ok: false, reason: `action ${i} is '${p?.action}', challenge demanded '${sequence[i]}'` };
    }
    if (typeof p.ratio !== 'number' || !Number.isFinite(p.ratio) || p.ratio < MIN_ACTION_RATIO) {
      return { ok: false, reason: `action '${p.action}' ratio ${p?.ratio} below ${MIN_ACTION_RATIO}` };
    }
    if (typeof p.t !== 'number' || !Number.isFinite(p.t)) {
      return { ok: false, reason: `action '${p.action}' has no timestamp` };
    }
    if (!validDescriptor(p.descriptor)) {
      return { ok: false, reason: `action '${p.action}' descriptor malformed` };
    }
  }
  // Pacing: strictly increasing, humanly spaced, humanly bounded.
  for (let i = 1; i < proof.actions.length; i++) {
    const gap = proof.actions[i].t - proof.actions[i - 1].t;
    if (gap < MIN_ACTION_GAP_MS) {
      return { ok: false, reason: `actions ${i - 1}→${i} only ${gap}ms apart (min ${MIN_ACTION_GAP_MS})` };
    }
  }
  const total = proof.actions[proof.actions.length - 1].t - proof.actions[0].t;
  if (total < MIN_TOTAL_MS) return { ok: false, reason: `whole sequence in ${total}ms (min ${MIN_TOTAL_MS})` };
  if (total > MAX_TOTAL_MS) return { ok: false, reason: `sequence took ${total}ms (max ${MAX_TOTAL_MS})` };

  // Same-person consistency across every descriptor in the packet.
  const all = [proof.neutralDescriptor, ...proof.actions.map(a => a.descriptor)];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const d = dist(all[i], all[j]);
      if (d > DESCRIPTOR_MAX_PAIRWISE) {
        return { ok: false, reason: `descriptors ${i}/${j} are ${d.toFixed(3)} apart — not one person` };
      }
      if (d < DESCRIPTOR_MIN_PAIRWISE) {
        return { ok: false, reason: `descriptors ${i}/${j} are byte-identical — replayed frame` };
      }
    }
  }
  return { ok: true };
}
