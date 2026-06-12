import { describe, it, expect } from 'vitest';
import { runScenario } from './scenario.js';

/**
 * The Phase 1 validation criterion, measured: per-node cost must stay flat as the
 * network grows. We sweep the network size and assert each node's receive/store
 * cost tracks the (constant) follow bound, while the broadcast baseline — what the
 * old "every node sees every block" gossip would cost — grows linearly with N.
 */
describe('scale invariant — per-node cost is O(followed), not O(N)', () => {
  it('per-node receive/store stays flat while the network grows 16x', () => {
    const sizes = [40, 160, 640];
    const followPerNode = 10;
    const blocksPerAccount = 3;
    const bound = (followPerNode + 1) * blocksPerAccount;

    const results = sizes.map((n) => runScenario({ totalAccounts: n, followPerNode, blocksPerAccount }));

    // eslint-disable-next-line no-console
    console.log('\n  N      per-node recv   per-node store   broadcast would be   saving');
    for (const r of results) {
      const saving = (r.broadcastBaseline / r.perNode.maxReceived).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(r.config.totalAccounts).padEnd(6)} ${String(r.perNode.maxReceived).padEnd(15)} ${String(r.perNode.maxStored).padEnd(16)} ${String(r.broadcastBaseline).padEnd(20)} ${saving}x`,
      );
    }

    for (const r of results) {
      expect(r.perNode.maxReceived).toBe(bound); // constant — independent of N
      expect(r.perNode.avgReceived).toBe(bound);
      expect(r.perNode.maxStored).toBe(bound);
    }

    // Per-node cost did not grow at all even though the network grew 16x …
    expect(results[2]!.perNode.maxStored).toBe(results[0]!.perNode.maxStored);
    // … while broadcast gossip would have grown linearly with N.
    expect(results[2]!.broadcastBaseline).toBe(results[0]!.broadcastBaseline * 16);
  }, 60_000);
});
