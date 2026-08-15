import { describe, it, expect } from 'vitest';

import {
  ProviderLedger, claimableEpochDay, MAX_OFFLINE_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_GRACE_MS,
  REWARD_EPOCH_MS, MAX_HEARTBEATS_PER_DAY, MAX_HEARTBEATS_PER_DAY_HARD,
  BASE_STORAGE_RATE_MILLI, GB_BYTES,
} from './provider-ledger.js';
import type { Block, StoragePayload } from '../core/block.js';

/**
 * The storage custody rules, tested at the layer that owns them.
 *
 * Every rule here is one the reward arithmetic or the lease model depends on, and
 * each is stated in a comment somewhere in provider-ledger.ts — which is exactly
 * why it also needs a test. (The share-refresh ordering rule was described
 * correctly in a comment, shipped without a guard, and destroyed a live account's
 * redundancy within the hour.)
 */

const PUB = 'provider-1';

/**
 * A minimal block carrying only what ProviderLedger reads. The hash/signature
 * layer is EngineLedger's job — see storage-ledger.test.ts for the signed path.
 */
function blk(type: Block['type'], timestamp: number, storage?: StoragePayload, amount?: bigint): Block {
  return { accountId: PUB, type, timestamp, storage, amount } as unknown as Block;
}

/** Day 100 at 00:00 — epoch boundaries are `floor(ts / REWARD_EPOCH_MS)`. */
const DAY = 100 * REWARD_EPOCH_MS;

function registered(capacityGB = 10, at = DAY - REWARD_EPOCH_MS): ProviderLedger {
  const pl = new ProviderLedger();
  pl.apply(blk('storage-register', at, { capacityGB, deviceId: 'dev-1' }), at);
  return pl;
}

describe('lease liveness', () => {
  it('treats registration as the start of the lease before any heartbeat', () => {
    const pl = registered(10, DAY);
    expect(pl.isLive(PUB, DAY + MAX_OFFLINE_MS - 1)).toBe(true);
    expect(pl.isLive(PUB, DAY + MAX_OFFLINE_MS)).toBe(false);
  });

  it('renews the lease on each counted heartbeat', () => {
    const pl = registered(10, DAY);
    const hb = DAY + HEARTBEAT_INTERVAL_MS;
    pl.apply(blk('storage-heartbeat', hb, {}), hb);
    // The lease now runs from the heartbeat, not from registration.
    expect(pl.isLive(PUB, DAY + MAX_OFFLINE_MS + 1)).toBe(true);
    expect(pl.leaseExpiresAt(PUB)).toBe(hb + MAX_OFFLINE_MS);
  });

  it('expires the lease when renewals stop — declared capacity does not keep content alive', () => {
    const pl = registered(10, DAY);
    const hb = DAY + HEARTBEAT_INTERVAL_MS;
    pl.apply(blk('storage-heartbeat', hb, {}), hb);
    const gone = hb + MAX_OFFLINE_MS;
    expect(pl.isLive(PUB, gone)).toBe(false);
    expect(pl.liveProviders(gone)).toHaveLength(0);
    // ...but the provider is still *registered*: the lease lapsed, the declaration
    // did not. Only custody decisions may use the lease.
    expect(pl.allProviders()).toHaveLength(1);
  });

  it('holds no lease at all once deregistered', () => {
    const pl = registered(10, DAY);
    pl.apply(blk('storage-deregister', DAY + 1_000, {}), DAY + 1_000);
    expect(pl.isLive(PUB, DAY + 2_000)).toBe(false);
    expect(pl.leaseExpiresAt(PUB)).toBe(0);
    expect(pl.allProviders()).toHaveLength(0);
  });
});

