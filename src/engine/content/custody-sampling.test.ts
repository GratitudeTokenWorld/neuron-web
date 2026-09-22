import { describe, it, expect } from 'vitest';
import {
  detectionProbability, cumulativeDetection, challengesForConfidence,
  samplingCost, selectChallenges, cheatingExpectedValue,
} from './custody-sampling.js';

/**
 * Hypothesis H-P6: custody can be proven by READS alone — no heartbeat, no
 * periodic on-chain data — at a cost that scales per provider.
 *
 * Disproved by: a per-object cost (which is what made "prove custody by reads"
 * look 833x too expensive in the first pass), or a detection rate too low to
 * make cheating unprofitable.
 */

describe('H-P6: sampling costs per PROVIDER, not per object', () => {
  it('is three orders of magnitude cheaper than checking everything', () => {
    // The mistake in the first black-hat pass was assuming "proof by read"
    // meant reading every object. It means reading a random few.
    const c = samplingCost({ providers: 10_000, objectsPerProvider: 5_000, challengesPerProviderPerRound: 5 });
    expect(c.sampled).toBe(50_000);
    expect(c.exhaustive).toBe(50_000_000);
    expect(c.ratio).toBe(1_000);
  });

  it('costs the same whether a provider holds 100 objects or 100,000', () => {
    // The invariant property: the challenge budget is per provider, so a big
    // provider is not more expensive to audit than a small one.
    const small = samplingCost({ providers: 1, objectsPerProvider: 100, challengesPerProviderPerRound: 5 });
    const huge = samplingCost({ providers: 1, objectsPerProvider: 100_000, challengesPerProviderPerRound: 5 });
    expect(small.sampled).toBe(huge.sampled);
  });
});

describe('detection: cheap against big lies, and time does the rest', () => {
  it('catches a provider holding half of what it claims almost at once', () => {
    expect(detectionProbability(0.5, 5)).toBeGreaterThan(0.96);
    expect(detectionProbability(0.5, 10)).toBeGreaterThan(0.999);
  });

  it('is weak against small lies in ONE round, which is expected and fine', () => {
    // A provider shaving 1% is not the threat. Stating the weakness rather
    // than hiding it is the difference between a bound and a claim.
    expect(detectionProbability(0.99, 5)).toBeLessThan(0.06);
  });

  it('compounds over the lease — persistence, not intensity', () => {
    // The number that matters. Five challenges a round, and a provider holding
    // 90% is caught within six rounds; even 99% is caught within seventy-two.
    expect(cumulativeDetection({ heldFraction: 0.9, challengesPerRound: 5, rounds: 6 })).toBeGreaterThan(0.95);
    expect(cumulativeDetection({ heldFraction: 0.99, challengesPerRound: 5, rounds: 72 })).toBeGreaterThan(0.97);
  });

  it('reports how many challenges a confidence level needs', () => {
    expect(challengesForConfidence(0.5, 0.99)).toBe(7);
    expect(challengesForConfidence(0.9, 0.99)).toBe(44);
    // An honest provider is never "detected", which is the correct answer
    // rather than a special case.
    expect(detectionProbability(1, 1_000)).toBe(0);
  });
});

describe('the economics, which is what security means here', () => {
  it('makes cheating negative-value at every level tested', () => {
    // Cryptography cannot stop a provider deleting bytes. Making it a losing
    // trade can.
    for (const f of [0.5, 0.9, 0.99]) {
      const ev = cheatingExpectedValue({
        heldFraction: f,
        challengesPerRound: 5,
        rounds: 24,
        storageSaved: 100 * (1 - f),
        penaltyIfCaught: 1_000,
      });
      expect(ev).toBeLessThan(0);
    }
  });

  it('flips to profitable when the penalty is too small — the real knob', () => {
    // Honest sensitivity: this is not secure by construction, it is secure by
    // pricing, so the penalty has to be worth more than the storage saved.
    const ev = cheatingExpectedValue({
      heldFraction: 0.99,
      challengesPerRound: 1,
      rounds: 1,
      storageSaved: 100,
      penaltyIfCaught: 0.5,
    });
    expect(ev).toBeGreaterThan(0);
  });
});

describe('the challenge must be unpredictable and auditable', () => {
  it('is deterministic in the seed, so anyone can check what was asked', () => {
    // An unauditable challenge is where an auditor and a provider agree on an
    // easy question.
    expect(selectChallenges(12345, 1000, 5)).toEqual(selectChallenges(12345, 1000, 5));
  });

  it('selects differently for different seeds', () => {
    expect(selectChallenges(1, 1000, 8)).not.toEqual(selectChallenges(2, 1000, 8));
  });

  it('never asks for the same object twice in one round', () => {
    // Repeating an object would overstate the evidence — the same defect as a
    // test that cannot fail.
    const picks = selectChallenges(99, 50, 20);
    expect(new Set(picks).size).toBe(picks.length);
    expect(picks.length).toBe(20);
  });

  it('cannot ask for more objects than exist', () => {
    expect(selectChallenges(7, 3, 10).length).toBe(3);
    expect(selectChallenges(7, 0, 10).length).toBe(0);
  });
});
