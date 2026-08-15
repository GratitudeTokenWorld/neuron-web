import { describe, it, expect } from 'vitest';
import { planShareRefresh, type ShareStatus } from './recovery-share.js';

/**
 * The refresh decision is the dangerous half of redundancy repair: a careless
 * re-split OVERWRITES good custodians with a smaller set, turning a transient
 * relay outage into permanently reduced durability. These pin the two rules
 * that prevent that (expand-only; count only current-generation holders).
 */
const s = (base: string, has: boolean, x: number | null = null, ts = 0): ShareStatus => ({ base, has, x, ts });

describe('planShareRefresh', () => {
  it('refreshes when a relay returned and holds no share (the 2-of-2 gap)', () => {
    // Exactly the dev case: account created while relay-2 was down.
    const plan = planShareRefresh([
      s('', true, 1, 100), s('http://a', true, 2, 100), s('http://b', false),
    ]);
    expect(plan.shouldRefresh).toBe(true);
    expect(plan.holders).toHaveLength(2);
  });

  it('does nothing when every reachable relay already holds a current share', () => {
    const plan = planShareRefresh([
      s('', true, 1, 100), s('http://a', true, 2, 100), s('http://b', true, 3, 100),
    ]);
    expect(plan.shouldRefresh).toBe(false);
    expect(plan.reason).toContain('already spread');
  });

  it('NEVER shrinks: a relay missing from the probe cannot trigger a re-split', () => {
    // Only two relays answered, and both hold shares. A third may exist and be
    // temporarily unreachable — re-splitting across just these two could strip
    // it, so the plan must decline.
    const plan = planShareRefresh([s('', true, 1, 100), s('http://a', true, 2, 100)]);
    expect(plan.shouldRefresh).toBe(false);
  });

  it('counts only CURRENT-generation holders — a stale share is not a custodian', () => {
    // http://b kept an older split (ts=50). Its share cannot combine with the
    // ts=100 pair, so it must count as a non-holder and trigger the repair.
    const plan = planShareRefresh([
      s('', true, 1, 100), s('http://a', true, 2, 100), s('http://b', true, 2, 50),
    ]);
    expect(plan.shouldRefresh).toBe(true);
    expect(plan.holders).toEqual(['', 'http://a']);
  });

  it('refuses when fewer than 2 relays are reachable (k=2 unmaintainable)', () => {
    expect(planShareRefresh([s('', true, 1, 100)]).shouldRefresh).toBe(false);
    expect(planShareRefresh([]).shouldRefresh).toBe(false);
    expect(planShareRefresh([s('', false)]).shouldRefresh).toBe(false);
  });

  it('repairs an account with no shares at all across 3 reachable relays', () => {
    const plan = planShareRefresh([s('', false), s('http://a', false), s('http://b', false)]);
    expect(plan.shouldRefresh).toBe(true);
    expect(plan.holders).toHaveLength(0);
  });
});
