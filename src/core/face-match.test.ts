import { describe, it, expect, vi } from 'vitest';

// face-verify imports face-api/tfjs at module load for the camera path; the
// matching + crypto helpers exercised here need neither. (Same stub as
// face-locked-keys.test.ts — worth splitting the face *crypto* out one day.)
vi.mock('@tensorflow/tfjs', () => ({}));
vi.mock('@vladmandic/face-api', () => ({}));

import {
  compareFaces, quantizeDescriptor, descriptorSpread,
  MATCH_THRESHOLD, ENROLL_SPREAD_LIMIT, ENROLL_SPREAD_WARN,
} from './face-verify.js';
import { createEncryptedKeyBlob, recoverKeysWithFace, updateAttemptStateInBlob } from './face-store.js';
import { generateAccountKeys } from './account.js';

/**
 * The gap these tests close: every existing face test compares a descriptor
 * either to ITSELF (distance 0) or to an obviously different one (distance ~1).
 * Real recovery lives in neither case — it is the same person re-scanned hours
 * later in different light, which lands in the 0.25–0.45 band. Nothing covered
 * that band, so a comparison that was roughly twice as strict as intended
 * shipped and made dim-room accounts unrecoverable in daylight.
 */

/** Deterministic PRNG so a failure is reproducible rather than "sometimes". */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (rnd: () => number) => {
  let u = 0, v = 0, s = 0;
  do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
  return u * Math.sqrt(-2 * Math.log(s) / s);
};

/** face-api descriptors are L2-normalised 128-D vectors; model that exactly. */
function descriptor(seed: number): number[] {
  const rnd = mulberry32(seed);
  const v = Array.from({ length: 128 }, () => gauss(rnd));
  const n = Math.hypot(...v);
  return v.map(x => x / n);
}

/** The same face re-scanned: `base` displaced by ~`target` and renormalised. */
function rescan(base: number[], seed: number, target: number): number[] {
  const rnd = mulberry32(seed);
  const n = Array.from({ length: 128 }, () => gauss(rnd));
  const nn = Math.hypot(...n);
  const v = base.map((x, i) => x + (n[i] / nn) * target);
  const vn = Math.hypot(...v);
  return v.map(x => x / vn);
}

describe('compareFaces — the band real recovery lives in', () => {
  it('accepts the same face re-scanned under different lighting', () => {
    const enrolled = descriptor(1);
    // 0.25 / 0.35 / 0.42: the spread a single face produces across sessions,
    // all comfortably inside the 0.45 the relay's Sybil check already treats as
    // "the same human". Recovery must agree with that, or the network refuses a
    // second account for a face it will not let its owner recover with.
    for (const target of [0.25, 0.35, 0.42]) {
      const live = rescan(enrolled, 7, target);
      const { distance, match } = compareFaces(enrolled, live);
      expect(distance).toBeLessThan(MATCH_THRESHOLD);
      expect(match).toBe(true);
    }
  });

  it('rejects a different person', () => {
    const { distance, match } = compareFaces(descriptor(1), descriptor(2));
    expect(distance).toBeGreaterThan(MATCH_THRESHOLD);
    expect(match).toBe(false);
  });

  it('REGRESSION: quantizing before comparing roughly halves the threshold', () => {
    // The shipped bug, pinned so it cannot come back. Rounding to 0.1 bins is a
    // large fraction of a unit-norm descriptor's per-component RMS (~0.088), so
    // it does not add a little noise — it amplifies distance by about a square
    // root. Every one of these pairs is the same person and passes the raw
    // test; quantized, all of them are rejected as strangers.
    const enrolled = descriptor(3);
    for (const target of [0.30, 0.35, 0.42]) {
      const live = rescan(enrolled, 11, target);
      expect(compareFaces(enrolled, live).match).toBe(true);

      const quantized = compareFaces(quantizeDescriptor(enrolled), quantizeDescriptor(live));
      expect(quantized.distance).toBeGreaterThan(compareFaces(enrolled, live).distance);
      expect(quantized.match).toBe(false);
    }
  });
});

