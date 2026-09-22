import { describe, it, expect } from 'vitest';

import { foldProviderBlocks, selectDiscoveryBlocks, UNKNOWN_SCORE } from './provider-discovery.js';
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

describe('deregistration must reach every node', () => {
  const T0 = 1_000 * 24 * 60 * 60 * 1000;

  it('a departed provider is not served in the discovery page', () => {
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 1_000, {});
    const page = selectDiscoveryBlocks([reg, dr], 20, T0 + 2_000);
    expect(page.some(b => b.type === 'storage-register')).toBe(false);
  });

  it('but the departure ITSELF is served — a union of relays needs a tombstone', () => {
    // Omitting the provider is not enough. A client asks several relays and
    // takes the union, so one relay that missed the deregister and still serves
    // the register would resurrect it. One relay carrying the departure settles
    // it, because the fold compares chain indexes.
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 1_000, {});
    const page = selectDiscoveryBlocks([reg, dr], 20, T0 + 2_000);
    expect(page.filter(b => b.type === 'storage-deregister')).toHaveLength(1);
  });

  it('the fold drops a provider whose newest block is a departure', () => {
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 3, T0 + 200, {});
    expect(foldProviderBlocks([reg])).toHaveLength(1);       // still serving
    expect(foldProviderBlocks([reg, dr])).toHaveLength(0);   // gone
  });

  it('survives the union: one relay\'s stale register plus another\'s departure', () => {
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 1_000, {});
    // Deliberately reversed — arrival order must not decide this, chain index must.
    expect(foldProviderBlocks([dr, reg])).toHaveLength(0);
  });

  it('a provider that LEFT and came back is serving again', () => {
    const k = generateKeyPair();
    const reg1 = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 100, {});
    const reg2 = signed(k, 'storage-register', 3, T0 + 200, { capacityGB: 5, deviceId: 'd' });
    const folded = foldProviderBlocks([reg1, dr, reg2]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.capacityGB).toBe(5);       // the CURRENT declaration
  });

  it('stops serving an ancient departure — the lease has lapsed by every measure', () => {
    // Bounded like a file tombstone: past 2x MAX_OFFLINE the provider cannot be
    // selected for custody anyway, and its stale register has long since sunk
    // below the freshness ranking. Unbounded departures would grow forever.
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'd' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 1_000, {});
    const long = T0 + 1_000 + 2 * MAX_OFFLINE_MS + 1;
    expect(selectDiscoveryBlocks([reg, dr], 20, long)).toHaveLength(0);
  });

  it('a departure does not consume a slot from the provider limit', () => {
    const live = Array.from({ length: 3 }, (_, i) => {
      const k = generateKeyPair();
      return signed(k, 'storage-register', 1, T0 + i, { capacityGB: 10, deviceId: `d${i}` });
    });
    const k = generateKeyPair();
    const reg = signed(k, 'storage-register', 1, T0, { capacityGB: 10, deviceId: 'gone' });
    const dr = signed(k, 'storage-deregister', 2, T0 + 1_000, {});
    const page = selectDiscoveryBlocks([...live, reg, dr], 3, T0 + 2_000);
    expect(page.filter(b => b.type === 'storage-register')).toHaveLength(3);
    expect(page.filter(b => b.type === 'storage-deregister')).toHaveLength(1);
  });
});

describe('discovery after the heartbeat was removed (2026-09-22)', () => {
  it('learns capacity and identity from a register block alone', () => {
    // Discovery answers the DURABLE half — who registered, with how much — and
    // a caller merges presence over it for the address.
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 10, deviceId: 'dev-a' });
    const [found] = foldProviderBlocks([reg]);
    expect(found!.pub).toBe(p.pub);
    expect(found!.capacityGB).toBe(10);
    expect(found!.deviceId).toBe('dev-a');
    expect(found!.discovered).toBe(true);
  });

  it('reports routing details as UNKNOWN rather than guessing', () => {
    // These used to come from the latest heartbeat. With that gone, a relay has
    // nothing durable to say about them, and saying nothing is the honest
    // answer — the alternative is rendering the unmeasured as fact.
    const p = generateKeyPair();
    const [found] = foldProviderBlocks(
      [signed(p, 'storage-register', 1, DAY, { capacityGB: 10, deviceId: 'd' })]);
    expect(found!.smokeAddr).toBeUndefined();
    expect(found!.countryCode).toBeUndefined();
    expect(found!.lastActualStoredBytes).toBe(0);
    expect(found!.lastHeartbeat).toBe(0);
  });

  it('scores a discovered provider as UNKNOWN, never as good', () => {
    // We hold no history for it, so its score is a neutral prior rather than a
    // number we invented.
    const p = generateKeyPair();
    const [found] = foldProviderBlocks(
      [signed(p, 'storage-register', 1, DAY, { capacityGB: 10, deviceId: 'd' })]);
    expect(found!.score).toBe(UNKNOWN_SCORE);
    expect(found!.heartbeatsLast24h).toBe(0);
  });

  it('refuses a forged register block', () => {
    // The whole security claim: a relay may choose what to show and cannot
    // invent it. A block whose signature does not verify contributes nothing.
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 10, deviceId: 'd' });
    const forged = { ...reg, signature: 'ff'.repeat(64) } as Block;
    expect(foldProviderBlocks([forged])).toHaveLength(0);
  });

  it('cannot be inflated past what the provider itself signed', () => {
    const p = generateKeyPair();
    const reg = signed(p, 'storage-register', 1, DAY, { capacityGB: 10, deviceId: 'd' });
    // Tampering with the payload breaks the signature over it.
    const inflated = { ...reg, storage: { ...reg.storage, capacityGB: 1_000_000 } } as Block;
    expect(foldProviderBlocks([inflated])).toHaveLength(0);
  });

  it('serves the newest registration per provider, bounded by the limit', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const blocks = [
      signed(a, 'storage-register', 1, DAY, { capacityGB: 5, deviceId: 'a' }),
      signed(a, 'storage-register', 2, DAY + 1000, { capacityGB: 9, deviceId: 'a' }),
      signed(b, 'storage-register', 1, DAY + 2000, { capacityGB: 7, deviceId: 'b' }),
    ];
    const served = selectDiscoveryBlocks(blocks, 10, DAY + 3000);
    // One per provider — an unbounded answer is the firehose over HTTP.
    expect(served.filter(x => x.accountId === a.pub)).toHaveLength(1);
    expect(served.filter(x => x.accountId === a.pub)[0]!.storage?.capacityGB).toBe(9);
    expect(selectDiscoveryBlocks(blocks, 1, DAY + 3000).length).toBeLessThanOrEqual(1);
  });
});
