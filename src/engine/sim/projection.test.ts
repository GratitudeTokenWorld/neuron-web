import { describe, it, expect } from 'vitest';
import { projectScale, type ScaleAssumptions } from './projection.js';
import { buildSenderChain, buildPacket, wireBytes } from './counterparty.js';
import { directoryRecordBytes } from './directory.js';

/**
 * The 1B→10B projection, driven by constants MEASURED from real engine objects
 * (a signed block's canonical bytes, a real G2 proof packet, a directory
 * record) — not guesses. The exact sims prove the curves' SHAPES (flat /
 * K-out-of-S / O(log)); this locks in what the constants imply at target scale
 * and that every per-user number is independent of N.
 */

/** Measure the real constants once: an actual signed chain + proof packet. */
function measuredConstants() {
  const chain = buildSenderChain(64, 32);
  const blockBytes = Math.ceil(
    chain.blocks.slice(1).reduce((s, b) => s + wireBytes(b), 0) / (chain.blocks.length - 1),
  );
  // Packet measured on a 64-block chain; audit paths grow ~64 B per doubling of
  // chain length, so this is within ~1 KB of the packet at any realistic length.
  const packetBytes = wireBytes(buildPacket(chain, 32));
  return { blockBytes, packetBytes, dirRecordBytes: directoryRecordBytes() };
}

// Measured ONCE and shared: a freshly-built chain's exact byte count varies by
// a few bytes run-to-run (signature encoding), and the N-independence assertion
// below compares projections that must share identical constants.
const CONSTANTS = measuredConstants();

function assumptions(users: number): ScaleAssumptions {
  const { blockBytes, packetBytes, dirRecordBytes } = CONSTANTS;
  return {
    users,
    avgChainLength: 200, //          lifetime blocks per account
    blockBytes,
    dirRecordBytes,
    packetBytes,
    dirReplication: 8, //            k — matches ChordDht default
    archiveRedundancy: 4, //         K holders per account
    follows: 200,
    postsPerDay: 2,
    resolvesPerDay: 20,
    archiveNodeCapacityBytes: 2e12, //   2 TB — the "Pi with a 2 TB SD" reality
    dirServerCapacityRecords: 50e6, //   50M records ≈ 17 GB on disk
    relayCapacityPeers: 5_000,
    concurrentFraction: 0.05,
    relayReplication: 2,
    numShards: 4096,
  };
}

describe('projection — measured constants at 1B and 10B users', () => {
  it('per-user cost is independent of N; no tier needs a full replica', () => {
    const at1B = projectScale(assumptions(1e9));
    const at10B = projectScale(assumptions(1e10));

    for (const p of [at1B, at10B]) {
      // eslint-disable-next-line no-console
      console.log(
        `\n  ${p.users.toExponential(0)} users — archive total ${(p.totalArchiveBytes / 1e15).toFixed(2)} PB` +
          `\n  light client: ${(p.lightClient.storageBytes / 1e6).toFixed(1)} MB stored, ` +
          `${(p.lightClient.dailyBandwidthBytes / 1e6).toFixed(2)} MB/day` +
          `\n  committee residual: ${p.committee.perShardBlocksPerSec.toFixed(1)} blocks/s per shard`,
      );
      for (const t of p.tiers) {
        // eslint-disable-next-line no-console
        console.log(
          `    ${t.tier.padEnd(10)} fleet ${String(t.fleetNodes).padStart(8)}  per-node ${(t.perNodeBytes / 1e9).toFixed(1).padStart(7)} GB  share ${(t.maxShare * 100).toFixed(4)}%`,
        );
      }
    }

    // A user's device costs the same at 10B as at 1B — the scale invariant.
    expect(at10B.lightClient).toEqual(at1B.lightClient);
    // …and it is small in absolute terms (a phone can pay it).
    expect(at1B.lightClient.storageBytes).toBeLessThan(50e6); // < 50 MB
    expect(at1B.lightClient.dailyBandwidthBytes).toBeLessThan(5e6); // < 5 MB/day

    for (const p of [at1B, at10B]) {
      for (const t of p.tiers) {
        // Every server node stays within its declared capacity…
        if (t.tier === 'archive') expect(t.perNodeBytes).toBeLessThanOrEqual(2e12);
        // …and holds a vanishing share of the global dataset — full replicas
        // remain an opt-in bonus, never a requirement.
        expect(t.maxShare).toBeLessThan(0.01);
      }
    }

    // Fleets grow ~linearly with N (scale by adding nodes) — 10x users needs
    // ~10x nodes, each node's job unchanged.
    const fleet = (p: typeof at1B, tier: string) => p.tiers.find((t) => t.tier === tier)!.fleetNodes;
    for (const tier of ['directory', 'archive', 'relay']) {
      const growth = fleet(at10B, tier) / fleet(at1B, tier);
      expect(growth).toBeGreaterThan(9);
      expect(growth).toBeLessThan(11);
    }

    // The honest residual: committee members validate O(N/shards) traffic. At
    // 10B and 4096 shards that is still modest for one machine — but the
    // projection asserts the ceiling so growth past it forces the shard-count
    // parameter up, rather than silently overloading validators.
    expect(at10B.committee.perShardBlocksPerSec).toBeLessThan(200);
  });
});
