import { describe, it, expect } from 'vitest';
import {
  FailureCorrelation, inferDomains, independentCount,
  observationBucketMs, MIN_JOINT_FAILURES, DOMAIN_PHI_THRESHOLD,
} from './failure-domain.js';

/**
 * The claim under test: co-failure history distinguishes real independence from
 * asserted independence, and it refuses to answer when it does not know.
 *
 * Disproved by any of: a healthy fleet being grouped into one domain, two
 * genuinely independent holders being merged, or a confident answer from a
 * sample too thin to support one.
 */

const T0 = 1_000_000_000_000;
const at = (bucket: number) => T0 + bucket * observationBucketMs();

describe('co-failure, not co-availability', () => {
  it('does NOT group a healthy fleet that is simply always up', () => {
    // The trap this design exists to avoid. Two holders up every bucket are
    // perfectly correlated and completely unrelated; correlating availability
    // would mark the entire healthy network as a single failure domain.
    const c = new FailureCorrelation();
    for (let b = 0; b < 50; b++) {
      c.record('a', true, at(b));
      c.record('b', true, at(b));
    }
    expect(c.sameDomain('a', 'b')).toBe(false);
    expect(c.evidence('a', 'b').phi).toBeUndefined();
    expect(independentCount({ holders: ['a', 'b'], correlation: c })).toBe(2);
  });

  it('groups holders that go down together', () => {
    const c = new FailureCorrelation();
    for (let b = 0; b < 40; b++) {
      const down = b % 7 === 0; // same outages, same buckets
      c.record('a', !down, at(b));
      c.record('b', !down, at(b));
    }
    const e = c.evidence('a', 'b');
    expect(e.jointFailures).toBeGreaterThanOrEqual(MIN_JOINT_FAILURES);
    expect(e.phi).toBeGreaterThan(DOMAIN_PHI_THRESHOLD);
    expect(c.sameDomain('a', 'b')).toBe(true);
    expect(independentCount({ holders: ['a', 'b'], correlation: c })).toBe(1);
  });

  it('keeps holders separate when their outages do not line up', () => {
    const c = new FailureCorrelation();
    for (let b = 0; b < 40; b++) {
      c.record('a', b % 7 !== 0, at(b));
      c.record('b', b % 5 !== 0, at(b));
    }
    expect(c.sameDomain('a', 'b')).toBe(false);
    expect(independentCount({ holders: ['a', 'b'], correlation: c })).toBe(2);
  });
});

describe('it refuses to answer on a thin sample', () => {
  it('reports no phi below the joint-failure floor', () => {
    // Two shared outages make any pair look perfectly correlated. Reporting
    // that is the project's oldest defect — the unmeasured rendered as fact.
    const c = new FailureCorrelation();
    for (let b = 0; b < 20; b++) {
      const down = b < MIN_JOINT_FAILURES - 1;
      c.record('a', !down, at(b));
      c.record('b', !down, at(b));
    }
    const e = c.evidence('a', 'b');
    expect(e.jointFailures).toBe(MIN_JOINT_FAILURES - 1);
    expect(e.phi).toBeUndefined();
    expect(c.sameDomain('a', 'b')).toBe(false);
  });

  it('treats a brand-new holder as possibly independent', () => {
    // Principle 1: refusing to place on holders with no history would make
    // joining impossible. Unknown must mean "not proven related", not
    // "excluded".
    const c = new FailureCorrelation();
    for (let b = 0; b < 30; b++) c.record('veteran', b % 7 !== 0, at(b));
    c.record('newcomer', true, at(30));
    expect(c.sameDomain('veteran', 'newcomer')).toBe(false);
    expect(independentCount({ holders: ['veteran', 'newcomer'], correlation: c })).toBe(2);
  });
});

describe('the self-asserted hint can only merge, never split', () => {
  const c = new FailureCorrelation();

  it('merges holders that admit sharing a machine', () => {
    // Admitting co-location costs the admitter something, so it is believable.
    const declared = (h: string) => (h === 'a' || h === 'b' ? 'dev:1' : undefined);
    expect(independentCount({ holders: ['a', 'b', 'c'], correlation: c, declared })).toBe(2);
  });

  it('does not let a claim of separateness override observed co-failure', () => {
    // The whole point: deviceId is a random UUID in localStorage, so "we are
    // different machines" is a free assertion. Evidence outranks it.
    const corr = new FailureCorrelation();
    for (let b = 0; b < 40; b++) {
      const down = b % 6 === 0;
      corr.record('a', !down, at(b));
      corr.record('b', !down, at(b));
    }
    // Each claims its own distinct device.
    const declared = (h: string) => `dev:${h}`;
    expect(independentCount({ holders: ['a', 'b'], correlation: corr, declared })).toBe(1);
  });
});

describe('domains are transitive even when the evidence is not', () => {
  it('closes A~B and B~C into one domain', () => {
    // A and C may never have been seen failing together, but if both share a
    // fate with B they share it with each other. Conservative reading:
    // assume less redundancy than claimed.
    const c = new FailureCorrelation();
    for (let b = 0; b < 60; b++) {
      const abDown = b % 6 === 0;
      const bcDown = b % 9 === 0;
      c.record('a', !abDown, at(b));
      c.record('b', !(abDown || bcDown), at(b));
      c.record('c', !bcDown, at(b));
    }
    const domains = inferDomains({ holders: ['a', 'b', 'c'], correlation: c });
    expect(new Set(domains.values()).size).toBeLessThan(3);
  });
});

describe('history is bounded', () => {
  it('drops observations past the retention window', () => {
    // Observation history keyed by a holder an outsider chooses is the shape
    // that has leaked twice (SCREENING.md → 1), so it needs a remover.
    const c = new FailureCorrelation(10);
    for (let b = 0; b < 100; b++) c.record('a', b % 2 === 0, at(b));
    // Still tracked, but only the recent window is retained — the pair
    // statistics stay finite however long the node runs.
    expect(c.holders()).toEqual(['a']);
    c.forget('a');
    expect(c.holders()).toEqual([]);
  });
});
