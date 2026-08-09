import { RelayDirectory } from '../net/relay-directory.js';
import { hashHex, utf8ToBytes, type Hex } from '../core/hash.js';

/**
 * Decentralized archival, measured: no archive node is REQUIRED to hold
 * everything.
 *
 * Full replicas stay allowed — an operator with the capacity may opt in to
 * mirror the whole archive (today's two dev relays are exactly that, and it's a
 * useful durability bonus). What must never be true is the system NEEDING one:
 * required redundancy has to come from many capacity-bounded holders, so the
 * network still works when nobody volunteers a full mirror. The target shape
 * (SUPERNODE.md → Scaling, generalized here to account granularity): each
 * account's history has exactly K designated holders out of an open fleet of S
 * archive nodes, assigned by rendezvous (HRW) hashing — the same consistent
 * assignment the relay federation already uses (`net/relay-directory.ts`):
 *
 *   - DETERMINISTIC + DISCOVERABLE: anyone computes an account's K holders from
 *     the (DHT-published) archive-node directory — no coordinator, no lookup
 *     table that itself grows O(N).
 *   - BOUNDED PER NODE: each node holds ≈ K/S of the total data. A node's cost
 *     is set by its declared capacity; the NETWORK scales by adding nodes, never
 *     by growing any single node. Max share → 0 as S grows.
 *   - CHURN-SAFE: removing a node leaves every account with its other K−1
 *     holders (HRW property: the surviving top-(K−1) set is unchanged); adding a
 *     node reassigns only ≈ 1/S of account-slots.
 *
 * Account granularity (not whole-shard) matters at 10B: with a fixed 4096-shard
 * space one shard ≈ 2.4M accounts at 10B users, so "hold ≥1 whole shard" would
 * put an O(N/4096) floor under every archive node. Per-account rendezvous has no
 * floor — a small node can honestly serve a small capacity slice.
 */

export interface ArchivalScenarioConfig {
  /** Total accounts in the network (N). */
  accounts: number;
  /** Capacity-bounded archive fleet size (S). */
  archiveNodes: number;
  /** REQUIRED holders per account (K) — met by the rendezvous fleet alone. */
  redundancy: number;
  /** Archived bytes per account chain (uniform proxy; measured elsewhere). */
  bytesPerAccount: number;
  /**
   * Opt-in full replicas (like today's dev relays): they mirror everything as a
   * durability BONUS on top of K. The stats below prove the invariant holds
   * with them counted out — they may leave at any time.
   */
  fullReplicas?: number;
}

export interface ArchivalStats {
  config: ArchivalScenarioConfig;
  totalBytes: number;
  perNode: { maxBytes: number; avgBytes: number; minBytes: number };
  /** Largest single node's slice of ALL archived data. 1.0 = full replica. */
  maxShare: number;
  /** Load balance: max/avg (1.0 = perfectly even). */
  balance: number;
  /** Every account has exactly K distinct holders. */
  redundancyHeld: boolean;
  /** After losing one node: every account still has ≥ K−1 of its original holders. */
  survivesNodeLoss: boolean;
  /** Fraction of account-slots reassigned when one node joins (≈ 1/S expected). */
  joinReshuffle: number;
  /** Redundancy counting opt-in full replicas: K + fullReplicas. */
  effectiveRedundancy: number;
  /** Bytes an opt-in full replica carries (= the whole archive, by choice). */
  fullReplicaBytes: number;
}

function accountId(i: number): Hex {
  return hashHex(utf8ToBytes(`acct-${i}`));
}

export function runArchivalScenario(config: ArchivalScenarioConfig): ArchivalStats {
  const { accounts, archiveNodes, redundancy, bytesPerAccount, fullReplicas = 0 } = config;

  // Full replicas sit OUTSIDE the rendezvous directory: they mirror everything
  // (like an ARCHIVE=1 relay ingesting all federated gossip) but are never part
  // of the required-holder assignment — every stat below must hold without them.
  const directory = new RelayDirectory();
  for (let s = 0; s < archiveNodes; s++) directory.add(`archive-${s}`);

  const load = new Map<Hex, number>();
  for (const id of directory.list()) load.set(id, 0);
  const holders: Hex[][] = [];
  for (let i = 0; i < accounts; i++) {
    const assigned = directory.assign(accountId(i), redundancy);
    holders.push(assigned);
    for (const node of assigned) load.set(node, load.get(node)! + bytesPerAccount);
  }

  const redundancyHeld = holders.every((h) => new Set(h).size === redundancy);

  // Churn 1 — node loss: drop the busiest node; every account must keep its
  // other K−1 original holders (HRW: removing one candidate never reorders the rest).
  let maxBytes = 0;
  let minBytes = Infinity;
  let sumBytes = 0;
  let busiest: Hex = directory.list()[0]!;
  for (const [node, bytes] of load) {
    if (bytes > maxBytes) {
      maxBytes = bytes;
      busiest = node;
    }
    minBytes = Math.min(minBytes, bytes);
    sumBytes += bytes;
  }
  directory.remove(busiest);
  let survivesNodeLoss = true;
  for (let i = 0; i < accounts; i++) {
    const before = holders[i]!;
    const after = new Set(directory.assign(accountId(i), redundancy));
    for (const h of before) {
      if (h !== busiest && !after.has(h)) {
        survivesNodeLoss = false;
        break;
      }
    }
    if (!survivesNodeLoss) break;
  }
  directory.add(busiest);

  // Churn 2 — node join: one newcomer takes over ≈ 1/S of account-slots.
  directory.add('archive-newcomer');
  let moved = 0;
  for (let i = 0; i < accounts; i++) {
    const after = directory.assign(accountId(i), redundancy);
    if (after.includes('archive-newcomer')) moved++;
  }
  directory.remove('archive-newcomer');

  const totalBytes = accounts * bytesPerAccount;
  return {
    config,
    totalBytes,
    perNode: { maxBytes, avgBytes: sumBytes / archiveNodes, minBytes },
    maxShare: maxBytes / totalBytes,
    balance: maxBytes / (sumBytes / archiveNodes),
    redundancyHeld,
    survivesNodeLoss,
    joinReshuffle: moved / accounts,
    effectiveRedundancy: redundancy + fullReplicas,
    fullReplicaBytes: fullReplicas > 0 ? totalBytes : 0,
  };
}