describe('recoverKeysWithFace — cross-session face, not a byte-identical one', () => {
  it('recovers the keys when the live scan differs as it does across lighting', async () => {
    const keys = await generateAccountKeys();
    const enrolled = descriptor(4);
    const blob = await createEncryptedKeyBlob(keys, 'dana', enrolled, 'facemap-hash', '1234');

    // This is the production failure verbatim: enrolled in one light, recovered
    // in another. It returned null before the raw-comparison fix.
    const live = rescan(enrolled, 13, 0.38);
    expect(compareFaces(enrolled, live).distance).toBeLessThan(MATCH_THRESHOLD);

    const recovered = await recoverKeysWithFace(blob, live, '1234');
    expect(recovered).not.toBeNull();
    expect(recovered!.keys.priv).toBe(keys.priv);
  });

  it('still refuses a different person holding the right PIN', async () => {
    const keys = await generateAccountKeys();
    const blob = await createEncryptedKeyBlob(keys, 'erin', descriptor(5), 'facemap-hash', '1234');
    // The face is the only factor left once a PIN leaks, so this is the check
    // that must not be relaxed alongside the one above.
    expect(await recoverKeysWithFace(blob, descriptor(6), '1234')).toBeNull();
  });
});

describe('blob attempt counter — sealed and read under the SAME key', () => {
  /**
   * The counter is encrypted with the enrollment-canonical face key. Recovery
   * used to re-derive its read key from the LIVE scan instead, which quantizes
   * into 0.1 bins that a fresh camera frame never reproduces across all 128
   * dimensions — so it never decrypted once, and every recovery silently
   * reported zero failed attempts. Nothing failed loudly because the fallback
   * is the same shape as a real answer.
   */
  it('round-trips a non-zero counter through a cross-session recovery', async () => {
    const keys = await generateAccountKeys();
    const enrolled = descriptor(10);
    const blob = await createEncryptedKeyBlob(keys, 'frank', enrolled, 'facemap-hash', '1234');

    // A prior recovery banked some failed attempts, sealed with the face key
    // recoverKeysWithFace hands back (the enrollment-canonical one).
    const first = await recoverKeysWithFace(blob, enrolled, '1234');
    expect(first).not.toBeNull();
    const carried = await updateAttemptStateInBlob(blob, first!.faceKey, {
      failedAttempts: 4, lockedUntil: 1_800_000_000_000,
    });

    // Next device, next session: a DIFFERENT scan of the same face — the case
    // that always failed, because the read key was derived from this scan.
    const live = rescan(enrolled, 17, 0.36);
    const second = await recoverKeysWithFace(carried, live, '1234');
    expect(second).not.toBeNull();
    expect(second!.attemptState).toEqual({ failedAttempts: 4, lockedUntil: 1_800_000_000_000 });
  });

  it('falls back to zero rather than blocking a blob with no counter', async () => {
    const keys = await generateAccountKeys();
    const enrolled = descriptor(11);
    const blob = await createEncryptedKeyBlob(keys, 'gina', enrolled, 'facemap-hash', '1234');
    // A pre-field blob, and a corrupt one: neither may cost a legitimate user
    // their account, so both degrade to "no attempts recorded".
    for (const variant of [
      { ...blob, pinAttemptState: undefined },
      { ...blob, pinAttemptState: 'bm90LWEtY2lwaGVydGV4dA==' },
    ]) {
      const r = await recoverKeysWithFace(variant, enrolled, '1234');
      expect(r).not.toBeNull();
      expect(r!.attemptState).toEqual({ failedAttempts: 0, lockedUntil: 0 });
    }
  });
});

describe('descriptorSpread — enrollment capture quality', () => {
  it('is ~0 for identical samples and grows with disagreement', () => {
    const base = descriptor(8);
    expect(descriptorSpread([base, base, base]).max).toBeCloseTo(0, 6);

    const clean = [base, rescan(base, 21, 0.08), rescan(base, 22, 0.09)];
    expect(descriptorSpread(clean).max).toBeLessThan(ENROLL_SPREAD_WARN);
  });

  it('flags a sitting whose own samples are as far apart as two people', () => {
    const base = descriptor(9);
    // A dark/blurry capture: three shots of ONE face, seconds apart, landing
    // further from each other than the match threshold. Whatever their mean
    // encodes, its owner cannot reproduce it later — so enrollFace refuses it
    // rather than minting an account that is unrecoverable by construction.
    const noisy = [base, rescan(base, 31, 0.6), rescan(base, 32, 0.7)];
    expect(descriptorSpread(noisy).max).toBeGreaterThanOrEqual(ENROLL_SPREAD_LIMIT);
  });
});
