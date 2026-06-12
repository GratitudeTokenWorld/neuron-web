import { describe, it, expect } from 'vitest';
import { ValidatorRegistry } from './validators.js';
import { ConflictResolver } from './vote.js';
import { applyEquivocationSlashes } from './slashing.js';
import { STAKE_CAP } from './weight.js';

describe('slashing', () => {
  it('slashes an equivocating validator, burning its bond and zeroing its weight', () => {
    const reg = new ValidatorRegistry();
    reg.bond('v1', STAKE_CAP);
    reg.creditActivity('v1', 52);
    const w = reg.weightOf('v1');

    const r = new ConflictResolver();
    r.register('hA', 'acct', 'prev');
    r.register('hB', 'acct', 'prev');
    r.vote({ blockHash: 'hA', voterId: 'v1', weight: w });
    r.vote({ blockHash: 'hB', voterId: 'v1', weight: w }); // equivocation

    const records = applyEquivocationSlashes(reg, r.equivocations());
    expect(records).toHaveLength(1);
    expect(records[0]!.burned).toBe(STAKE_CAP);
    expect(reg.isValidator('v1')).toBe(false);
    expect(reg.weightOf('v1')).toBe(0);
  });

  it('slashes each distinct equivocator only once', () => {
    const reg = new ValidatorRegistry();
    reg.bond('v1', STAKE_CAP);
    const equivocations = [
      { voterId: 'v1', groupKey: 'a:b', blockA: 'x', blockB: 'y' },
      { voterId: 'v1', groupKey: 'c:d', blockA: 'm', blockB: 'n' },
    ];
    const records = applyEquivocationSlashes(reg, equivocations);
    expect(records).toHaveLength(1);
  });
});
