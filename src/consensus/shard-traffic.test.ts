import { describe, it, expect } from 'vitest';
import { ValidatorRegistry } from './validators.js';
import { selectCommittee } from './committee.js';
import { ConflictResolver } from './vote.js';
import { STAKE_CAP } from './weight.js';

/**
 * Invariant #4 (measured): conflict resolution is shard-confined. A fork only ever
 * involves its shard's committee, so the participating vote count is the committee
 * size — independent of the total validator count N. (A global broadcast model
 * would involve all N validators per fork.)
 */
describe('conflict resolution is shard-confined', () => {
  it('participating voters equal the committee size, independent of N', () => {
    const committeeSize = 15;
    for (const N of [50, 200, 800]) {
      const reg = new ValidatorRegistry();
      for (let i = 0; i < N; i++) {
        reg.bond('v' + i, STAKE_CAP);
        reg.creditActivity('v' + i, 52);
      }
      const committee = selectCommittee(reg, 3, 1, 'epoch-seed', { committeeSize, minCommitteeSize: 10 });
      expect(committee.safe).toBe(true);

      const resolver = new ConflictResolver();
      resolver.register('hA', 'acct', 'prev');
      resolver.register('hB', 'acct', 'prev');

      let participating = 0;
      for (const m of committee.members) {
        if (resolver.vote({ blockHash: 'hA', voterId: m, weight: reg.weightOf(m) }).counted) participating++;
      }
      expect(participating).toBe(committeeSize); // not N
    }
  });
});
