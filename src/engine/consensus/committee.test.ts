import { describe, it, expect } from 'vitest';
import { ValidatorRegistry } from './validators.js';
import { selectCommittee } from './committee.js';
import { STAKE_CAP } from './weight.js';

function registryWith(n: number): ValidatorRegistry {
  const r = new ValidatorRegistry();
  for (let i = 0; i < n; i++) {
    r.bond('v' + i, STAKE_CAP);
    r.creditActivity('v' + i, 52);
  }
  return r;
}

describe('committee sortition', () => {
  it('is deterministic for a seed and reshuffles across seeds', () => {
    const r = registryWith(100);
    const opts = { committeeSize: 20, minCommitteeSize: 10 };
    const a = selectCommittee(r, 3, 1, 'seedA', opts);
    const aAgain = selectCommittee(r, 3, 1, 'seedA', opts);
    const b = selectCommittee(r, 3, 1, 'seedB', opts);
    expect(a.members).toEqual(aAgain.members);
    expect(a.members).not.toEqual(b.members);
    expect(a.members.length).toBe(20);
    expect(a.safe).toBe(true);
  });

  it('flags unsafe when there are too few validators', () => {
    const r = registryWith(5);
    const c = selectCommittee(r, 0, 0, 's', { committeeSize: 20, minCommitteeSize: 10 });
    expect(c.safe).toBe(false);
    expect(c.reason).toMatch(/too few/);
  });

  it('enforces an aggregate-seniority floor', () => {
    const r = new ValidatorRegistry();
    for (let i = 0; i < 30; i++) r.bond('v' + i, 1n); // tiny bond, no activity → low weight
    const c = selectCommittee(r, 0, 0, 's', { committeeSize: 20, minCommitteeSize: 10, minAggregateWeight: 1000 });
    expect(c.safe).toBe(false);
    expect(c.reason).toMatch(/seniority/);
  });

  it('random sampling resists single-shard takeover by a sub-majority attacker', () => {
    // 100 validators; attacker controls 40 (40% globally). Over many randomly-seeded
    // committees, the attacker should almost never hold a majority of a committee —
    // taking one shard requires ≈ a GLOBAL majority, not a cheap local one.
    const r = registryWith(100);
    const attacker = new Set<string>();
    for (let i = 0; i < 40; i++) attacker.add('v' + i);

    const opts = { committeeSize: 51, minCommitteeSize: 21 };
    let attackerMajorities = 0;
    const trials = 300;
    for (let t = 0; t < trials; t++) {
      const c = selectCommittee(r, t % 4096, 1, 'beacon-' + t, opts);
      const controlled = c.members.filter((m) => attacker.has(m)).length;
      if (controlled > c.members.length / 2) attackerMajorities++;
    }
    expect(attackerMajorities / trials).toBeLessThan(0.05);
  });
});