describe('heartbeat counting', () => {
  it('counts a heartbeat that arrives at the interval, with grace for jitter', () => {
    const pl = registered(10, DAY);
    pl.apply(blk('storage-heartbeat', DAY, {}), DAY);           // first is always due
    const early = DAY + HEARTBEAT_INTERVAL_MS - HEARTBEAT_GRACE_MS;
    expect(pl.countsAsRenewal(PUB, early)).toBe(true);          // inside the grace window
    expect(pl.countsAsRenewal(PUB, early - 1)).toBe(false);
  });

  it('accepts an early heartbeat but does not count it — the chain must never truncate', () => {
    const pl = registered(10, DAY);
    pl.apply(blk('storage-heartbeat', DAY, { storedBytes: 5 * GB_BYTES }), DAY);
    // A flood of early heartbeats: applied without error (rejecting mid-chain
    // would strand every later block as non-sequential), but worth no uptime.
    for (let i = 1; i <= 20; i++) {
      const ts = DAY + i * 60_000;
      expect(pl.validate(blk('storage-heartbeat', ts, {}), ts)).toBeNull();
      pl.apply(blk('storage-heartbeat', ts, {}), ts);
    }
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(1);
    expect(pl.countHeartbeatsLast24h(PUB, DAY + REWARD_EPOCH_MS - 1)).toBe(1);
  });

  it('rejects a flood only once it is far past any honest rate', () => {
    const pl = registered(10, DAY);
    // 24 blocks in one epoch — 4× what a fully-online provider produces. Every
    // one before the ceiling applies (no honest chain is ever truncated); the
    // one that crosses it is refused.
    for (let i = 0; i < MAX_HEARTBEATS_PER_DAY_HARD; i++) {
      const ts = DAY + i * 60_000;
      expect(pl.validate(blk('storage-heartbeat', ts, {}), ts)).toBeNull();
      pl.apply(blk('storage-heartbeat', ts, {}), ts);
    }
    const over = DAY + MAX_HEARTBEATS_PER_DAY_HARD * 60_000;
    expect(pl.validate(blk('storage-heartbeat', over, {}), over)).toMatch(/more than 24 heartbeats/);
    // Still worth exactly one day's uptime credit: padding bought nothing.
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(1);
    expect(pl.submittedInEpoch(PUB, 100)).toBe(MAX_HEARTBEATS_PER_DAY_HARD);
    // The ceiling is per epoch, so the next day starts clean.
    const nextDay = DAY + REWARD_EPOCH_MS;
    expect(pl.validate(blk('storage-heartbeat', nextDay, {}), nextDay)).toBeNull();
  });

  it('still takes address/usage reports from an uncounted heartbeat', () => {
    const pl = registered(10, DAY);
    pl.apply(blk('storage-heartbeat', DAY, { smokeAddr: 'a.example' }), DAY);
    pl.apply(blk('storage-heartbeat', DAY + 60_000, { smokeAddr: 'b.example', storedBytes: 3 * GB_BYTES }), DAY + 60_000);
    const p = pl.providers.get(PUB)!;
    expect(p.smokeAddr).toBe('b.example');            // routing data is a report, not earnings
    expect(p.lastActualStoredBytes).toBe(3 * GB_BYTES);
    expect(p.lastHeartbeat).toBe(DAY);                // ...but the lease clock did not move
  });

  it('rejects a future-dated heartbeat, accepts an old one (replay from disk)', () => {
    const pl = registered(10, DAY);
    const now = DAY + HEARTBEAT_INTERVAL_MS;
    expect(pl.validate(blk('storage-heartbeat', now + 11 * 60_000, {}), now)).toMatch(/future/);
    expect(pl.validate(blk('storage-heartbeat', DAY - REWARD_EPOCH_MS, {}), now)).toBeNull();
  });
});

describe('deregistering does not launder the account history', () => {
  /** register → heartbeat → deregister → register → … as fast as blocks allow. */
  function churn(pl: ProviderLedger, from: number, cycles: number, capacityGB = 1000): void {
    for (let i = 0; i < cycles; i++) {
      const t = from + i * 10_000;
      pl.apply(blk('storage-heartbeat', t, { storedBytes: capacityGB * GB_BYTES }), t);
      pl.apply(blk('storage-deregister', t + 1_000, {}), t + 1_000);
      pl.apply(blk('storage-register', t + 2_000, { capacityGB }), t + 2_000);
    }
  }

  it('cannot bank a full day of uptime in a minute by churning registrations', () => {
    // The attack (found by Lucian, 2026-08-15): the heartbeat interval clock
    // lived on the live profile, and `storage-deregister` deletes that profile —
    // so every re-register reset it to 0, which `countsAsRenewal` reads as
    // "first heartbeat, always due". Measured before the fix: 6/6 counted
    // heartbeats in 60 seconds, paying exactly what an honest 24h day pays.
    const pl = registered(1000, DAY - REWARD_EPOCH_MS);
    churn(pl, DAY, MAX_HEARTBEATS_PER_DAY);

    // Only the FIRST heartbeat of the day counts: the rest are inside the
    // interval, measured against a clock the attacker cannot destroy.
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(1);
    const terms = pl.rewardTerms(PUB, 100);
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.amount).toBe(Math.floor(BASE_STORAGE_RATE_MILLI * 1000 * (1 / MAX_HEARTBEATS_PER_DAY)));
    // ...which is a sixth of the full day it was trying to claim.
    expect(terms.amount).toBeLessThan(BASE_STORAGE_RATE_MILLI * 1000);
  });

  it('still pays an honest provider that churns between real heartbeats', () => {
    // Churning is not itself an offence — a provider may legitimately leave and
    // rejoin. It just buys no uptime that the clock did not already allow.
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    for (let i = 0; i < MAX_HEARTBEATS_PER_DAY; i++) {
      churn(pl, DAY + i * HEARTBEAT_INTERVAL_MS, 1, 10);
    }
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(MAX_HEARTBEATS_PER_DAY);
  });

  it('does not refresh the lease grace by re-registering', () => {
    // registeredAt is durable too: otherwise an account could look live forever
    // by re-registering, without ever proving possession.
    const pl = registered(10, DAY);
    pl.apply(blk('storage-deregister', DAY + 1_000, {}), DAY + 1_000);
    const backLater = DAY + MAX_OFFLINE_MS;
    pl.apply(blk('storage-register', backLater, { capacityGB: 10 }), backLater);
    // The original registration is what the grace runs from, so it has lapsed.
    expect(pl.providers.get(PUB)!.registeredAt).toBe(DAY);
    expect(pl.isLive(PUB, backLater)).toBe(false);
    // A real heartbeat revives it — that is the only thing that should.
    pl.apply(blk('storage-heartbeat', backLater, {}), backLater);
    expect(pl.isLive(PUB, backLater)).toBe(true);
  });
});

