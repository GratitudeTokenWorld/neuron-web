import { describe, it, expect } from 'vitest';
import { runArchivalScenario } from './archival.js';

/**
 * The archival tier without a full replica, measured. As N and the fleet S grow
 * together, each node's held bytes stay ≈ K·N·bytes/S (its declared capacity)
 * and the largest node's share of the total archive shrinks toward zero — while
 * K-redundancy and churn-safety hold. "Decentralized" is these numbers, not the
 * node count.
 */
describe('archival — K-redundant rendezvous holders, max share → 0', () => {
  const BYTES_PER_ACCOUNT = 65_536; // ~100-block chain at ~650 B/block
  const K = 4;
  // N and S grow 4x per step: per-node load should stay ~flat.
  const sweep = [
    { accounts: 500, archiveNodes: 8 },
    { accounts: 2_000, archiveNodes: 32 },
    { accounts: 8_000, archiveNodes: 128 },
  ];

  it('per-node load flat as N and fleet grow together; share shrinks; churn-safe', () => {
    const results = sweep.map((s) =>
      runArchivalScenario({ ...s, redundancy: K, bytesPerAccount: BYTES_PER_ACCOUNT }),
    );

    // eslint-disable-next-line no-console
    console.log('\n  N       nodes   per-node MB max/avg   max share   balance   join reshuffle');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(r.config.accounts).padEnd(7)} ${String(r.config.archiveNodes).padEnd(7)} ${`${(r.perNode.maxBytes / 1e6).toFixed(1)}/${(r.perNode.avgBytes / 1e6).toFixed(1)}`.padEnd(21)} ${(r.maxShare * 100).toFixed(1).padEnd(9)}% ${r.balance.toFixed(2).padEnd(9)} ${(r.joinReshuffle * 100).toFixed(1)}%`,
      );
    }

    for (const r of results) {
      // Exactly K distinct holders per account, always.
      expect(r.redundancyHeld).toBe(true);
      // Losing any one node never costs an account more than that one holder.
      expect(r.survivesNodeLoss).toBe(true);
      // Average load is exactly K·N·bytes/S (every account lands on K nodes).
      const expectedAvg = (r.config.accounts * K * BYTES_PER_ACCOUNT) / r.config.archiveNodes;
      expect(r.perNode.avgBytes).toBeCloseTo(expectedAvg, 5);
      // HRW keeps load reasonably even (max within 2x of avg at these sizes).
      expect(r.balance).toBeLessThan(2);
      // A newcomer takes ≈ K/S of account-slots (minimal reshuffle), not a rebuild.
      expect(r.joinReshuffle).toBeLessThan((3 * K) / r.config.archiveNodes);
    }

    // Per-node bytes stay ~flat across the 16x growth (fleet grew with demand) …
    const [small, , large] = [results[0]!, results[1]!, results[2]!];
    expect(large.perNode.avgBytes).toBeCloseTo(small.perNode.avgBytes, 5);
    // … and the biggest node's share of the whole archive keeps shrinking:
    // nobody is anywhere near a full replica, and it only gets more distributed.
    expect(large.maxShare).toBeLessThan(small.maxShare / 4);
    expect(large.maxShare).toBeLessThan(0.1);
  }, 60_000);

  it('full replicas are allowed as a bonus — never load-bearing', () => {
    // An operator who WANTS to mirror everything may (today's two dev relays do
    // exactly this). The invariant: required K-redundancy, churn-safety and
    // per-node bounds all hold with full replicas counted out, so they can
    // leave at any time without the network noticing.
    const r = runArchivalScenario({
      accounts: 1_000,
      archiveNodes: 16,
      redundancy: K,
      bytesPerAccount: BYTES_PER_ACCOUNT,
      fullReplicas: 2,
    });
    expect(r.effectiveRedundancy).toBe(K + 2);
    expect(r.fullReplicaBytes).toBe(r.totalBytes); // they hold it all, by choice
    // …and the capacity-bounded fleet still satisfies everything alone:
    expect(r.redundancyHeld).toBe(true);
    expect(r.survivesNodeLoss).toBe(true);
    expect(r.maxShare).toBeLessThan(0.5);
  });
});
