import { describe, it, expect } from 'vitest';
// `node:*` is legitimate here (vitest runs in Node) but the APP tsconfig has no
// node types — only `tsconfig.storage.json` does. Ignored rather than left to
// raise the app-layer error baseline, which is held at a fixed count on purpose.
// @ts-ignore -- no node types in tsconfig.json; this file only ever runs in vitest
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// @ts-ignore -- as above
import { join } from 'node:path';
import {
  TEST_FACE_BUILD, TEST_FACE_KEY, testFaceSeed,
  syntheticDescriptor, descriptorDistance,
} from './test-face';

/**
 * The synthetic face is a DEV-ONLY bypass of the liveness gate, so the tests
 * that matter most are the ones asserting it is off, and that what it produces
 * is indistinguishable in SHAPE from a real descriptor — a synthetic vector of
 * the wrong magnitude would pass or fail the real thresholds for reasons
 * unrelated to whatever a spec is checking.
 */

// Must match `MATCH_THRESHOLD` in face-verify.ts and `FACE_MATCH_THRESHOLD` in
// relay/server.ts. All three decide "same human?" and have to agree.
const MATCH_THRESHOLD = 0.45;

describe('the gate', () => {
  it('is OFF in any build that did not opt in', () => {
    // vitest defines no `__TEST_FACE__`, which is the same state a production
    // bundle is in. If this ever reads true, the bypass shipped.
    expect(TEST_FACE_BUILD).toBe(false);
  });

  it('refuses a seed when the build flag is off, even if one is set', () => {
    // Defence in depth: the localStorage key alone must never be enough, or a
    // shipped bundle would be one console command away from a synthetic face.
    const store: Record<string, string> = { [TEST_FACE_KEY]: 'alice' };
    const g = globalThis as { localStorage?: unknown };
    const had = 'localStorage' in g;
    g.localStorage = { getItem: (k: string) => store[k] ?? null };
    try {
      expect(testFaceSeed()).toBeNull();
    } finally {
      if (!had) delete g.localStorage;
    }
  });
});

describe('syntheticDescriptor', () => {
  it('is unit-norm, like a real face-api descriptor', () => {
    // Every threshold in the codebase is calibrated against unit length.
    for (const seed of ['alice', 'bob', 'carol']) {
      const d = syntheticDescriptor(seed);
      const norm = Math.sqrt(d.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 6);
    }
  });

  it('has 128 components inside the range the relay accepts', () => {
    // `validateDescriptor` in relay/server.ts: 128 finite numbers in (-2, 2).
    const d = syntheticDescriptor('alice');
    expect(d).toHaveLength(128);
    for (const x of d) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Math.abs(x)).toBeLessThan(2);
    }
  });

  it('gives the same identity for the same seed, across runs', () => {
    // A seeded profile is re-created, not re-enrolled: recovery and re-login
    // both need the seed to reproduce the descriptor exactly.
    expect(syntheticDescriptor('alice')).toEqual(syntheticDescriptor('alice'));
  });

  it('makes every seed a DIFFERENT human to the match gates', () => {
    // Two accounts on one machine must not read as one face, or the second hits
    // FACE_MAX and the relay refuses it. Independent unit vectors in 128-D are
    // nearly orthogonal, so the real separation is ~1.41 — the assertion is
    // against the threshold that actually decides, not against that number.
    const seeds = ['alice', 'bob', 'carol', 'dave', 'erin'];
    for (let i = 0; i < seeds.length; i++) {
      for (let j = i + 1; j < seeds.length; j++) {
        const dist = descriptorDistance(syntheticDescriptor(seeds[i]!), syntheticDescriptor(seeds[j]!));
        expect(dist, `${seeds[i]} vs ${seeds[j]}`).toBeGreaterThan(MATCH_THRESHOLD);
      }
    }
  });

  it('separates even seeds one character apart', () => {
    // FNV-1a then mulberry32: adjacent seeds must not produce adjacent faces,
    // or `alice1`/`alice2` would collide as the same human.
    const dist = descriptorDistance(syntheticDescriptor('alice1'), syntheticDescriptor('alice2'));
    expect(dist).toBeGreaterThan(MATCH_THRESHOLD);
  });

  it('spreads components like a real descriptor, not like noise at the wrong scale', () => {
    // Per-component RMS ~0.088 on a unit-norm 128-D vector. QUANT_BIN (0.1) is
    // sized against exactly this, so a descriptor at another scale would
    // quantize into bins the real path never produces.
    const d = syntheticDescriptor('alice');
    const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
    expect(rms).toBeGreaterThan(0.05);
    expect(rms).toBeLessThan(0.15);
  });
});


describe('a built bundle carries none of it', () => {
  // The structural guarantee the whole feature rests on: `vite.config.ts` bakes
  // `__TEST_FACE__` false for `vite build`, so the PRNG, the descriptor
  // generator, the seven guards in face-verify.ts and the warning strings are
  // all dead-code eliminated. Asserted rather than left to a manual grep,
  // because "verify by grepping dist/" is exactly the step a hurried deploy
  // skips — and what it would ship is the liveness bypass.
  //
  // Skipped when there is no build to inspect; it checks an artefact, not the
  // source, so it cannot run without one.
  const dist = 'dist/assets';
  const built = existsSync(dist) ? readdirSync(dist).filter((f: string) => f.endsWith('.js')) : [];

  it.skipIf(built.length === 0)('has no trace of the synthetic face in dist/', () => {
    const forbidden = ['neuron_test_face', 'SYNTHETIC FACE', 'liveness is NOT', 'testFaceBanner'];
    for (const file of built) {
      const body = readFileSync(join(dist, file), 'utf8');
      for (const needle of forbidden) {
        expect(body.includes(needle), `${file} contains "${needle}" — the bypass is in the bundle`).toBe(false);
      }
    }
  });
});
