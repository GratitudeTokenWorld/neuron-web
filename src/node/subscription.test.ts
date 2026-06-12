import { describe, it, expect } from 'vitest';
import { Subscription } from './subscription.js';
import { getShard } from '../core/partition.js';

describe('Subscription', () => {
  it('light client wants own + followed accounts only', () => {
    const sub = new Subscription(16).own('acct-own').follow('acct-followed');
    expect(sub.wants('acct-own')).toBe(true);
    expect(sub.wants('acct-followed')).toBe(true);
    expect(sub.wants('acct-stranger')).toBe(false);
    expect(sub.interestSize()).toBe(2);
  });

  it('does not wholesale-subscribe to its own shard', () => {
    const sub = new Subscription(16).own('acct-own');
    // a stranger that happens to share acct-own's shard must NOT be wanted
    const ownShard = getShard('acct-own', 16);
    let coResident: string | undefined;
    for (let i = 0; i < 1000 && !coResident; i++) {
      const id = 'stranger-' + i;
      if (getShard(id, 16) === ownShard) coResident = id;
    }
    expect(coResident).toBeDefined();
    expect(sub.wants(coResident!)).toBe(false);
  });

  it('super-node holds every account in a subscribed shard', () => {
    const shard = 7;
    const sub = new Subscription(16).subscribeShard(shard);
    let inShard: string | undefined;
    let outShard: string | undefined;
    for (let i = 0; i < 2000 && (!inShard || !outShard); i++) {
      const id = 'acct-' + i;
      if (getShard(id, 16) === shard) inShard ??= id;
      else outShard ??= id;
    }
    expect(sub.wants(inShard!)).toBe(true);
    expect(sub.wants(outShard!)).toBe(false);
  });
});
