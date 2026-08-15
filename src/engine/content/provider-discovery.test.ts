import { describe, it, expect } from 'vitest';

import { foldProviderBlocks, selectDiscoveryBlocks } from './provider-discovery.js';
import { ProviderLedger, GB_BYTES, MAX_OFFLINE_MS } from './provider-ledger.js';
import { createBlock, GENESIS_PREV, type Block, type StoragePayload } from '../core/block.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { generateKeyPair } from '../core/keys.js';

/**
 * Provider discovery: learning about providers you do not hold the chain of.
 *
 * The security claim is narrow and worth pinning exactly — a relay serves the
 * PROVIDER's own signed blocks, so it can choose what to show but cannot invent,
 * inflate, or forge. These tests are mostly about what the fold REFUSES.
 */

/** A signed storage block on a throwaway chain, so signatures are real. */
function signed(
  keys: { pub: string; priv: string },
  type: Block['type'],
  index: number,
  timestamp: number,
  storage: StoragePayload,
): Block {
  const acc = new AccountAccumulator();
  for (let i = 0; i < index; i++) acc.append(`${i}`.padStart(64, '0'));
  return createBlock(
    {
      accountId: keys.pub, index, type, previousHash: GENESIS_PREV, shard: 1,
      timestamp, balance: 0n, storage,
    },
    keys.priv,
    acc,
  );
}

const DAY = 100 * 24 * 60 * 60 * 1000;

describe('foldProviderBlocks', () => {
  it('learns capacity, address and liveness from a provider it has never met', () => {
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 50, deviceId: 'dev-x' });
    const hb = signed(p, 'storage-heartbeat', 2, DAY + 1000, {
      smokeAddr: 'x.example', storedBytes: 5 * GB_BYTES, countryCode: 'RO',
    });
    const [rec] = foldProviderBlocks([reg, hb]);
    expect(rec!.pub).toBe(p.pub);
    expect(rec!.capacityGB).toBe(50);
    expect(rec!.smokeAddr).toBe('x.example');
    expect(rec!.countryCode).toBe('RO');
    expect(rec!.lastActualStoredBytes).toBe(5 * GB_BYTES);
    expect(rec!.lastHeartbeat).toBe(DAY + 1000);
    expect(rec!.discovered).toBe(true);
  });

  it('refuses a block whose signature does not hold', () => {
    // The whole trust argument: a relay cannot invent a provider or inflate a
    // capacity, because the client checks the provider's own signature.
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 50 });
    const tampered = { ...reg, storage: { capacityGB: 500_000 } } as Block;
    expect(foldProviderBlocks([tampered])).toEqual([]);
    // ...and a forged signer is likewise rejected.
    const impostor = { ...reg, accountId: generateKeyPair().pub } as Block;
    expect(foldProviderBlocks([impostor])).toEqual([]);
  });

  it('ignores non-storage blocks entirely', () => {
    const p = generateKeyPair();
    const send = signed(p, 'send', 1, DAY, {});
    expect(foldProviderBlocks([send])).toEqual([]);
  });

  it('drops a provider whose latest registration is a deregistration', () => {
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 50 });
    // A deregister is a different block type, so the newest REGISTER still
    // stands — a relay serving only the register would keep it visible. Guard
    // the malformed/zero case too.
    const zero = signed(p, 'storage-register', 3, DAY + 2000, { capacityGB: 0 });
    expect(foldProviderBlocks([reg, zero])).toEqual([]);
  });

  it('takes the newest record by chain INDEX, not by self-reported timestamp', () => {
    // Timestamps are self-reported and could be backdated; index is monotonic
    // within a signed chain.
    const p = generateKeyPair();
    const older = signed(p, 'storage-register', 1, DAY + 9_000_000, { capacityGB: 10 });
    const newer = signed(p, 'storage-register', 4, DAY, { capacityGB: 99 });
    const [rec] = foldProviderBlocks([older, newer]);
    expect(rec!.capacityGB).toBe(99);
  });

  it('will not count a heartbeat from a previous registration as liveness', () => {
    // Re-registering ends the old lease. Crediting the earlier heartbeat would
    // let a provider look live on the strength of a previous life.
    const p = generateKeyPair();
    const oldHb = signed(p, 'storage-heartbeat', 1, DAY, { smokeAddr: 'stale.example' });
    const reg = signed(p, 'storage-register', 2, DAY + 1000, { capacityGB: 10 });
    const [rec] = foldProviderBlocks([oldHb, reg]);
    expect(rec!.lastHeartbeat).toBe(0);
    expect(rec!.smokeAddr).toBeUndefined();
  });

  it('survives a batch containing junk', () => {
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 7 });
    const junk = { type: 'storage-register', accountId: 'nope', index: 0 } as unknown as Block;
    expect(foldProviderBlocks([junk, reg])).toHaveLength(1);
  });
});

