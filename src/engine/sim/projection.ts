import { RelayDirectory } from '../net/relay-directory.js';

/**
 * Scale projection: per-node cost at 1B–10B users, from MEASURED constants.
 *
 * The exact simulations in this directory prove the mechanisms with real crypto
 * at feasible N (10³–10⁵) and — critically — that every per-node cost curve is
 * FLAT in N (clients) or K/S-bounded (servers). What they cannot do is
 * instantiate 10¹⁰ nodes. This module is the bridge: it takes the constants the
 * exact sims measure (bytes per block, per directory record, per counterparty
 * packet) and the mechanisms they validate (interest routing, DHT directory,
 * rendezvous archival, HRW relay assignment), and computes what each role
 * actually pays at any N.
 *
 * The decentralization law it encodes: a node's cost is set by its DECLARED
 * CAPACITY, never by network size. Demand growth is met by fleet growth
 * (S ∝ N), so every node's share of any global dataset is ≈ replication/S → 0.
 * No role — archive included — is REQUIRED to hold everything (operators may
 * still opt in to full mirrors as a durability bonus; see archival.ts).
 *
 * The one deliberate O(N/shards) residual: a shard COMMITTEE member validates
 * its shard's write traffic, which grows with N under a fixed 4096-shard space.
 * It is reported per-node here so the projection SHOWS when the shard count
 * itself must scale (a protocol parameter, not a redesign — see partition.ts).
 */

export interface ScaleAssumptions {
  users: number;
  /** Lifetime blocks per account (chain length a holder archives). */
  avgChainLength: number;
  /** Measured: canonical bytes of one engine block. */
  blockBytes: number;
  /** Measured: canonical bytes of one signed directory record. */
  dirRecordBytes: number;
  /** Measured: counterparty proof packet bytes at avgChainLength (G2 path). */
  packetBytes: number;
  /** Directory record replicas on the DHT ring (k). */
  dirReplication: number;
  /** Archive holders per account (K). */
  archiveRedundancy: number;
  /** Accounts a typical user follows. */
  follows: number;
  /** New blocks per followed account per day. */
  postsPerDay: number;
  /** New usernames a client resolves per day. */
  resolvesPerDay: number;
  /** Declared capacity of one volunteer archive node (bytes). */
  archiveNodeCapacityBytes: number;
  /** Declared capacity of one directory server (records). */
  dirServerCapacityRecords: number;
  /** Concurrent reservations one relay carries. */
  relayCapacityPeers: number;
  /** Fraction of users online concurrently. */
  concurrentFraction: number;
  /** Relays per peer. */
  relayReplication: number;
  /** Shard space (fixed protocol parameter today). */
  numShards: number;
}

export interface TierProjection {
  tier: 'directory' | 'archive' | 'relay';
  /** Fleet size needed so no node exceeds its declared capacity. */
  fleetNodes: number;
  /** Bytes one node holds/serves at that fleet size. */
  perNodeBytes: number;
  /** One node's fraction of the tier's global dataset (1 = full replica). */
  maxShare: number;
}

export interface ScaleProjection {
  users: number;
  lightClient: {
    /** Own chain + per-followed proof packet + resolved directory cache. */
    storageBytes: number;
    /** Followed blocks + resolutions, per day. */
    dailyBandwidthBytes: number;
  };
  totalArchiveBytes: number;
  tiers: TierProjection[];
  committee: {
    /** Blocks/s one shard's committee member must validate (the O(N/shards) residual). */
    perShardBlocksPerSec: number;
  };
}

export function projectScale(a: ScaleAssumptions): ScaleProjection {
  // ── Light client: every term is per-interest; none contains a.users ──────────
  const ownChainBytes = a.avgChainLength * a.blockBytes;
  const lightStorage =
    ownChainBytes + a.follows * (a.packetBytes + a.dirRecordBytes);
  const lightDaily =
    a.follows * a.postsPerDay * a.blockBytes + a.resolvesPerDay * a.dirRecordBytes;

  // ── Directory tier: N·k records spread over a fleet sized by capacity ────────
  const dirRecords = a.users * a.dirReplication;
  const dirFleet = Math.ceil(dirRecords / a.dirServerCapacityRecords);
  const dirPerNodeRecords = dirRecords / dirFleet;

  // ── Archive tier: N chains × K holders over capacity-sized fleet ─────────────
  const totalArchiveBytes = a.users * a.avgChainLength * a.blockBytes;
  const archiveFleet = Math.ceil((totalArchiveBytes * a.archiveRedundancy) / a.archiveNodeCapacityBytes);
  const archivePerNode = (totalArchiveBytes * a.archiveRedundancy) / archiveFleet;

  // ── Relay tier: connectivity for the concurrent population ───────────────────
  const concurrent = Math.ceil(a.users * a.concurrentFraction);
  const relayFleet = RelayDirectory.relaysNeeded(concurrent, a.relayReplication, a.relayCapacityPeers);

  // ── Committee residual: shard write traffic (grows with N at fixed shards) ───
  const networkBlocksPerSec = (a.users * a.postsPerDay) / 86_400;
  const perShardBlocksPerSec = networkBlocksPerSec / a.numShards;

  return {
    users: a.users,
    lightClient: { storageBytes: lightStorage, dailyBandwidthBytes: lightDaily },
    totalArchiveBytes,
    tiers: [
      {
        tier: 'directory',
        fleetNodes: dirFleet,
        perNodeBytes: dirPerNodeRecords * a.dirRecordBytes,
        maxShare: dirPerNodeRecords / dirRecords,
      },
      {
        tier: 'archive',
        fleetNodes: archiveFleet,
        perNodeBytes: archivePerNode,
        maxShare: archivePerNode / (totalArchiveBytes * a.archiveRedundancy),
      },
      {
        tier: 'relay',
        fleetNodes: relayFleet,
        perNodeBytes: 0, // relays hold no global state by design
        maxShare: 1 / relayFleet,
      },
    ],
    committee: { perShardBlocksPerSec },
  };
}
