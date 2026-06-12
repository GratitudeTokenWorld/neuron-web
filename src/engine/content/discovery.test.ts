import { describe, it, expect } from 'vitest';
import { ChordDht } from './dht.js';

/**
 * Phase 3 validation: content discovery scales.
 *
 * We grow the network and the file count together (files = filesPerNode × N) and
 * measure the per-node provider-record index. Under the DHT it stays flat at
 * ≈ filesPerNode × k, while the old global gossiped index (every node holds every
 * file record) would grow linearly with the total file count. Discovery stays
 * O(log N) throughout.
 */
describe('content discovery scales — per-node index flat, routing O(log N)', () => {
  it('per-node index is independent of total file count', () => {
    const filesPerNode = 4;
    const k = 8;
    const sizes = [64, 256, 1024];

    // eslint-disable-next-line no-console
    console.log('\n  N      files    avg index   max index   max hops   log2(N)   global index would be');
    const rows: { n: number; avg: number; max: number; maxHops: number; totalFiles: number }[] = [];

    for (const n of sizes) {
      const dht = new ChordDht(k);
      for (let i = 0; i < n; i++) dht.addNode('node-' + i);
      dht.build();
      const ids = dht.nodeIds();

      const totalFiles = filesPerNode * n;
      for (let f = 0; f < totalFiles; f++) dht.provide('file-' + n + '-' + f, ids[f % n]!);

      let sum = 0;
      let max = 0;
      for (const id of ids) {
        const s = dht.indexSize(id);
        sum += s;
        max = Math.max(max, s);
      }
      const avg = sum / n;

      let maxHops = 0;
      for (let t = 0; t < 200; t++) {
        const { hops } = dht.findProviders('file-' + n + '-' + (t % totalFiles), ids[(t * 13) % n]!);
        maxHops = Math.max(maxHops, hops);
      }

      rows.push({ n, avg, max, maxHops, totalFiles });
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(n).padEnd(6)} ${String(totalFiles).padEnd(8)} ${avg.toFixed(1).padEnd(11)} ${String(max).padEnd(11)} ${String(maxHops).padEnd(10)} ${String(Math.ceil(Math.log2(n))).padEnd(9)} ${totalFiles}`,
      );
    }

    const expectedAvg = filesPerNode * k; // = 32, independent of N
    for (const r of rows) {
      // Total records = totalFiles × k, spread over N nodes → avg is exactly filesPerNode × k.
      expect(Math.abs(r.avg - expectedAvg)).toBeLessThan(0.001);
      // Load is bounded (no node holds anywhere near the global index).
      expect(r.max).toBeLessThan(expectedAvg * 4);
      // Discovery stays logarithmic.
      expect(r.maxHops).toBeLessThanOrEqual(Math.ceil(Math.log2(r.n)) + 2);
    }

    // Per-node index did NOT grow while the global-index baseline grew 16×.
    expect(rows[2]!.avg).toBeCloseTo(rows[0]!.avg, 5);
    expect(rows[2]!.totalFiles).toBe(rows[0]!.totalFiles * 16);
  });
});