describe('discovered providers in the ledger', () => {
  it('widens the selection pool without becoming authoritative', () => {
    const pl = new ProviderLedger();
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 10 });
    const hb = signed(p, 'storage-heartbeat', 2, DAY, { storedBytes: 0 });
    pl.setDiscovered(foldProviderBlocks([reg, hb]));

    expect(pl.allProviders().map(x => x.pub)).toEqual([p.pub]);
    expect(pl.isLive(p.pub, DAY + 1000)).toBe(true);
    expect(pl.freeBytes(p.pub)).toBe(10 * GB_BYTES);
    // Known, but not a chain we hold — so it can never feed reward validation.
    expect(pl.isAuthoritative(p.pub)).toBe(false);
    expect(pl.rewardTerms(p.pub, 100)).toMatch(/not a registered/);
  });

  it('lets a discovered lease expire like any other', () => {
    const pl = new ProviderLedger();
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 10 });
    const hb = signed(p, 'storage-heartbeat', 2, DAY, {});
    pl.setDiscovered(foldProviderBlocks([reg, hb]));
    expect(pl.isLive(p.pub, DAY + MAX_OFFLINE_MS - 1)).toBe(true);
    expect(pl.isLive(p.pub, DAY + MAX_OFFLINE_MS)).toBe(false);
  });

  it('replaces the discovered set so a departed provider disappears', () => {
    const pl = new ProviderLedger();
    const p = generateKeyPair();
    pl.setDiscovered(foldProviderBlocks([signed(p, 'storage-register', 1, DAY, { capacityGB: 10 })]));
    expect(pl.allProviders()).toHaveLength(1);
    pl.setDiscovered([]);          // next poll no longer lists it
    expect(pl.allProviders()).toHaveLength(0);
  });

  it('prefers the chain we hold over anything discovery says', () => {
    const pl = new ProviderLedger();
    const p = generateKeyPair();
    // Authoritative: 10GB, applied from a block we hold.
    pl.apply(signed(p, 'storage-register', 1, DAY, { capacityGB: 10 }), DAY);
    // Discovery claims 999GB for the same account.
    pl.setDiscovered(foldProviderBlocks([signed(p, 'storage-register', 2, DAY, { capacityGB: 999 })]));
    expect(pl.allProviders()).toHaveLength(1);
    expect(pl.get(p.pub)!.capacityGB).toBe(10);
  });
});

describe('selectDiscoveryBlocks (what an archive serves)', () => {
  it('serves the newest register + heartbeat per provider', () => {
    const a = generateKeyPair();
    const blocks = [
      signed(a, 'storage-register', 1, DAY, { capacityGB: 5 }),
      signed(a, 'storage-heartbeat', 2, DAY + 10, {}),
      signed(a, 'storage-heartbeat', 3, DAY + 20, {}),
    ];
    const out = selectDiscoveryBlocks(blocks, 10);
    expect(out).toHaveLength(2);
    expect(out.map(b => b.index).sort()).toEqual([1, 3]);
  });

  it('bounds the answer — an unbounded reply is the firehose again', () => {
    const blocks: Block[] = [];
    for (let i = 0; i < 30; i++) {
      blocks.push(signed(generateKeyPair(), 'storage-register', 1, DAY + i, { capacityGB: 5 }));
    }
    expect(selectDiscoveryBlocks(blocks, 5)).toHaveLength(5);   // 5 providers, no heartbeats
    expect(selectDiscoveryBlocks(blocks, 0)).toHaveLength(0);
  });

  it('omits providers that have declared zero capacity', () => {
    const a = generateKeyPair();
    expect(selectDiscoveryBlocks([signed(a, 'storage-register', 1, DAY, { capacityGB: 0 })], 10)).toEqual([]);
  });
});