describe('reward terms', () => {
  /** A full day of heartbeats reporting `storedBytes`, on epoch `day`. */
  function fullDay(pl: ProviderLedger, day: number, storedBytes: number): void {
    for (let i = 0; i < MAX_HEARTBEATS_PER_DAY; i++) {
      const ts = day * REWARD_EPOCH_MS + i * HEARTBEAT_INTERVAL_MS;
      pl.apply(blk('storage-heartbeat', ts, { storedBytes }), ts);
    }
  }

  it('pays for bytes actually held, scaled by uptime', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    fullDay(pl, 100, 4 * GB_BYTES);
    const terms = pl.rewardTerms(PUB, 100);
    expect(typeof terms).not.toBe('string');
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.heartbeatCount).toBe(MAX_HEARTBEATS_PER_DAY);
    expect(terms.storedGB).toBe(4);
    expect(terms.amount).toBe(BASE_STORAGE_RATE_MILLI * 4);
  });

  it('caps payment at declared capacity — over-reporting bytes earns nothing extra', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    fullDay(pl, 100, 500 * GB_BYTES);   // claims to hold 50× what it offered
    const terms = pl.rewardTerms(PUB, 100);
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.storedGB).toBe(10);
    expect(terms.amount).toBe(BASE_STORAGE_RATE_MILLI * 10);
  });

  it('scales down a partial day of uptime', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    for (let i = 0; i < 2; i++) {
      const ts = DAY + i * HEARTBEAT_INTERVAL_MS;
      pl.apply(blk('storage-heartbeat', ts, { storedBytes: 6 * GB_BYTES }), ts);
    }
    const terms = pl.rewardTerms(PUB, 100);
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.amount).toBe(Math.floor(BASE_STORAGE_RATE_MILLI * 6 * (2 / MAX_HEARTBEATS_PER_DAY)));
  });

  it('prices capacity as it stood at epoch START — a last-minute bump pays nothing', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    fullDay(pl, 100, 900 * GB_BYTES);
    // Bump the declaration to 900GB near the end of the day being claimed.
    const late = DAY + REWARD_EPOCH_MS - 60_000;
    pl.apply(blk('storage-register', late, { capacityGB: 900 }), late);
    const terms = pl.rewardTerms(PUB, 100);
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.storedGB).toBe(10);   // priced at the 10GB that was declared all day
  });

  it('owes nothing for an epoch with no heartbeats, or one already claimed', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    expect(pl.rewardTerms(PUB, 100)).toMatch(/no heartbeats/);
    fullDay(pl, 100, GB_BYTES);
    const terms = pl.rewardTerms(PUB, 100);
    if (typeof terms === 'string') throw new Error(terms);
    pl.apply(blk('storage-reward', DAY + REWARD_EPOCH_MS, { epochDay: 100 }, BigInt(terms.amount)), DAY + REWARD_EPOCH_MS);
    expect(pl.rewardTerms(PUB, 100)).toMatch(/already rewarded/);
  });

  it('settles a day behind, so polling for eligibility cannot lock in a partial day', () => {
    const pl = registered(10, DAY - 2 * REWARD_EPOCH_MS);   // declared since day 98
    // Mid-morning on day 100, one heartbeat in. A claim for the RUNNING day would
    // price at 1/6 uptime and close the epoch for good — the rest of the day's
    // work would earn nothing. Only the completed day 99 is claimable, and the
    // provider was offline for it.
    const morning = DAY + HEARTBEAT_INTERVAL_MS;
    pl.apply(blk('storage-heartbeat', DAY, { storedBytes: 6 * GB_BYTES }), DAY);
    expect(claimableEpochDay(morning)).toBe(99);
    expect(pl.rewardTerms(PUB, claimableEpochDay(morning))).toMatch(/no heartbeats/);

    // The rest of day 100 runs; the next day it is complete and prices on all of it.
    for (let i = 1; i < MAX_HEARTBEATS_PER_DAY; i++) {
      const ts = DAY + i * HEARTBEAT_INTERVAL_MS;
      pl.apply(blk('storage-heartbeat', ts, { storedBytes: 6 * GB_BYTES }), ts);
    }
    const terms = pl.rewardTerms(PUB, claimableEpochDay(DAY + REWARD_EPOCH_MS));
    if (typeof terms === 'string') throw new Error(terms);
    expect(terms.epochDay).toBe(100);
    expect(terms.amount).toBe(BASE_STORAGE_RATE_MILLI * 6);   // full day, not 1/6
  });

  it('owes nothing for a day the provider was not registered', () => {
    const pl = registered(10, DAY);            // registered ON day 100, not before
    const ts = DAY + HEARTBEAT_INTERVAL_MS;
    pl.apply(blk('storage-heartbeat', ts, { storedBytes: GB_BYTES }), ts);
    expect(pl.rewardTerms(PUB, 100)).toMatch(/not registered at epoch start/);
  });

  it('does not pay across a gap: leave, come back, and the away days are worth 0', () => {
    const pl = registered(10, DAY - 10 * REWARD_EPOCH_MS);
    // Leave on day 98, re-register on day 100 — day 99 must price at 0 capacity.
    pl.apply(blk('storage-deregister', 98 * REWARD_EPOCH_MS, {}), 98 * REWARD_EPOCH_MS);
    pl.apply(blk('storage-register', DAY, { capacityGB: 10 }), DAY);
    expect(pl.capacityAtEpochStart(PUB, 99)).toBe(0);
    expect(pl.capacityAtEpochStart(PUB, 101)).toBe(10);
  });
});

