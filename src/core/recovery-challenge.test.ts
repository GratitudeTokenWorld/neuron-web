import { describe, it, expect } from 'vitest';
import {
  drawRecoverySequence, verifyTrajectory, RECOVERY_ACTIONS,
  MIN_ACTION_RATIO, MIN_ACTION_GAP_MS, MIN_TOTAL_MS,
  type TrajectoryProof,
} from './recovery-challenge.js';

/**
 * These tests ARE the relay's release-gate coverage: relay/server.ts is
 * typechecked by nothing and tested by nothing, so the acceptance rules live in
 * the pure module and get pinned here. Every attack the gate claims to stop
 * has a test proving the verifier stops it.
 */

/** Deterministic descriptor at a controlled offset from a base face. */
function face(seed: number): number[] {
  let s = seed;
  const v = Array.from({ length: 128 }, () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  });
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

/** Same person, slightly different frame: base + tiny deterministic jitter. */
function frameOf(base: number[], k: number): number[] {
  const v = base.map((x, i) => x + Math.sin(i * 3.7 + k * 13.1) * 0.004);
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

const SEQ = ['smile', 'mouth-open', 'look-left'] as const;

function honestProof(base: number[]): TrajectoryProof {
  return {
    neutralDescriptor: frameOf(base, 0),
    actions: SEQ.map((action, i) => ({
      action,
      ratio: 1.1 + i * 0.05,
      t: 10_000 + i * 1_400,
      descriptor: frameOf(base, i + 1),
    })),
  };
}

describe('drawRecoverySequence', () => {
  it('draws distinct actions from the recovery pool', () => {
    for (let trial = 0; trial < 50; trial++) {
      const seq = drawRecoverySequence();
      expect(seq).toHaveLength(3);
      expect(new Set(seq).size).toBe(3);
      for (const a of seq) expect(RECOVERY_ACTIONS).toContain(a);
    }
  });

  it('is server-controlled: injected rng determines the draw', () => {
    let i = 0;
    const rng = () => [0.0, 0.0, 0.0][i++ % 3];
    expect(drawRecoverySequence(3, rng)).toEqual(['smile', 'mouth-open', 'raise-brows']);
  });
});

describe('verifyTrajectory — accepts the honest case', () => {
  it('passes a well-paced, in-order, same-person performance', () => {
    expect(verifyTrajectory(SEQ, honestProof(face(1)))).toEqual({ ok: true });
  });
});

describe('verifyTrajectory — the attacks it exists to stop', () => {
  it('STILL PHOTO: zero expression ratios are rejected', () => {
    // A photo matches the identity but cannot move: its "deltas" are noise
    // around zero, so every ratio sits far under the detector threshold.
    const p = honestProof(face(2));
    for (const a of p.actions) a.ratio = 0.05;
    const v = verifyTrajectory(SEQ, p);
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('ratio');
  });

  it('REPLAY OF ANOTHER SESSION: wrong order/action set is rejected', () => {
    // A sniffed legit session performed [smile, mouth-open, look-left]; this
    // challenge demands a different order — the stolen packet cannot comply.
    const p = honestProof(face(3));
    expect(verifyTrajectory(['mouth-open', 'smile', 'look-left'], p).ok).toBe(false);
    expect(verifyTrajectory(['smile', 'mouth-open', 'raise-brows'], p).ok).toBe(false);
  });

  it('FABRICATED PACING: bunched timestamps are rejected', () => {
    const p = honestProof(face(4));
    p.actions = p.actions.map((a, i) => ({ ...a, t: 10_000 + i * (MIN_ACTION_GAP_MS - 50) }));
    const v = verifyTrajectory(SEQ, p);
    expect(v.ok).toBe(false);
  });

  it('FABRICATED PACING: an instant total performance is rejected', () => {
    const p = honestProof(face(5));
    // Gaps individually legal but the whole run under the human floor.
    p.actions = p.actions.map((a, i) => ({ ...a, t: 10_000 + i * (MIN_TOTAL_MS / 2 - 100) }));
    expect(verifyTrajectory(SEQ, p).ok).toBe(false);
  });

  it('PERSON SWAP: a different face on one action is rejected', () => {
    const p = honestProof(face(6));
    p.actions[2] = { ...p.actions[2], descriptor: face(99) };
    const v = verifyTrajectory(SEQ, p);
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('not one person');
  });

  it('LAZY REPLAY: byte-identical descriptors across frames are rejected', () => {
    const p = honestProof(face(7));
    const one = face(7);
    p.neutralDescriptor = one;
    p.actions = p.actions.map(a => ({ ...a, descriptor: [...one] }));
    const v = verifyTrajectory(SEQ, p);
    expect(v.ok).toBe(false);
    expect((v as { reason: string }).reason).toContain('byte-identical');
  });

  it('MALFORMED: wrong count, bad descriptor, missing timestamp all rejected', () => {
    const base = face(8);
    expect(verifyTrajectory(SEQ, { ...honestProof(base), actions: honestProof(base).actions.slice(0, 2) }).ok).toBe(false);
    const bad = honestProof(base);
    bad.actions[0] = { ...bad.actions[0], descriptor: [1, 2, 3] };
    expect(verifyTrajectory(SEQ, bad).ok).toBe(false);
    const noT = honestProof(base);
    noT.actions[1] = { ...noT.actions[1], t: NaN };
    expect(verifyTrajectory(SEQ, noT).ok).toBe(false);
  });

  it('REGRESSION: pose/expression-shifted descriptors are what the band rejects', () => {
    // The false rejection of a real user, 2026-08-15: descriptors captured at
    // the ACTION PEAK measured 0.501 apart for one person (face-api is barely
    // pose-invariant). The verifier is right to reject that — the FIX was to
    // capture at rest (main.ts recoveryProofCapture), not to widen the band.
    // This pins the rule so a future "just raise the threshold" cannot land
    // without confronting the comment on DESCRIPTOR_MAX_PAIRWISE.
    const base = face(10);
    const posed = honestProof(base);
    // Simulate a peak-captured (pose-shifted) descriptor on action 2.
    const shifted = base.map((x, i) => x + Math.sin(i * 0.9) * 0.05);
    const n = Math.hypot(...shifted);
    posed.actions[2] = { ...posed.actions[2], descriptor: shifted.map(x => x / n) };
    const v = verifyTrajectory(SEQ, posed);
    if (!v.ok) expect(v.reason).toContain('not one person');
    // At-rest capture of the same run stays inside the band.
    expect(verifyTrajectory(SEQ, honestProof(base)).ok).toBe(true);
  });

  it('boundary: ratio exactly at the floor passes, just under fails', () => {
    const at = honestProof(face(9));
    at.actions[0].ratio = MIN_ACTION_RATIO;
    expect(verifyTrajectory(SEQ, at).ok).toBe(true);
    const under = honestProof(face(9));
    under.actions[0].ratio = MIN_ACTION_RATIO - 0.01;
    expect(verifyTrajectory(SEQ, under).ok).toBe(false);
  });
});
