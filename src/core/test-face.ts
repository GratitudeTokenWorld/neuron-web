/**
 * ⚠ DEV/TEST ONLY — a synthetic face, so automated tests can create accounts.
 * **REMOVE BEFORE PRODUCTION, INCLUDING TESTNET.** See CLAUDE.md → *Remove
 * before production*.
 *
 * ## What this bypasses, and what it deliberately does not
 *
 * Account creation needs a live face through a depth sweep and a randomly
 * ordered action sequence. That cannot be automated — defeating it with a
 * recording is the exact attack it exists to stop — so every E2E account had to
 * be enrolled by hand, and a spec needing three accounts needed three humans.
 *
 * This replaces **only the camera**: the 128-float descriptor that a capture
 * would have produced is generated from a seed instead. Everything downstream
 * runs exactly as in production — `quantizeDescriptor` and `hashDescriptor`
 * build the FaceMap, the relay attests it, the nullifier is issued, the v3 blob
 * seals the keys under `XOR(face, PIN, share)`, and the Shamir share is split
 * across the attesters. That matters: a stubbed-out account would exercise a
 * path that does not ship, and the wiring is the half no unit test covers.
 *
 * ## Why this needs no relay change
 *
 * `/face-verify/verify` already takes a client-supplied descriptor over HTTP and
 * checks its shape, its `faceMapHash`, an unused challenge session, the per-IP
 * cap and the per-face account limit. It has never seen a camera. Liveness is
 * enforced entirely on the client, so a synthetic descriptor is attested by the
 * real relays — including the cloud ones — with nothing deployed and no
 * permissive flag on an internet-facing box. The relay's Sybil defence against
 * custom tooling is the IP cap and `FACE_MAX`, not the descriptor's provenance;
 * this module does not weaken it, it just stops pretending otherwise in tests.
 *
 * ## The gate
 *
 * Two independent conditions, both required:
 *
 *  1. `__TEST_FACE__`, baked by `vite.config.ts` and true only under
 *     `command === 'serve'` with `TEST_FACE=1`. A production `vite build` bakes
 *     `false`, so every branch below is dead-code eliminated — the same
 *     structural guarantee the dev relay proxy and the compressed storage
 *     timing rely on. Verify with: `grep -r "neuron_test_face" dist/`.
 *  2. A seed in `localStorage.neuron_test_face`, set per browser profile by the
 *     test harness. Without it the build flag alone changes nothing.
 *
 * Chosen over a `window` hook because localStorage survives the reload that
 * account creation performs, and because a test profile carries it in its saved
 * session the same way it carries the wallet.
 */

declare const __TEST_FACE__: boolean | undefined;

/** Baked at build time. `false` in any built bundle — see the gate above. */
export const TEST_FACE_BUILD: boolean =
  typeof __TEST_FACE__ !== 'undefined' ? __TEST_FACE__ === true : false;

export const TEST_FACE_KEY = 'neuron_test_face';

/**
 * The active synthetic identity, or `null` for the real camera path.
 *
 * Returns `null` whenever the build flag is off, so callers need no second
 * check and the whole feature collapses to a constant in a real build.
 */
export function testFaceSeed(): string | null {
  if (!TEST_FACE_BUILD) return null;
  try {
    const seed = localStorage.getItem(TEST_FACE_KEY);
    return seed && seed.trim() ? seed.trim() : null;
  } catch {
    return null; // private mode, blocked storage — fail to the real path
  }
}

/** FNV-1a, so a seed string becomes a stable 32-bit PRNG state. */
function seedState(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 1;
}

/** mulberry32 — small, and deterministic across engines, which is the point. */
function prng(state: number): () => number {
  let a = state >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic 128-D face descriptor for `seed`.
 *
 * **Unit norm on purpose.** Real face-api descriptors are unit-length, and every
 * threshold in this codebase is calibrated against that scale — `MATCH_THRESHOLD`
 * 0.45, `ENROLL_SPREAD_LIMIT`, and `QUANT_BIN` 0.1 against a per-component RMS
 * of ~0.088. A vector of the wrong magnitude would pass or fail those gates for
 * reasons that have nothing to do with what a test is checking, and it would
 * quantize into bins the real path never produces.
 *
 * **Distinct by construction.** Two independent unit vectors in 128 dimensions
 * are very nearly orthogonal, so they sit ~1.41 apart — far above the 0.45 that
 * means "same person". Each seed is therefore a different human to the relay's
 * `findMatchingFace`, which is what lets one machine hold several test accounts
 * without tripping `FACE_MAX`. Pinned in `test-face.test.ts`.
 *
 * Deterministic, so the same seed recovers the same identity on a later run —
 * a seeded profile can be re-created rather than re-enrolled.
 */
export function syntheticDescriptor(seed: string): number[] {
  const rand = prng(seedState(seed));
  const v = new Array<number>(128);
  // Box–Muller: a Gaussian per component, which is what makes the directions
  // uniform on the sphere. Uniform components would cluster along the diagonal
  // and two seeds could land closer than the match threshold.
  for (let i = 0; i < 128; i++) {
    const u1 = Math.max(rand(), Number.EPSILON);
    const u2 = rand();
    v[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 128; i++) v[i] = v[i]! / norm;
  return v;
}

/** Euclidean distance — the same measure every "same human?" gate uses. */
export function descriptorDistance(a: readonly number[], b: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    sum += d * d;
  }
  return Math.sqrt(sum);
}