describe('reward validation', () => {
  function earned(pl: ProviderLedger, day: number): number {
    for (let i = 0; i < MAX_HEARTBEATS_PER_DAY; i++) {
      const ts = day * REWARD_EPOCH_MS + i * HEARTBEAT_INTERVAL_MS;
      pl.apply(blk('storage-heartbeat', ts, { storedBytes: 8 * GB_BYTES }), ts);
    }
    const terms = pl.rewardTerms(PUB, day);
    if (typeof terms === 'string') throw new Error(terms);
    return terms.amount;
  }

  it('rejects a reward claiming more than the on-chain evidence supports', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    const max = earned(pl, 100);
    const ts = DAY + REWARD_EPOCH_MS;
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 100 }, BigInt(max)), ts)).toBeNull();
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 100 }, BigInt(max + 1)), ts)).toMatch(/exceeds maximum/);
  });

  it('rejects a reward whose declared storedGB overstates what was reported', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    const max = earned(pl, 100);
    const ts = DAY + REWARD_EPOCH_MS;
    const err = pl.validate(blk('storage-reward', ts, { epochDay: 100, storedGB: 10 }, BigInt(max)), ts);
    expect(err).toMatch(/storedGB/);
  });

  it('may only bill the day before the block that carries it', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    const max = earned(pl, 100);
    const ts = DAY + REWARD_EPOCH_MS;                 // a block dated day 101
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 100 }, BigInt(max)), ts)).toBeNull();
    // Billing the running day, or any other day, is malformed — decidable from
    // the block alone, so every node rejects it identically.
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 101 }, BigInt(max)), ts)).toMatch(/may only claim epoch 100/);
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 99 }, BigInt(max)), ts)).toMatch(/may only claim epoch 100/);
  });

  it('closes the stale-claim hole: an old day is refused by the rule, not by pruning', () => {
    // Before this rule, a genuinely-earned day stayed claimable until its
    // evidence aged out of retention, and only THEN became unverifiable — so the
    // same block was valid on a node that held the history and rejected by one
    // that had pruned it. Rejection mid-chain strands every later block.
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    const max = earned(pl, 100);
    const muchLater = DAY + 60 * REWARD_EPOCH_MS;
    const err = pl.validate(blk('storage-reward', muchLater, { epochDay: 100 }, BigInt(max)), muchLater);
    expect(err).toMatch(/may only claim epoch 159/);
    // The refusal does not depend on whether the evidence is still retained: it
    // is a property of the block, so it is the same answer on every node forever.
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(MAX_HEARTBEATS_PER_DAY);
  });

  it('rejects a non-positive or malformed reward', () => {
    const pl = registered(10, DAY - REWARD_EPOCH_MS);
    earned(pl, 100);
    const ts = DAY + REWARD_EPOCH_MS;
    expect(pl.validate(blk('storage-reward', ts, { epochDay: 100 }, 0n), ts)).toMatch(/positive/);
    expect(pl.validate(blk('storage-reward', ts, {}, 1n), ts)).toMatch(/epochDay/);
  });

  it('rejects storage blocks from an account that never registered', () => {
    const pl = new ProviderLedger();
    expect(pl.validate(blk('storage-heartbeat', DAY, {}), DAY)).toMatch(/not a registered/);
    expect(pl.validate(blk('storage-deregister', DAY, {}), DAY)).toMatch(/not a registered/);
    expect(pl.validate(blk('storage-register', DAY, { capacityGB: 0 }), DAY)).toMatch(/positive/);
  });
});

