import { describe, it, expect } from 'vitest';
import { ChordDht } from './dht.js';

function buildDht(n: number, k = 8): ChordDht {
  const dht = new ChordDht(k);
  for (let i = 0; i < n; i++) dht.addNode('node-' + i);
  dht.build();
  return dht;
}

describe('ChordDht', () => {
  it('finds the providers that announced a cid, from any starting node', () => {
    const dht = buildDht(64);
    const ids = dht.nodeIds();
    dht.provide('cidA', 'provider-1');
    dht.provide('cidA', 'provider-2');

    const r = dht.findProviders('cidA', ids[10]!);
    expect(new Set(r.providers)).toEqual(new Set(['provider-1', 'provider-2']));
    expect(dht.findProviders('cidB', ids[3]!).providers).toEqual([]);
  });

  it('routes in O(log N) hops', () => {
    for (const n of [16, 64, 256, 1024]) {
      const dht = buildDht(n);
      const ids = dht.nodeIds();
      let maxHops = 0;
      for (let t = 0; t < 200; t++) {
        const from = ids[(t * 7) % ids.length]!;
        const { hops } = dht.findProviders('file-' + t, from);
        maxHops = Math.max(maxHops, hops);
      }
      expect(maxHops).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + 2);
    }
  });

  it('stores each record on exactly k responsible nodes', () => {
    const k = 8;
    const dht = buildDht(128, k);
    dht.provide('the-cid', 'p1');
    const holders = dht.nodeIds().filter((id) => dht.indexSize(id) > 0);
    expect(holders.length).toBe(k);
  });
});
