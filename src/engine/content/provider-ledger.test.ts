import { describe, it, expect, afterEach } from 'vitest';

import {
  ProviderLedger, claimableEpochDay, MAX_OFFLINE_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_GRACE_MS,
  REWARD_EPOCH_MS, MAX_HEARTBEATS_PER_EPOCH, MAX_HEARTBEATS_PER_EPOCH_HARD, GB_BYTES, applyStorageTiming, storageTiming,
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

  it('renews the lease on OBSERVED SERVICE, not on an announcement', () => {
    // Changed 2026-09-22: the lease used to renew when the provider said it was
    // there. It now renews when the network watched it serve bytes that hashed
    // correctly — evidence it cannot produce without holding them.
    const pl = registered(10, DAY);
    const served = DAY + HEARTBEAT_INTERVAL_MS;
    pl.liveness.record(PUB, true, served);
    expect(pl.isLive(PUB, DAY + MAX_OFFLINE_MS + 1)).toBe(true);
    expect(pl.isLive(PUB, served + MAX_OFFLINE_MS + 1)).toBe(false);
  });

  it('does not renew on anything the provider announces about itself', () => {
    // The heartbeat block is gone entirely (2026-09-22); what remains is an
    // off-chain presence beacon that carries a routing address and renews
    // nothing. A provider that only announces, and is never observed serving,
    // stops counting when the joining grace expires.
    const pl = registered(10, DAY);
    expect(pl.isLive(PUB, DAY + MAX_OFFLINE_MS + 1)).toBe(false);
  });

  it('expires the lease when service stops — declared capacity does not keep content alive', () => {
    const pl = registered(10, DAY);
    const hb = DAY + HEARTBEAT_INTERVAL_MS;
    pl.liveness.record(PUB, true, hb);
    const gone = hb + MAX_OFFLINE_MS + 1;
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

describe('score and free space', () => {
  it('counts free space against bytes HELD, not capacity declared', () => {
    const pl = registered(100, DAY - REWARD_EPOCH_MS);
    // Bytes held now arrive in an off-chain presence beacon rather than a
    // heartbeat block (`content/presence.ts`), so the ledger record is set
    // directly here — the chain no longer carries this at all.
    pl.providers.get(PUB)!.lastActualStoredBytes = 2 * GB_BYTES;
    expect(pl.freeBytes(PUB)).toBe(100 * GB_BYTES - 2 * GB_BYTES);
  });

  it('never zeroes a provider out on one bad signal', () => {
    const pl = registered(10, DAY);
    const p = pl.providers.get(PUB)!;
    p.spotCheckPassRate = 0;
    p.avgLatencyMs = 100_000;
    pl.updateScore(p);
    expect(p.score).toBeGreaterThan(0);
    expect(p.score).toBeLessThan(0.02);   // 0.1 latency x 0.1 spot; uptime is gone
  });
});