describe('score and free space', () => {
  it('meters the earning rate on bytes held, not capacity declared', () => {
    const pl = registered(100, DAY - REWARD_EPOCH_MS);
    for (let i = 0; i < MAX_HEARTBEATS_PER_DAY; i++) {
      const ts = DAY + i * HEARTBEAT_INTERVAL_MS;
      pl.apply(blk('storage-heartbeat', ts, { storedBytes: 2 * GB_BYTES }), ts);
    }
    pl.refresh(DAY + REWARD_EPOCH_MS - 1);
    const p = pl.providers.get(PUB)!;
    expect(p.score).toBe(1);                                        // full uptime, no latency data
    expect(p.earningRate).toBe(BASE_STORAGE_RATE_MILLI * 2);        // 2GB held, not 100 declared
    expect(pl.freeBytes(PUB)).toBe(100 * GB_BYTES - 2 * GB_BYTES);
  });

  it('never zeroes a provider out on one bad signal', () => {
    const pl = registered(10, DAY);
    const p = pl.providers.get(PUB)!;
    p.spotCheckPassRate = 0;
    p.avgLatencyMs = 100_000;
    pl.updateScore(p);
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThan(0.01);   // 0.1 uptime × 0.1 latency × 0.1 spot
  });
});

describe('epoch retention', () => {
  it('prunes per provider against that provider\'s own newest epoch', () => {
    // A global high-water mark would be dragged forward by the first account
    // replayed, so the next account's older heartbeats would land in pruned
    // epochs and its reward blocks would fail — truncating a valid chain.
    const pl = new ProviderLedger();
    const other = 'provider-2';
    const reg = (pub: string, ts: number) =>
      pl.apply({ accountId: pub, type: 'storage-register', timestamp: ts, storage: { capacityGB: 5 } } as unknown as Block, ts);
    const beat = (pub: string, ts: number) =>
      pl.apply({ accountId: pub, type: 'storage-heartbeat', timestamp: ts, storage: {} } as unknown as Block, ts);

    // Provider 1 replays a long history, ending on day 200.
    reg(PUB, 0);
    for (let d = 0; d <= 200; d++) beat(PUB, d * REWARD_EPOCH_MS);
    expect(pl.heartbeatsInEpoch(PUB, 200)).toBe(1);
    expect(pl.heartbeatsInEpoch(PUB, 100)).toBe(0);   // long past its own window

    // Provider 2 then replays ITS history, which stops on day 40 — 160 days
    // behind provider 1, and long enough to engage pruning on its own.
    reg(other, 0);
    for (let d = 0; d <= 40; d++) beat(other, d * REWARD_EPOCH_MS);
    // Under a global high-water mark (day 200) every one of these would be gone.
    // Under per-provider pruning, provider 2 keeps its own last 32 epochs.
    expect(pl.heartbeatsInEpoch(other, 40)).toBe(1);
    expect(pl.heartbeatsInEpoch(other, 10)).toBe(1);
    expect(pl.heartbeatsInEpoch(other, 0)).toBe(0);   // past provider 2's own window
  });
});
