import { ChordDht } from '../content/dht.js';
import { canonicalJson, utf8ToBytes } from '../core/hash.js';

/**
 * G1 measured: the username/account directory as DHT records, not global gossip.
 *
 * Today (the G1 violation) every node subscribes to one network-wide `accounts`
 * topic and ingests every account record ever created — O(N) memory, bandwidth
 * and storage per node, re-amplified by the 20s re-publish tick. The designed fix
 * (ARCHITECTURE.md Subsystem 3): a username→accountId record lives on the k DHT
 * nodes closest to hash(username); a client RESOLVES a name on demand (O(log M)
 * hops) and caches only what it resolved. Nobody holds the whole directory:
 *
 *   - per-CLIENT cost   = O(names it actually resolved)          — flat in N
 *   - per-SERVER cost   = O(N · k / M)                           — flat when the
 *     server fleet M grows with N (scale by adding nodes), and any single
 *     server's share of the directory is k/M → 0
 *   - lookup            = O(log M) hops                          — not O(N) gossip
 *
 * This reuses the engine's Chord DHT (`content/dht.ts`) — the same substrate that
 * replaces the global file index — because a username record IS a provider
 * record: "who provides the resolution for name X".
 */

/**
 * A representative signed directory record — what the G1 fix would publish
 * instead of the full account record (the pq keys and recovery material do NOT
 * belong in the directory; they are fetched per-account when actually needed,
 * e.g. key blobs during recovery). Self-certifying: signed by the account so a
 * DHT holder can't forge it; `head` lets the resolver jump straight to a
 * counterparty head-proof request (see counterparty.ts).
 */
export interface DirectoryRecord {
  v: 1;
  username: string;
  accountId: string; // 66-hex compressed P-256 pub
  head: string; //      64-hex current head hash (best-effort hint)
  sig: string; //       128-hex P-256 signature over the record
}

export function representativeRecord(username: string): DirectoryRecord {
  return {
    v: 1,
    username,
    accountId: 'a'.repeat(66),
    head: 'b'.repeat(64),
    sig: 'c'.repeat(128),
  };
}

export function directoryRecordBytes(username = 'averageusername'): number {
  return utf8ToBytes(canonicalJson(representativeRecord(username))).length;
}

export interface DirectoryScenarioConfig {
  /** Total registered usernames (≈ total accounts, N). */
  totalUsers: number;
  /** Directory servers (DHT server-mode super-nodes), M. */
  dhtServers: number;
  /** Names one client resolves over the measured period (its contacts). */
  resolvesPerClient: number;
  /** Replicas per record on the ring. */
  k?: number;
}

export interface DirectoryStats {
  config: Required<DirectoryScenarioConfig>;
  recordBytes: number;
  /** What ONE client pays under on-demand resolution: resolves × recordBytes. */
  perClientBytes: number;
  /** What ONE client pays today under G1: the whole directory, N × recordBytes. */
  gossipBaselineBytes: number;
  server: {
    maxRecords: number;
    avgRecords: number;
    /** Largest single-server slice of the directory (≈ k/M). 1.0 = full replica. */
    maxShare: number;
  };
  lookup: {
    avgHops: number;
    maxHops: number;
  };
}

export function runDirectoryScenario(config: DirectoryScenarioConfig): DirectoryStats {
  const { totalUsers, dhtServers, resolvesPerClient, k = 8 } = config;

  const dht = new ChordDht(k);
  for (let s = 0; s < dhtServers; s++) dht.addNode(`dir-server-${s}`);
  dht.build();

  const recordBytes = directoryRecordBytes();
  for (let u = 0; u < totalUsers; u++) {
    // The "provider" of a name's resolution is the account itself.
    dht.provide(`dir/user-${u}`, `account-${u}`);
  }

  // One client resolves `resolvesPerClient` distinct names, entering the ring at
  // a deterministic spread of servers (a client asks whichever server it knows).
  let totalHops = 0;
  let maxHops = 0;
  for (let i = 0; i < resolvesPerClient; i++) {
    const name = `dir/user-${(i * 7919) % totalUsers}`; // stride over the space
    const entry = `dir-server-${(i * 31) % dhtServers}`;
    const { providers, hops } = dht.findProviders(name, entry);
    if (providers.length === 0) throw new Error(`resolution failed for ${name}`);
    totalHops += hops;
    maxHops = Math.max(maxHops, hops);
  }

  let maxRecords = 0;
  let sumRecords = 0;
  for (const id of dht.nodeIds()) {
    const n = dht.indexSize(id);
    maxRecords = Math.max(maxRecords, n);
    sumRecords += n;
  }

  return {
    config: { totalUsers, dhtServers, resolvesPerClient, k },
    recordBytes,
    perClientBytes: resolvesPerClient * recordBytes,
    gossipBaselineBytes: totalUsers * recordBytes,
    server: {
      maxRecords,
      avgRecords: sumRecords / dhtServers,
      maxShare: maxRecords / totalUsers,
    },
    lookup: {
      avgHops: totalHops / resolvesPerClient,
      maxHops,
    },
  };
}
