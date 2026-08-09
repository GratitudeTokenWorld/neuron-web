import { describe, it, expect } from 'vitest';
import { runDirectoryScenario } from './directory.js';

/**
 * The G1 fix, measured: on-demand DHT resolution keeps every party's directory
 * cost bounded by its own interest while the network grows — client cost by what
 * it resolves, server cost by k/M of the records, lookups by O(log M) hops. The
 * gossip baseline (what the global `accounts` topic costs today) is the control.
 */
describe('G1 — username directory: per-node cost is O(interest), not O(N)', () => {
  // N and the server fleet grow together 16x — "scale by adding nodes".
  const sweep = [
    { totalUsers: 4_000, dhtServers: 32 },
    { totalUsers: 16_000, dhtServers: 128 },
    { totalUsers: 64_000, dhtServers: 512 },
  ];
  const resolvesPerClient = 50;

  it('client cost flat, server share shrinking, hops logarithmic', () => {
    const results = sweep.map((s) => runDirectoryScenario({ ...s, resolvesPerClient }));

    // eslint-disable-next-line no-console
    console.log('\n  N       servers   client KB   gossip-baseline KB   srv records max/avg   max share   hops avg/max');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(r.config.totalUsers).padEnd(7)} ${String(r.config.dhtServers).padEnd(9)} ${(r.perClientBytes / 1024).toFixed(1).padEnd(11)} ${(r.gossipBaselineBytes / 1024).toFixed(0).padEnd(20)} ${`${r.server.maxRecords}/${r.server.avgRecords.toFixed(0)}`.padEnd(21)} ${(r.server.maxShare * 100).toFixed(2).padEnd(9)}% ${r.lookup.avgHops.toFixed(1)}/${r.lookup.maxHops}`,
      );
    }

    const [small, , large] = [results[0]!, results[1]!, results[2]!];

    // Per-client cost is EXACTLY flat across the 16x sweep — it depends only on
    // how many names the client resolved …
    expect(large.perClientBytes).toBe(small.perClientBytes);
    // … while today's G1 gossip baseline grew 16x with the network.
    expect(large.gossipBaselineBytes).toBe(small.gossipBaselineBytes * 16);

    for (const r of results) {
      // A server holds ≈ k/M of the directory; never anything close to all of it.
      const expectedAvg = (r.config.totalUsers * r.config.k) / r.config.dhtServers;
      expect(r.server.avgRecords).toBeCloseTo(expectedAvg, 5);
      expect(r.server.maxShare).toBeLessThan(1);
      // Lookup is O(log M): generous 2·log2(M) ceiling, nothing near O(M).
      expect(r.lookup.maxHops).toBeLessThanOrEqual(2 * Math.log2(r.config.dhtServers));
    }

    // Decentralization deepens as the fleet grows: the largest single server's
    // slice of the directory SHRINKS ~with 1/M (allow 2x slack for ring skew).
    expect(large.server.maxShare).toBeLessThan(small.server.maxShare / 4);
  });
});
