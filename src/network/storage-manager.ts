/**
 * Decentralised Storage Manager
 *
 * Manages the lifecycle of NeuronChain's built-in storage ledger:
 *
 *   Providers register with a capacity (GB) via a storage-register block.
 *   Every heartbeat interval, active providers broadcast a storage-heartbeat block
 *   (proof of uptime). Once per reward epoch, providers self-issue a storage-reward
 *   block that mints new UNIT:
 *     reward = BASE_RATE × storedGB × (heartbeatCount / MAX_HEARTBEATS_PER_EPOCH)
 *
 *   When a user stores content, StorageManager selects up to 10 providers from
 *   the ledger (weighted random by capacityGB × score), publishes a cache request,
 *   and those providers fetch and cache the CID via smoke Http (HTTP over WebRTC).
 *
 *   Off-chain retrieval receipts (signed by the requesting peer) are collected
 *   and used to update latency and spot-check metrics in the provider's ledger
 *   profile. These affect the displayed score but not on-chain reward validation.
 */

import { EventEmitter } from '../core/events';
import { EngineLedger } from '../ledger/engine-ledger';
import type { StorageProviderState as StorageProvider } from '../engine/content/provider-ledger';
import { Libp2pNetwork, FileIndexRecord } from './libp2p-network';
import { SmokeStore } from './smoke-store';
import { AccountBlock } from '../core/dag-block';
import { KeyPair } from '../core/crypto';
import { sign as engineSign, verify as engineVerify } from '../engine/core/keys';
import { getDeviceId, getCountryCode } from './node';
import { engineKeysFromAppPrivate } from '../ledger/key-bridge';
// Timing comes from the engine, never from `core/dag-block`'s legacy copies of
// the same numbers: those are fixed at production values, so under the `fast`
// dev profile the heartbeat TIMER would still fire every 4h while the ledger
// counted renewals every 2 min. Two clocks measuring the same thing is the bug
// this file has now hit in three different guises.
import {
  claimableEpochDay, HEARTBEAT_INTERVAL_MS, REWARD_EPOCH_MS,
} from '../engine/content/provider-ledger';
import {
  REDUNDANCY_TARGET, MAX_REPLICA_TARGET, MIN_REPLICAS,
  CustodySignals, planRepair, planRejoin, pollIntervalMs, liveHolders,
} from '../engine/content/custody';
import type { Block as EngineBlock } from '../engine/core/block';

// Every cadence here is a FRACTION of the timing profile, not a wall-clock
// constant. Under the `fast` dev profile a reward epoch is 12 minutes, and a
// 30-minute reward poll would simply never fire inside one — the compressed
// profile would look broken while behaving correctly.
// Jitter is one-sided LATE on purpose — never early. An early renewal risks
// being refused by `countsAsRenewal` and burning a chain block for nothing, so
// the timer overshoots rather than undershoots. The cost is that six intervals
// span slightly more than one epoch, which is why the uptime counting window
// carries a half-interval of slack (see countHeartbeatsLast24h). The old
// comment here claimed "±" while the code was `Math.random() * J`; the code was
// right and the comment was not.
const jitterMs = () => HEARTBEAT_INTERVAL_MS / 48;            // up to +5 min at production timing
const rewardCheckMs = () => Math.max(5_000, REWARD_EPOCH_MS / 48);   // 30 min at production timing
const spotCheckBaseMs = () => Math.max(10_000, REWARD_EPOCH_MS / 24); // 1 h at production timing
const receiptWindowMs = () => REWARD_EPOCH_MS;                // one epoch of rolling receipts

// REDUNDANCY_TARGET, MIN_REPLICAS and the repair rules live in
// engine/content/custody.ts — pure, and covered by tests, which this file is not.

export interface StorageReceipt {
  [key: string]: unknown;
  /** Provider that served the content */
  providerPub: string;
  /** Peer that retrieved and signed the receipt */
  requesterPub: string;
  cid: string;
  latencyMs: number;
  success: boolean;
  timestamp: number;
  /** ECDSA signature by requesterPub over canonical payload */
  signature: string;
  /** Smoke Hub address of the provider - other nodes use this for Http.fetch fallback */
  providerSmokeAddr?: string;
  /** 1-indexed response rank among all providers checked in this spot-check round (1 = fastest) */
  responseRank?: number;
  /** Total number of providers checked in this spot-check round */
  totalProviders?: number;
  /** Actual bytes stored by this provider after caching — lets other nodes update free-space stats immediately */
  actualStoredBytes?: number;
}

export interface CacheRequest {
  [key: string]: unknown;
  cid: string;
  /** Additional CIDs that must also be cached (e.g. contentCid inside a meta envelope) */
  additionalCids?: string[];
  /**
   * Holders with a LIVE lease that this CID already has. Providers reject the
   * request once it reaches `redundancyTarget`. Live, not merely confirmed:
   * a count that includes lapsed holders reports an object as replicated while
   * the first honest failure would take it below the threshold.
   */
  confirmedProviderCount?: number;
  /**
   * Assigned holders this CID is aiming for — `REDUNDANCY_TARGET`, plus a
   * sub-linear surplus if the owner is seeing real demand (custody.ts →
   * `replicaTarget`). Carried in the request rather than read from a local
   * constant because demand is observed by the OWNER; every other node sees a
   * different slice of it and would compute a different target for the same
   * object. Receivers clamp it to MAX_REPLICA_TARGET — it is a number an
   * attacker writes.
   */
  redundancyTarget?: number;
  /** Smoke addresses of providers that already confirmed holding this CID — new providers use these as fallback fetch sources if the uploader is unavailable */
  confirmedProviderSmokeAddrs?: string[];
  /** Public keys of providers selected to cache this CID */
  targetProviders: string[];
  uploaderPub: string;
  /** Smoke Hub address of the uploader - providers use Http.fetch to pull blocks via WebRTC */
  uploaderSmokeAddr?: string;
  timestamp: number;
  signature: string;
}

export interface DeleteRequest {
  /** All CIDs to delete (meta + content) */
  cids: string[];
  ownerPub: string;
  timestamp: number;
  /** ECDSA signature by ownerPub over `delete:<cids.join(',')>:<ownerPub>:<timestamp>` */
  signature: string;
}

export interface ReplaceRequest {
  [key: string]: unknown;
  /** Primary old CID being replaced */
  oldCid: string;
  /** Additional old CIDs to drop (e.g. old inner contentCid) */
  oldAdditionalCids?: string[];
  /** New primary CID to cache */
  newCid: string;
  /** Additional new CIDs to cache (e.g. new inner contentCid) */
  newAdditionalCids?: string[];
  ownerPub: string;
  /** Smoke Hub address of the owner - providers use this to fetch new blocks via WebRTC */
  uploaderSmokeAddr?: string;
  timestamp: number;
  /** ECDSA signature by ownerPub over `replace:<oldCid>:<newCid>:<ownerPub>:<timestamp>` */
  signature: string;
}

export class StorageManager extends EventEmitter {
  private ledger: EngineLedger;
  private net: Libp2pNetwork;
  private store: SmokeStore;
  private localKeys: Map<string, KeyPair>;

  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private rewardInterval: ReturnType<typeof setInterval> | null = null;
  private spotCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private statsRefreshInterval: ReturnType<typeof setInterval> | null = null;
  private reannounceInterval: ReturnType<typeof setInterval> | null = null;
  private reannounceDebounce: ReturnType<typeof setTimeout> | null = null;

  /** Rolling 24h receipts per provider (off-chain, in-memory only) */
  private receipts: Map<string, StorageReceipt[]> = new Map();

  /** CIDs we're tracking for redundancy: cid → { owner, confirmedProviders, additionalCids, lastDistributed } */
  private trackedCids: Map<string, { ownerPub: string; confirmedProviders: Set<string>; additionalCids: string[]; lastDistributed: number }> = new Map();

  /** Known providers for each CID (from receipts) - used for targeted retrieval */
  private cidToSmokeAddrs: Map<string, Set<string>> = new Map();

  /** CIDs that failed distribution (no providers at upload time): primaryCid → { ownerPub, additionalCids } */
  private pendingCids: Map<string, { ownerPub: string; additionalCids: string[] }> = new Map();

  /** How many re-replication cycles each CID has been stuck at the same confirmed count */
  private cidStuckCount: Map<string, number> = new Map();

  /**
   * Demand and per-holder failure evidence — the input to use-driven repair
   * (custody.ts). Deliberately in-memory: these are this node's own observations
   * of its own usage, which is what makes them unbiasable and bounded.
   */
  private readonly signals = new CustodySignals();

  /** Primary CIDs currently being cached — prevents concurrent duplicate downloads */
  private cachingInProgress = new Set<string>();

  /**
   * File records for the files this node OWNS. Not a network index.
   *
   * It used to be one: every node subscribed to a global `files` topic, ingested
   * every announcement on the network and persisted the lot to IndexedDB —
   * `O(total files)` per node, the same violation as G1's `accounts` topic and
   * G3's `keyblobs` topic, and the last one left in storage. Announcements still
   * gossip (that is how archives learn them), but a client no longer *keeps*
   * other people's: it holds its own, which is bounded by its own behaviour, and
   * ASKS the archives for anything else (`GET /files`, verified client-side —
   * `node.lookupFiles`). See engine/content/file-index.ts.
   */
  private fileIndex: Map<string, FileIndexRecord> = new Map();

  private started = false;
  /** Wall-clock time this manager started, used to grace-skip the heartbeat-staleness
   *  filter until at least one heartbeat cycle has had time to refresh our view of peers. */
  private startedAt = 0;

  constructor(
    ledger: EngineLedger,
    net: Libp2pNetwork,
    store: SmokeStore,
    localKeys: Map<string, KeyPair>,
  ) {
    super();
    this.ledger = ledger;
    this.net = net;
    this.store = store;
    this.localKeys = localKeys;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();

    // When a block arrives via push (POST from uploader), write the cached marker and
    // publish a StorageReceipt immediately — without waiting for the CacheRequest pull.
    // This is the critical path for mobile uploaders behind strict NAT: outbound WebRTC
    // (mobile→desktop) succeeds, so the push delivers the block; the pull model fails.
    this.store.setBlockPushHandler((cid, uploaderPub) => {
      // Same fail-closed rule as every other write path: accepting a pushed
      // block makes this device a holder and publishes a receipt saying so, and
      // a device that is not the registered one must not claim custody.
      const myProviderPub = Array.from(this.localKeys.keys())
        .find(pub => this.servesFromThisDevice(pub));
      if (!myProviderPub) return;
      const keys = this.localKeys.get(myProviderPub);
      if (!keys || !this.net.running) return;

      // Fire-and-forget async work (handler must be sync)
      (async () => {
        try {
          await this.store.markCached(cid, uploaderPub);
          const updatedStoredBytes = await this.store.storageUsedBytes();
          const provider = this.ledger.storageProviders.get(myProviderPub);
          if (provider) provider.lastActualStoredBytes = updatedStoredBytes;

          const providerSmokeAddr = await this.store.getSmokeHostname();
          const ts = Date.now();
          const receiptPayload = `receipt:${cid}:${myProviderPub}:${myProviderPub}:0:true:${ts}`;
          const sig = this.signMsg(receiptPayload, keys);
          const receipt: StorageReceipt = {
            providerPub: myProviderPub, requesterPub: myProviderPub,
            cid, latencyMs: 0, success: true, timestamp: ts, signature: sig,
            providerSmokeAddr, actualStoredBytes: updatedStoredBytes,
          };
          this.net.publishStorageReceipt(receipt);
          console.log(`[StorageManager] Push-received ${cid.slice(0, 16)}… — receipt published`);
          this.emit('storage:cached', { pub: myProviderPub, cid });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[StorageManager] Push-receive handler failed for ${cid.slice(0, 16)}…: ${msg}`);
        }
      })();
    });

    // P7: load persisted trackedCids from IDB so redundancy checks survive restarts
    const persisted = await this.net.loadTrackedCids();
    for (const rec of persisted) {
      this.trackedCids.set(rec.cid, {
        ownerPub: rec.ownerPub,
        confirmedProviders: new Set(rec.confirmedProviders),
        additionalCids: rec.additionalCids,
        lastDistributed: rec.lastDistributed,
      });
    }

    // Watch for incoming cache requests from other nodes.
    // Every node - not just providers - registers the uploader's smoke address so
    // retrieve() can fetch directly from the uploader via WebRTC if needed.
    this.net.watchCacheRequests(async (req) => {
      const r = req as unknown as CacheRequest;
      if (r.uploaderSmokeAddr) this.store.addPeerFallback(r.uploaderSmokeAddr);
      await this.handleCacheRequest(r);
    });

    // Watch for retrieval receipts from peers
    this.net.watchStorageReceipts((receipt) => { this.handleReceipt(receipt as unknown as StorageReceipt).catch(() => {}); });

    // Watch for content delete requests - any node that holds the blocks drops them
    this.net.watchDeleteRequests(async (req) => {
      await this.handleDeleteRequest(req as unknown as DeleteRequest);
    });

    // Watch for content replace requests - providers holding old content swap to the new version
    this.net.watchReplaceRequests(async (req) => {
      await this.handleReplaceRequest(req as unknown as ReplaceRequest);
    });

    // Load persisted file index from IDB
    const persistedIndex = await this.net.loadFileIndex();
    for (const rec of persistedIndex) this.fileIndex.set(rec.cid, rec);

    // File announcements are still published — that is how the archives learn
    // them — but a client only KEEPS records for its own files. Ingesting every
    // other account's was `O(total files)` per node; a withdrawal of somebody
    // else's file is likewise not this node's business to remember. Anything
    // beyond our own is asked for on demand (`node.lookupFiles`).
    this.net.watchFileAnnouncements((ann) => {
      const a = ann as unknown as FileIndexRecord & { removed?: boolean };
      if (!this.localKeys.has(a.uploaderPub)) return;
      if (a.removed) {
        this.fileIndex.delete(a.cid);
        this.net.deleteFileIndexRecord(a.cid);
      } else {
        const record: FileIndexRecord = { cid: a.cid, sizeBytes: a.sizeBytes, mimeType: a.mimeType, timestamp: a.timestamp, uploaderPub: a.uploaderPub };
        this.fileIndex.set(record.cid, record);
        this.net.saveFileIndexRecord(record);
      }
      this.emit('file:index-updated');
    });

    // Kick off country-code lookup early so it's ready before the first heartbeat fires.
    getCountryCode().catch(() => {});

    // Re-announce own tracked files after mesh forms so late joiners get the index
    setTimeout(() => this.reannounceTrackedFiles(), 5_000);

    // On restart, gossip live storage stats to all peers so free-space is accurate
    // immediately without waiting for the next 4h heartbeat block.
    setTimeout(async () => {
      for (const [pub, keys] of this.localKeys) {
        const provider = this.ledger.storageProviders.get(pub);
        if (!provider || provider.capacityGB === 0) continue;
        await this.broadcastStorageStats(pub, keys).catch(() => {});
      }
    }, 5_000);

    // Re-announce file index whenever a new peer connects so late-joining nodes
    // build their index without waiting for the next node restart.
    this.net.on('peer:connected', () => {
      if (this.reannounceDebounce) clearTimeout(this.reannounceDebounce);
      this.reannounceDebounce = setTimeout(() => this.reannounceTrackedFiles(), 3_000);
    });

    // When circuit-relay addresses first become available, re-trigger distribution
    // for any CIDs that were published before the relay was established. Providers
    // couldn't reach the uploader via WebRTC until the relay reservation completed.
    // Also reset stuck-count backoff so files that accumulated retries before the relay
    // was ready get retried promptly instead of waiting up to 5 minutes.
    this.net.on('relay:addresses-ready', () => {
      this.cidStuckCount.clear();
      setTimeout(() => this.retryUnconfirmedDistributions(), 3_000);
    });

    // Retry pending CIDs whenever a new provider registers (covers the case where
    // files were uploaded before any provider was available).
    this.ledger.on('storage:registered', () => {
      setTimeout(() => this.retryPendingDistributions(), 2_000);
    });

    // Re-trigger distribution whenever a provider heartbeat arrives — heartbeat blocks
    // carry the provider's current smoke address, so they are the signal that a provider
    // is reachable again after a relay reconnect. Reset stuck counts so the backoff
    // doesn't delay the retry that now has a chance of working.
    this.ledger.on('storage:heartbeat', () => {
      this.cidStuckCount.clear();
      setTimeout(() => this.retryUnconfirmedDistributions(), 2_000);
    });

    // Retry all unconfirmed distributions every 30s. Covers the case where the
    // GossipSub mesh wasn't fully formed when the cache request was first published
    // (fire-and-forget messages are lost if no peers were in the mesh at that moment).
    this.retryInterval = setInterval(() => this.retryUnconfirmedDistributions(), 30_000);

    // Schedule the first heartbeat with jitter, then repeat
    this.scheduleNextHeartbeat();

    // Check daily reward eligibility every 30 min
    this.rewardInterval = setInterval(() => this.issueRewardsIfEligible(), rewardCheckMs());
    // Also check immediately on start (catches missed day-boundary events)
    setTimeout(() => this.issueRewardsIfEligible(), 5_000);

    // Spot checks reschedule themselves at a population-scaled, jittered cadence
    // rather than on a fixed timer — see scheduleNextSpotCheck.
    this.scheduleNextSpotCheck();

    // Refresh heartbeat counts and scores every 30 min so uptime % stays live as the
    // 24h rolling window moves, without waiting for a new heartbeat block to arrive.
    this.statsRefreshInterval = setInterval(() => {
      this.ledger.refreshHeartbeatCounts();
      this.emit('storage:providers-updated');
    }, rewardCheckMs());

    // Periodically re-announce own files so any peer that missed the original gossip
    // receives it without needing a page reload or reconnect.
    this.reannounceInterval = setInterval(() => this.reannounceTrackedFiles(), 5 * 60 * 1000);

    console.log('[StorageManager] Started');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.rewardInterval) { clearInterval(this.rewardInterval); this.rewardInterval = null; }
    if (this.spotCheckTimer) { clearTimeout(this.spotCheckTimer); this.spotCheckTimer = null; }
    if (this.statsRefreshInterval) { clearInterval(this.statsRefreshInterval); this.statsRefreshInterval = null; }
    if (this.reannounceInterval) { clearInterval(this.reannounceInterval); this.reannounceInterval = null; }
    if (this.retryInterval) { clearInterval(this.retryInterval); this.retryInterval = null; }
    if (this.reannounceDebounce) { clearTimeout(this.reannounceDebounce); this.reannounceDebounce = null; }
    console.log('[StorageManager] Stopped');
  }

  /** Wipe all in-memory distribution state — call on testnet reset before page reload. */
  resetState(): void {
    this.trackedCids.clear();
    this.cidToSmokeAddrs.clear();
    this.cidStuckCount.clear();
    this.receipts.clear();
    this.fileIndex.clear();
    this.signals.clear();
  }

  // ── Message signing ───────────────────────────────────────────────────────
  //
  // Storage gossip is signed with the ENGINE key, verified against the account's
  // engine id — the `026ed9e5…` compressed-hex pub that is the account's actual
  // identity everywhere else in the system.
  //
  // It used to use the app's `signData`/`verifySignature`, whose verifier
  // imports the pub as a base64 JWK. Once accounts moved onto the engine, every
  // `uploaderPub`/`ownerPub`/`providerPub` on the wire became engine hex, and
  // `atob(hex)` cannot yield a JWK — so EVERY signed storage message failed
  // verification, silently, in a `catch` that returned "invalid signature".
  //
  // What that actually broke: providers rejected every CacheRequest, so no
  // content was ever distributed to anyone; relays rejected every file
  // announcement, so the file index stayed empty; and nodes rejected every
  // receipt, so latency and spot-check never left "—". Found 2026-08-16 while
  // Lucian was asking why a 101 MB upload never reached the second device.
  //
  // The signature itself was always fine: the app and engine keys are the same
  // P-256 scalar and signatures interoperate in both directions
  // (`key-bridge.test.ts`). Only the key FORMAT the verifier was handed was
  // wrong, which is why nothing threw — it just never matched.

  /** Sign a storage-gossip payload with the engine key derived from an app keypair. */
  private signMsg(payload: string, keys: KeyPair): string {
    return engineSign(payload, engineKeysFromAppPrivate(keys.priv).priv);
  }

  /** Verify a storage-gossip payload against an account's engine id. */
  private verifyMsg(signature: unknown, payload: string, enginePub: string): boolean {
    if (typeof signature !== 'string' || !signature) return false;
    return engineVerify(signature, payload, enginePub);
  }

  // ── Custody: who counts, and what to do about it ──────────────────────────

  /**
   * Holders of a CID whose custody lease is live.
   *
   * The ONLY count allowed to satisfy a redundancy target. `confirmedProviders`
   * accumulates everyone who ever confirmed holding the CID, and a provider that
   * stopped renewing its lease half a day ago is still in there — counting it
   * reports the object as replicated while the network has already re-homed its
   * share, so the first real failure drops below the threshold that was supposedly
   * met. See ARCHITECTURE.md → "Only verified-live replicas count toward the target".
   */
  private liveHolderCount(confirmed: Iterable<string>, now = Date.now()): number {
    return liveHolders(confirmed, pub => this.ledger.isProviderLive(pub, now)).length;
  }

  /**
   * Repair driven by a failed read, not by a watcher.
   *
   * Continuous monitoring of every holder costs `O(watchers × watched)`;
   * noticing at the moment a fetch fails costs `O(actual use)` and finds exactly
   * the failures a reader cares about (ARCHITECTURE.md → Fan-IN, principle 3).
   *
   * Two different nodes can be here. The OWNER holds the bytes and can re-place
   * them, so it clears the backoff and re-replicates immediately. A reader holds
   * nothing and cannot repair anything — what it can do is stop routing to a
   * source that just failed it, which is the other half of verifying on use.
   */
  private repairOnReadFailure(cid: string): void {
    this.cidToSmokeAddrs.delete(cid);        // every known source failed; re-learn them

    const tracked = this.trackedCids.get(cid);
    if (!tracked || !this.localKeys.has(tracked.ownerPub)) return;

    this.cidStuckCount.delete(cid);          // a real failure outranks any backoff
    tracked.lastDistributed = 0;
    console.warn(`[StorageManager] Read failed for ${cid.slice(0, 16)}… — repairing now `
      + `(${this.liveHolderCount(tracked.confirmedProviders)} live holder(s))`);
    setTimeout(() => this.retryUnconfirmedDistributions(), 1_000);
  }

  /**
   * Reclaim a local provider whose lease lapsed while it was away.
   *
   * Replaces an auto-deregister on a private 24h rule. Deregistering was the
   * wrong verb twice over: the lease already stops a silent node from counting
   * (nothing has to notice it left), and it left the actual problem in place —
   * a disk full of content the network re-homed hours ago, which consumes the
   * capacity being re-advertised for CURRENT assignments and inflates apparent
   * redundancy with copies nobody is counting on. So the node keeps its
   * registration and throws out the bytes, then refills from declared capacity
   * as the network assigns to it. Inside the lease a restart costs no
   * re-transfer at all. Policy + tests: custody.ts → planRejoin.
   */
  async reclaimLapsedLeases(): Promise<void> {
    if (!this.store.isStarted()) return;
    const now = Date.now();

    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      if (!this.servesFromThisDevice(pub)) continue;   // fails closed — see servesFromThisDevice

      // The lease runs from the last renewal, or from registration if it has
      // never renewed — the same clock `ProviderLedger.isLive` reads.
      const since = provider.lastHeartbeat > 0 ? provider.lastHeartbeat : provider.registeredAt;
      const plan = planRejoin({ offlineMs: now - since, held: await this.store.listCached() });
      if (plan.discard.length === 0) continue;

      console.log(`[StorageManager] Rejoin ${pub.slice(0, 12)}…: ${plan.reason}`);
      // `listCached()` is foreign content only — a node's own uploads live under
      // /blocks/ without a /cached/ marker — so this never touches the CIDs this
      // node is the owner and distributor of.
      for (const cid of plan.discard) {
        await this.store.deleteBlock(cid).catch(() => {});
        this.signals.forget(cid);
      }
      // Free space changed; peers price selection on it, so say so now rather
      // than at the next 4h heartbeat.
      await this.broadcastStorageStats(pub, keys).catch(() => {});
      this.emit('storage:providers-updated');
    }
  }

  /**
   * Reschedule the spot-check sweep at a cadence that scales with the provider
   * population, jittered.
   *
   * A fixed timer is fine on a two-relay dev network and is exactly the shape
   * that must not survive contact with scale: every client on the same 60-minute
   * interval synchronises into a thundering herd against the same providers, and
   * the load a popular provider must ANSWER grows with the network even though
   * nothing it HOLDS does. See custody.ts → pollIntervalMs.
   */
  private scheduleNextSpotCheck(): void {
    if (!this.started) return;
    const population = this.ledger.getStorageProviders().length;
    const delay = pollIntervalMs(spotCheckBaseMs(), population);
    this.spotCheckTimer = setTimeout(() => {
      this.runSpotChecks()
        .catch(() => {})
        .finally(() => this.scheduleNextSpotCheck());
    }, delay);
  }

  // ── Heartbeats ────────────────────────────────────────────────────────────

  private scheduleNextHeartbeat(): void {
    if (!this.started) return;
    let minDueIn = HEARTBEAT_INTERVAL_MS;

    for (const [pub] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      if (!this.servesFromThisDevice(pub)) continue;   // fails closed — see servesFromThisDevice
      if (provider.lastHeartbeat === 0) {
        minDueIn = 0; // first-ever heartbeat — fire promptly
      } else {
        const elapsed = Date.now() - provider.lastHeartbeat;
        const dueIn = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);
        minDueIn = Math.min(minDueIn, dueIn);
      }
    }

    const jitter = Math.random() * jitterMs();

    if (minDueIn === 0) {
      // Past-due or first-ever heartbeat: wait for the first peer to connect before firing.
      // This gives any un-persisted heartbeat block time to sync back from peers,
      // preventing a conflict with a block that was sent but not yet written to IDB.
      // Hard cap of 45s in case the node stays offline.
      let fired = false;
      const fire = async () => {
        if (fired || !this.started) return;
        fired = true;
        this.net.off('peer:connected', fire);
        if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
        try {
          await this.broadcastHeartbeatsForAll();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[StorageManager] Heartbeat broadcast failed: ${msg}`);
        }
        this.scheduleNextHeartbeat();
      };
      this.net.on('peer:connected', fire);
      this.heartbeatTimer = setTimeout(fire, Math.min(45_000, HEARTBEAT_INTERVAL_MS / 4));
    } else {
      this.heartbeatTimer = setTimeout(async () => {
        try {
          await this.broadcastHeartbeatsForAll();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[StorageManager] Heartbeat broadcast failed: ${msg}`);
        }
        this.scheduleNextHeartbeat();
      }, minDueIn + jitter);
    }
  }

  /** Cancel the current heartbeat timer and reschedule based on current lastHeartbeat values.
   *  Call after chain replay so the timer reflects actual on-chain timing, not startup time. */
  rescheduleHeartbeat(): void {
    if (!this.started) return;
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    // Called once keys are registered, which is the first moment this is
    // answerable — and the last moment before a user starts wondering why
    // nothing is happening.
    for (const [pub] of this.localKeys) {
      if (!this.registeredOnAnotherDevice(pub)) continue;
      const p = this.ledger.storageProviders.get(pub);
      console.warn(`[StorageManager] ${pub.slice(0, 12)}… is registered as a provider on a DIFFERENT device `
        + `(${p?.deviceId?.slice(0, 8)}… vs ${getDeviceId().slice(0, 8)}…) — it will not heartbeat, earn or `
        + `cache from here. Re-register on this device to take over custody.`);
      this.emit('storage:other-device', { pub });
    }
    this.scheduleNextHeartbeat();
  }

  private async broadcastHeartbeatsForAll(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      if (!this.servesFromThisDevice(pub)) continue;   // fails closed — see servesFromThisDevice
      await this.broadcastHeartbeat(pub, keys);
    }
  }

  async broadcastHeartbeat(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    // The automatic path skips a provider registered on another device; the
    // manual button did not, so it could append to a chain another device is
    // actively extending. Nothing forked in practice only because the interval
    // check refused it — had the other device been quiet for one interval, this
    // would have built on a possibly-stale head and forked the account, which is
    // indistinguishable from a deliberate double-sign and freezes it network-wide.
    //
    // Refusing here also makes the per-device rule discoverable at the exact
    // moment someone tries to work around it.
    if (this.registeredOnAnotherDevice(pub)) {
      return {
        success: false,
        error: 'This account is registered as a provider on another device. '
          + 'Storage custody is per-device — re-register here to take it over.',
      };
    }
    const smokeAddr = await this.store.getSmokeHostname();
    const actualStoredBytes = this.store.isStarted() ? await this.store.storageUsedBytes() : 0;
    const countryCode = await getCountryCode();
    // localKeys holds app (WebCrypto JWK) keys; the engine signs with its own.
    const result = await this.ledger.createStorageHeartbeat(
      pub, engineKeysFromAppPrivate(keys.priv), smokeAddr, actualStoredBytes, countryCode,
    );
    if (!result.block) return { success: false, error: result.error };
    const submitResult = await this.submitBlock(result.block);
    if (submitResult.success) {
      console.log(`[StorageManager] Heartbeat broadcast for ${pub.slice(0, 12)}...`);
      this.emit('storage:heartbeat-sent', { pub });
    }
    return submitResult;
  }

  /**
   * Gossip the current actual storage bytes to all peers without creating a heartbeat block.
   * Does not affect scoring or rewards — purely a stat update so free-space stays accurate
   * after restarts, registrations, and uploads.
   */
  async broadcastStorageStats(pub: string, keys: KeyPair): Promise<void> {
    if (!this.store.isStarted() || !this.net.running) return;
    const actualBytes = await this.store.storageUsedBytes();
    const provider = this.ledger.storageProviders.get(pub);
    if (provider) provider.lastActualStoredBytes = actualBytes;
    const ts = Date.now();
    const sig = this.signMsg(`stats:${pub}:${actualBytes}:${ts}`, keys);
    this.net.publishStorageReceipt({
      cid: pub, providerPub: pub, requesterPub: pub,
      latencyMs: 0, success: true, timestamp: ts, signature: sig,
      actualStoredBytes: actualBytes,
    });
  }

  /** Broadcast storage stats for all local providers. Used when pub/keys are not in scope. */
  async broadcastStorageStatsForLocalProviders(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      await this.broadcastStorageStats(pub, keys).catch(() => {});
    }
  }

  // ── Daily rewards ─────────────────────────────────────────────────────────

  async issueRewardsIfEligible(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const provider = this.ledger.storageProviders.get(pub);
      if (!provider || provider.capacityGB === 0) continue;
      // Rewards settle a day behind — the running day's uptime isn't known yet
      // (see claimableEpochDay). Comparing against the *current* day here would
      // leave this polling every 30 min for a claim that is already made.
      const epochDay = claimableEpochDay(Date.now());
      if (provider.lastRewardEpoch >= epochDay) continue;

      const result = await this.ledger.createStorageReward(pub, engineKeysFromAppPrivate(keys.priv));
      if (!result.block) {
        // Not yet eligible (no heartbeats today, or already claimed) - log and continue
        continue;
      }
      const submitResult = await this.submitBlock(result.block);
      if (submitResult.success) {
        const amount = Number(result.block.amount ?? 0);
        console.log(`[StorageManager] Reward issued: ${amount} milli-UNIT for ${pub.slice(0, 12)}...`);
        this.emit('storage:reward-issued', { pub, amount, epochDay });
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Build the list of smoke addresses to include as fallback sources in a CacheRequest.
   * Combines confirmed-provider addresses (from receipts) with the smoke addresses of
   * ALL registered providers so that a provider who missed the uploader can still pull
   * from any peer that already cached the content — even if its receipt never arrived.
   * Excludes the uploader's own address and any provider on this physical device to
   * prevent a provider from trying to fetch a block from itself.
   */
  private buildFallbackAddrs(cid: string, excludeAddr?: string): string[] {
    const confirmed = Array.from(this.cidToSmokeAddrs.get(cid) ?? []);
    const localDeviceId = getDeviceId();
    const allProviderAddrs = this.ledger.getStorageProviders()
      .filter(p => p.smokeAddr && p.smokeAddr !== excludeAddr &&
        (!p.deviceId || p.deviceId !== localDeviceId))
      .map(p => p.smokeAddr!);
    const combined = [...new Set([...confirmed, ...allProviderAddrs])];
    return excludeAddr ? combined.filter(a => a !== excludeAddr) : combined;
  }

  /**
   * Push blocks directly to providers via outbound WebRTC (uploader→provider).
   * Outbound connections from a device behind strict NAT succeed because the
   * provider (typically a desktop) has a STUN-reachable address, whereas
   * inbound connections to mobile fail (provider cannot initiate back to mobile).
   * This is the primary mechanism for distributing content from mobile uploaders.
   */
  private async pushBlocksToProviders(
    cid: string,
    additionalCids: string[],
    providers: StorageProvider[],
    ownerPub?: string,
    perBlockTimeoutMs = 20_000,
  ): Promise<void> {
    // Smoke HTTP POST times out for large payloads (~4s internal limit).
    // Only push small blocks (manifest JSON, small content). Large chunks
    // (8 MB OPFS slices) must be pulled by the provider via GET instead.
    const MAX_PUSH_BYTES = 1 * 1024 * 1024; // 1 MB
    const allCids = [cid, ...additionalCids];
    await Promise.allSettled(providers.map(async provider => {
      if (!provider.smokeAddr) return;
      for (const c of allCids) {
        const data = await this.store.getBlock(c);
        if (!data) { console.warn(`[StorageManager] Push: block ${c.slice(0, 16)}… not found locally`); continue; }
        if (data.byteLength > MAX_PUSH_BYTES) {
          console.log(`[StorageManager] Push: skipping ${c.slice(0, 16)}… (${(data.byteLength / 1_048_576).toFixed(1)} MB — provider will pull)`);
          continue;
        }
        try {
          await this.store.pushBlock(provider.smokeAddr, c, data, ownerPub, perBlockTimeoutMs);
          console.log(`[StorageManager] Pushed ${c.slice(0, 16)}… to ${provider.pub.slice(0, 12)}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[StorageManager] Push to ${provider.pub.slice(0, 12)} failed: ${msg}`);
        }
      }
    }));
  }

  // ── Provider selection ────────────────────────────────────────────────────

  /**
   * Select up to `count` storage providers with geographic diversity priority.
   *
   * Strategy: round-robin across distinct country codes, picking one provider
   * per country per round (weighted random within each country group). Once
   * every country has contributed a provider, a second round begins — and so on
   * until `count` is reached or all candidates are exhausted. Providers whose
   * country is unknown are grouped together and treated as a single bucket.
   *
   * This maximises the number of distinct countries in the result set before
   * filling remaining slots with same-country providers.
   *
   * Weight = min(capacityGB, 100) × max(0.1, score). Local device excluded.
   */
  selectProviders(count: number): StorageProvider[] {
    const localDeviceId = getDeviceId();
    const allProviders = this.ledger.getStorageProviders();
    const now = Date.now();
    // Selection is a CUSTODY question — these providers are being asked to take
    // responsibility for a replica — so the filter is the LEASE, not a private
    // 24h staleness rule. A node that stopped renewing is not somewhere content
    // can live, whatever capacity it once declared.
    //
    // Right after start we haven't received a full heartbeat cycle of gossip yet,
    // so a provider loaded from IDB can look lapsed while actually being online.
    // Skip the filter during a one-interval warmup rather than wrongly excluding
    // live providers; discovery (GET /providers) usually refreshes this sooner.
    const inWarmup = this.startedAt > 0 && now - this.startedAt < HEARTBEAT_INTERVAL_MS;
    const candidates = allProviders.filter(p => {
      if (p.deviceId && p.deviceId === localDeviceId) return false;
      if (!inWarmup && !this.ledger.isProviderLive(p.pub, now)) return false;
      return true;
    });

    console.log(`[StorageManager] selectProviders: ${allProviders.length} total, ${candidates.length} remote candidates (want ${count})`);
    if (candidates.length > 0) {
      console.log(`[StorageManager] selectProviders candidates:`, candidates.map(p =>
        `${p.pub.slice(0, 12)}… cap=${p.capacityGB}GB score=${p.score.toFixed(3)} country=${p.countryCode ?? '?'}`));
    }

    if (candidates.length === 0) return [];

    const take = Math.min(count, candidates.length);

    // Group candidates by country; unknown country gets its own '__' bucket.
    const byCountry = new Map<string, StorageProvider[]>();
    for (const p of candidates) {
      const cc = p.countryCode ?? '__';
      const group = byCountry.get(cc) ?? [];
      group.push(p);
      byCountry.set(cc, group);
    }

    // Weighted-random pick from a group, skipping already-selected pubs.
    const usedPubs = new Set<string>();
    const pickWeighted = (group: StorageProvider[]): StorageProvider | undefined => {
      const pool = group.filter(p => !usedPubs.has(p.pub));
      if (pool.length === 0) return undefined;
      const weights = pool.map(p => Math.max(0.01, Math.min(p.capacityGB, 100) * Math.max(0.1, p.score)));
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      for (let i = 0; i < pool.length; i++) {
        r -= weights[i];
        if (r <= 0) return pool[i];
      }
      return pool[pool.length - 1];
    };

    // Round-robin: each round picks one provider per distinct country.
    const selected: StorageProvider[] = [];
    while (selected.length < take) {
      let addedThisRound = 0;
      for (const group of byCountry.values()) {
        if (selected.length >= take) break;
        const picked = pickWeighted(group);
        if (picked) { selected.push(picked); usedPubs.add(picked.pub); addedThisRound++; }
      }
      if (addedThisRound === 0) break; // all candidates exhausted
    }

    return selected;
  }

  // ── Content distribution ──────────────────────────────────────────────────

  /** Retry distribution for CIDs that failed earlier because no providers existed. */
  private async retryPendingDistributions(): Promise<void> {
    if (this.pendingCids.size === 0) return;
    if (this.selectProviders(1).length === 0) return;

    for (const [cid, { ownerPub, additionalCids }] of this.pendingCids) {
      const keys = this.localKeys.get(ownerPub);
      if (!keys) continue;
      const result = await this.distributeContent(cid, ownerPub, keys, additionalCids);
      if (result.providers.length > 0) {
        this.pendingCids.delete(cid);
        console.log(`[StorageManager] Retried distribution for ${cid.slice(0, 16)}... → ${result.providers.length} providers`);
      }
    }
  }

  /** Resend cache requests for CIDs that have no confirmed provider yet, or are under-replicated. */
  private async retryUnconfirmedDistributions(): Promise<void> {
    if (this.trackedCids.size === 0) return;
    if (this.selectProviders(1).length === 0) return;
    const now = Date.now();
    for (const [cid, tracked] of this.trackedCids) {
      // Durability is measured on LIVE leases only. `confirmedProviders` never
      // shrinks by itself, so counting it would keep reporting a full replica set
      // long after the holders in it stopped renewing — and the object would sit
      // one honest failure away from loss while looking healthy.
      const target = Math.min(this.signals.targetFor(cid), MAX_REPLICA_TARGET);
      const live = this.liveHolderCount(tracked.confirmedProviders, now);
      if (live >= target) continue;

      // Exponential backoff: each cycle without new confirmations doubles the wait,
      // capping at 5 min. This prevents flooding providers that consistently fail.
      const stuckCount = this.cidStuckCount.get(cid) ?? 0;
      const minWaitMs = Math.min(25_000 * Math.pow(2, stuckCount), 5 * 60_000);
      if (now - tracked.lastDistributed < minWaitMs) continue;

      const keys = this.localKeys.get(tracked.ownerPub);
      if (!keys) continue;

      // `planRepair` decides both halves: which holders' leases have lapsed (drop
      // them, or the set grows without bound as the fleet churns) and how many of
      // the offered candidates the shortfall actually needs. Selection runs ONCE —
      // it is randomised (weighted by capacity × score, spread by country), so a
      // second call would return a different set and the plan would name providers
      // that are no longer on offer.
      const offered = this.selectProviders(target);
      const plan = planRepair({
        holders: tracked.confirmedProviders,
        isLive: pub => this.ledger.isProviderLive(pub, now),
        candidates: offered.map(p => p.pub),
        target,
      });
      for (const gone of plan.drop) tracked.confirmedProviders.delete(gone);
      if (plan.drop.length > 0) {
        console.log(`[StorageManager] Lease lapsed for ${plan.drop.length} holder(s) of ${cid.slice(0, 16)}… — re-homing`);
      }
      const chosen = new Set(plan.add);
      const additional = offered.filter(p => chosen.has(p.pub));
      if (additional.length === 0) continue;

      tracked.lastDistributed = now;
      const ts = Date.now();
      const payload = `cache:${cid}:${tracked.ownerPub}:${ts}`;
      const sig = this.signMsg(payload, keys);
      const uploaderSmokeAddr = await this.store.getSmokeHostname();
      // Include ALL registered provider smoke addresses, not just confirmed ones.
      // This lets providers pull from any peer that already cached the content even
      // if that peer's receipt hasn't reached us yet (e.g. due to relay instability).
      const fallbackAddrs = this.buildFallbackAddrs(cid, uploaderSmokeAddr);
      this.net.publishCacheRequest({
        cid,
        additionalCids: tracked.additionalCids.length > 0 ? tracked.additionalCids : undefined,
        targetProviders: additional.map(p => p.pub),
        uploaderPub: tracked.ownerPub,
        uploaderSmokeAddr,
        timestamp: ts,
        signature: sig,
        confirmedProviderCount: live,
        redundancyTarget: target,
        confirmedProviderSmokeAddrs: fallbackAddrs.length > 0 ? fallbackAddrs : undefined,
      });
      // Push blocks directly — critical when pull model fails due to NAT
      this.pushBlocksToProviders(cid, tracked.additionalCids, additional, tracked.ownerPub).catch(() => {});
      console.log(`[StorageManager] Re-replication: ${cid.slice(0, 16)}... at ${live}/${target} live `
        + `(${tracked.confirmedProviders.size} confirmed ever) → adding ${additional.length} providers `
        + `(${fallbackAddrs.length} fallback addr(s), wait was ${(minWaitMs / 1000).toFixed(0)}s)`);

      // Grow the backoff on every cycle that ends here. A cycle only ends here
      // when the CID is still short of its target, and `handleReceipt` clears the
      // counter the moment a new holder confirms — so the wait stretches exactly
      // while nothing is working, and snaps back as soon as something does.
      this.cidStuckCount.set(cid, stuckCount + 1);
    }
  }

  /**
   * Distribute stored CIDs to up to `replicaTarget` providers.
   * `cid` is the primary (meta) CID; `additionalCids` are bundled in the same cache
   * request so providers cache both the envelope and the content block together.
   *
   * Returning does NOT mean the content is safe — see `awaitHandoff`. Until
   * `MIN_REPLICAS` live leases confirm, the uploader's copy is the only one and
   * this CID is *staging*.
   */
  async distributeContent(
    cid: string,
    uploaderPub: string,
    keys: KeyPair,
    additionalCids: string[] = [],
  ): Promise<{ providers: string[]; error?: string }> {
    console.log(`[StorageManager] distributeContent: cid=${cid.slice(0, 20)}… additionalCids=${additionalCids.length} uploader=${uploaderPub.slice(0, 12)}…`);

    const existing = this.trackedCids.get(cid);
    const target = Math.min(this.signals.targetFor(cid), MAX_REPLICA_TARGET);
    const alreadyLive = existing ? this.liveHolderCount(existing.confirmedProviders) : 0;

    // Already fully replicated — nothing to do. Live leases, not confirmations
    // ever received: the second is a memory, only the first is custody.
    if (alreadyLive >= target) {
      console.log(`[StorageManager] distributeContent: ${cid.slice(0, 16)}... already at ${alreadyLive}/${target} live — skipping`);
      return { providers: Array.from(existing!.confirmedProviders) };
    }

    const providers = this.selectProviders(target);
    if (providers.length === 0) {
      // Staging, not failure. The bytes exist only here, so the CID must be
      // recorded durably and retried — a purely in-memory note is destroyed by
      // the tab close that this whole handoff exists to survive.
      console.warn(`[StorageManager] distributeContent: no live providers — ${cid.slice(0, 16)}… is STAGING on this device only`);
      this.pendingCids.set(cid, { ownerPub: uploaderPub, additionalCids });
      this.stage(cid, uploaderPub, additionalCids);
      return { providers: [], error: 'No storage providers available - content stored locally only' };
    }

    const ts = Date.now();
    const payload = `cache:${cid}:${uploaderPub}:${ts}`;
    const signature = this.signMsg(payload, keys);

    const uploaderSmokeAddr = await this.store.getSmokeHostname();
    console.log(`[StorageManager] distributeContent: uploaderSmokeAddr=${uploaderSmokeAddr ?? '(none)'} publishing CacheRequest to ${providers.length} providers: ${providers.map(p => p.pub.slice(0, 12)).join(', ')}`);

    const confirmedSmokeAddrs = this.buildFallbackAddrs(cid, uploaderSmokeAddr);
    const request: CacheRequest = {
      cid,
      additionalCids: additionalCids.length > 0 ? additionalCids : undefined,
      targetProviders: providers.map(p => p.pub),
      uploaderPub,
      uploaderSmokeAddr,
      timestamp: ts,
      signature,
      confirmedProviderCount: alreadyLive,
      redundancyTarget: target,
      confirmedProviderSmokeAddrs: confirmedSmokeAddrs.length > 0 ? confirmedSmokeAddrs : undefined,
    };

    this.net.publishCacheRequest(request);

    // Push blocks directly to every provider — fire and forget, don't await.
    // Outbound WebRTC (uploader→provider) works even from mobile behind strict NAT;
    // the pull model (provider→uploader) fails when the uploader is behind a relay
    // that drops before the WebRTC data channel is established.
    this.pushBlocksToProviders(cid, additionalCids, providers, uploaderPub).catch(() => {});

    // Preserve existing confirmed providers — don't reset them on re-distribution.
    const entry = existing ?? { ownerPub: uploaderPub, confirmedProviders: new Set<string>(), additionalCids, lastDistributed: Date.now() };
    entry.lastDistributed = Date.now();
    this.trackedCids.set(cid, entry);
    this.net.saveTrackedCid({ cid, ownerPub: uploaderPub, confirmedProviders: Array.from(entry.confirmedProviders), additionalCids, lastDistributed: entry.lastDistributed });

    console.log(`[StorageManager] Cache request published for ${cid.slice(0, 16)}... (+${additionalCids.length} extra) to ${providers.length} providers`);
    return { providers: providers.map(p => p.pub) };
  }

  // ── Publish handoff ───────────────────────────────────────────────────────
  //
  // A publish is not complete when the upload finishes. It is complete when the
  // network confirms `MIN_REPLICAS` LIVE holders. Until then the uploader's copy
  // is the only one in existence, so the content is *staging*: it must be
  // recorded durably and retried, or closing the tab right after an upload
  // destroys it. After the handoff the author's device may vanish permanently
  // with no loss — which is the entire point of the arrangement, and the reason
  // authorship grants no custody exemption (ARCHITECTURE.md → Subsystem 4).

  /** Record a CID as staging: owned, held only here, and needing retry across restarts. */
  private stage(cid: string, ownerPub: string, additionalCids: string[]): void {
    const entry = this.trackedCids.get(cid)
      ?? { ownerPub, confirmedProviders: new Set<string>(), additionalCids, lastDistributed: 0 };
    this.trackedCids.set(cid, entry);
    this.net.saveTrackedCid({
      cid, ownerPub, additionalCids,
      confirmedProviders: Array.from(entry.confirmedProviders),
      lastDistributed: entry.lastDistributed,
    });
    this.emit('storage:staging', { cid, live: this.liveHolderCount(entry.confirmedProviders) });
  }

  /**
   * Has the network taken custody of this CID? True once `MIN_REPLICAS` holders
   * with a LIVE lease have confirmed it.
   *
   * `MIN_REPLICAS` rather than `REDUNDANCY_TARGET`: the target is where repair
   * steadies out, this is the point at which losing the uploader stops being
   * fatal. Waiting for the full target before releasing the uploader would block
   * on a fleet that may simply not be that large yet.
   */
  isHandedOff(cid: string): boolean {
    const tracked = this.trackedCids.get(cid);
    if (!tracked) return false;
    return this.liveHolderCount(tracked.confirmedProviders) >= MIN_REPLICAS;
  }

  /** CIDs this node owns that the network has not taken custody of yet. */
  stagingCids(): string[] {
    return [...this.trackedCids.keys()].filter(cid => !this.isHandedOff(cid));
  }

  /**
   * Resolve once the network has taken custody, or on timeout.
   *
   * Callers must treat `handedOff: false` as "the content still lives only on
   * this device" — not as an error. The retry loop keeps working either way; the
   * distinction only decides whether it is safe to tell the user they can leave.
   */
  async awaitHandoff(cid: string, timeoutMs = 60_000): Promise<{ handedOff: boolean; live: number }> {
    const deadline = Date.now() + timeoutMs;
    const live = () => this.liveHolderCount(this.trackedCids.get(cid)?.confirmedProviders ?? []);
    while (Date.now() < deadline) {
      const n = live();
      if (n >= MIN_REPLICAS) {
        this.emit('storage:handoff-complete', { cid, live: n });
        return { handedOff: true, live: n };
      }
      await new Promise(r => setTimeout(r, 1_000));
    }
    return { handedOff: false, live: live() };
  }

  // ── Pin request handling (provider side) ─────────────────────────────────

  private async handleCacheRequest(req: CacheRequest): Promise<void> {
    // Reject if the uploader reports the file already has its full set of live
    // holders. The target travels with the request because demand is observed by
    // the owner (custody.ts → replicaTarget); it is clamped here because it is a
    // number an attacker writes, and an unbounded one would conscript capacity.
    const askedTarget = typeof req.redundancyTarget === 'number' && Number.isFinite(req.redundancyTarget)
      ? Math.min(Math.max(1, Math.floor(req.redundancyTarget)), MAX_REPLICA_TARGET)
      : REDUNDANCY_TARGET;
    if (typeof req.confirmedProviderCount === 'number' && req.confirmedProviderCount >= askedTarget) {
      console.log(`[StorageManager] handleCacheRequest: ${req.cid.slice(0, 20)}… already at ${req.confirmedProviderCount}/${askedTarget} live holders — ignoring`);
      return;
    }

    // Check if we are one of the target providers
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => req.targetProviders.includes(pub));
    console.log(`[StorageManager] handleCacheRequest: cid=${req.cid.slice(0, 20)}… targets=${req.targetProviders.length} additionalCids=${req.additionalCids?.length ?? 0} iAmTarget=${!!myProviderPub}`);
    if (!myProviderPub) {
      return;
    }

    const provider = this.ledger.storageProviders.get(myProviderPub);
    if (!provider || provider.capacityGB === 0) {
      return;
    }

    // Only the device that registered should serve - prevents both devices from
    // responding when the same account is loaded on two machines.
    if (!this.servesFromThisDevice(myProviderPub)) return;   // fails closed

    // Verify the uploader's signature
    const payload = `cache:${req.cid}:${req.uploaderPub}:${req.timestamp}`;
    if (!this.verifyMsg(req.signature, payload, req.uploaderPub)) {
      console.warn('[StorageManager] Rejected cache request - invalid signature');
      return;
    }

    // Pin content via smoke Http (HTTP-over-WebRTC). The uploader's smoke Hub address
    // is in req.uploaderSmokeAddr - smoke's Net module uses the hub to exchange WebRTC
    // ICE candidates and establish a direct data-channel connection to the uploader.
    if (!this.store.isStarted()) { console.warn('[StorageManager] SmokeStore not started, cannot cache'); return; }

    // Dedup: if a prior CacheRequest for this primary CID is still in progress (common
    // when re-replication fires before a slow large-file download completes), ignore the
    // duplicate so we don't download the same 8 MB chunks twice over the same relay link.
    if (this.cachingInProgress.has(req.cid)) {
      console.log(`[StorageManager] handleCacheRequest: ${req.cid.slice(0, 16)}… already caching, skipping duplicate`);
      return;
    }
    this.cachingInProgress.add(req.cid);

    const allCids = [req.cid, ...(Array.isArray(req.additionalCids) ? req.additionalCids : [])];
    // Filter our own smoke address out of the fallback list to prevent self-fetch.
    // This is possible when this node is both a provider and was previously confirmed
    // for a different CID (so its address appeared in buildFallbackAddrs output).
    const myProviderSmokeAddr = await this.store.getSmokeHostname();
    const providedFallbacks = (Array.isArray(req.confirmedProviderSmokeAddrs) ? req.confirmedProviderSmokeAddrs as string[] : [])
      .filter(a => a !== myProviderSmokeAddr && a !== req.uploaderSmokeAddr);
    console.log(`[StorageManager] handleCacheRequest: starting cache of ${allCids.length} CID(s) via smokeAddr=${req.uploaderSmokeAddr ?? '(none)'}${providedFallbacks.length ? ` + ${providedFallbacks.length} fallback(s)` : ''}`);

    const errStr = (err: unknown): string => {
      if (err instanceof AggregateError) return '[' + (err.errors as unknown[]).map(e => e instanceof Error ? e.message : String(e)).join('; ') + ']';
      return err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
    };

    try {
      const start = Date.now();
      // A large file is a manifest plus N chunks, and ONE failure used to throw
      // out of this loop — so every later chunk went unattempted and the next
      // retry restarted from the manifest. A 101 MB video therefore sat at
      // 1.2 KB (the manifest alone) across unlimited retries: attempts never
      // accumulated. Found by Lucian, 2026-08-16.
      //
      // Now each CID is independent. Already-held chunks are skipped, so retries
      // get cheaper as they converge, and a flaky link costs one chunk per round
      // instead of the whole transfer.
      const failed: string[] = [];
      let fetched = 0;
      for (const c of allCids) {
        if (await this.store.isCached(c).catch(() => false)) continue;   // keep what we already have
        console.log(`[StorageManager] handleCacheRequest: caching ${c.slice(0, 20)}…`);
        try {
          // 10-minute timeout per chunk — relay connections can be slow (~50 KB/s)
          // and an 8 MB chunk would exceed the old 2-minute limit.
          await this.store.cache(c, 600_000, req.uploaderSmokeAddr as string | undefined, req.uploaderPub as string | undefined, providedFallbacks);
        } catch (primaryErr) {
          // Uploader + provided fallbacks all failed. Try every other known peer address
          // as a last resort — this covers peers that cached the content without their
          // receipt reaching us (e.g. when the uploader's relay was down).
          const broadFallbacks = this.store.getAllPeerFallbacks().filter(
            p => p !== req.uploaderSmokeAddr && !providedFallbacks.includes(p),
          );
          try {
            if (broadFallbacks.length === 0) throw primaryErr;
            console.log(`[StorageManager] handleCacheRequest: primary failed (${errStr(primaryErr)}), trying ${broadFallbacks.length} broad fallback(s)`);
            await this.store.cache(c, 180_000, undefined, req.uploaderPub as string | undefined, broadFallbacks);
          } catch (finalErr) {
            failed.push(c);
            console.warn(`[StorageManager] handleCacheRequest: ${c.slice(0, 20)}… FAILED — ${errStr(finalErr)}`);
            continue;                                  // the next chunk may well succeed
          }
        }
        fetched++;
        console.log(`[StorageManager] handleCacheRequest: cached ${c.slice(0, 20)}… OK`);
      }

      // Custody is all-or-nothing: holding 12 of 14 chunks is not holding the
      // file, and a receipt claiming otherwise would let the uploader count this
      // node as a replica and stop retrying. Say what happened and wait for the
      // next round, which will only have to fetch what is still missing.
      if (failed.length > 0) {
        console.warn(`[StorageManager] handleCacheRequest: ${req.cid.slice(0, 16)}… incomplete — `
          + `${allCids.length - failed.length}/${allCids.length} held, ${failed.length} still missing. `
          + `No receipt published; will retry.`);
        return;
      }
      void fetched;
      const latencyMs = Date.now() - start;
      console.log(`[StorageManager] Cached ${req.cid.slice(0, 16)}... in ${latencyMs}ms`);

      // Record which sub-CIDs belong to this root so clearCached() can count correctly.
      if (req.additionalCids?.length) {
        await this.store.saveCacheGroup(req.cid, req.additionalCids as string[]);
      }

      // Update stored-bytes in-memory immediately so free-space stats are accurate
      // on this node, and include it in the receipt so all other nodes update too.
      const updatedStoredBytes = await this.store.storageUsedBytes();
      if (provider) provider.lastActualStoredBytes = updatedStoredBytes;

      // Emit a receipt so other nodes can update our score and learn our smoke address
      if (this.net.running) {
        const keys = this.localKeys.get(myProviderPub);
        if (keys) {
          const providerSmokeAddr = await this.store.getSmokeHostname();
          const receiptPayload = `receipt:${req.cid}:${myProviderPub}:${myProviderPub}:${latencyMs}:true:${Date.now()}`;
          const sig = this.signMsg(receiptPayload, keys);
          const receipt: StorageReceipt = {
            providerPub: myProviderPub,
            requesterPub: myProviderPub,
            cid: req.cid,
            latencyMs,
            success: true,
            timestamp: Date.now(),
            signature: sig,
            providerSmokeAddr,
            actualStoredBytes: updatedStoredBytes,
          };
          this.net.publishStorageReceipt(receipt);
        }
      }

      this.emit('storage:cached', { pub: myProviderPub, cid: req.cid });
    } catch (err) {
      console.warn(`[StorageManager] Failed to cache ${req.cid.slice(0, 16)}...: ${errStr(err)}`);
    } finally {
      this.cachingInProgress.delete(req.cid);
    }
  }

  // ── Delete request handling ───────────────────────────────────────────────

  private async handleDeleteRequest(req: DeleteRequest): Promise<void> {
    if (!Array.isArray(req.cids) || !req.ownerPub || !req.signature) return;

    const payload = `delete:${req.cids.join(',')}:${req.ownerPub}:${req.timestamp}`;
    if (!this.verifyMsg(req.signature, payload, req.ownerPub)) {
      console.warn('[StorageManager] Rejected delete request - invalid signature');
      return;
    }

    if (!this.store.isStarted()) return;
    for (const cid of req.cids) {
      // Verify the requester is the account that originally uploaded this block.
      // Skip the check if we have no metadata (block wasn't cached by us, or pre-dates this fix).
      const meta = await this.store.getCachedMeta(cid);
      if (meta?.uploaderPub && meta.uploaderPub !== req.ownerPub) {
        console.warn(`[StorageManager] Rejected delete for ${cid.slice(0, 16)}: ownerPub mismatch`);
        continue;
      }
      await this.store.deleteBlock(cid);
    }
    // Remove from tracked CIDs and file index so we stop retrying distribution
    if (req.cids.length > 0) {
      const primaryCid = req.cids[0];
      this.trackedCids.delete(primaryCid);
      this.net.deleteTrackedCid(primaryCid);
      this.signals.forget(primaryCid);
      this.fileIndex.delete(primaryCid);
      this.net.deleteFileIndexRecord(primaryCid);
      this.emit('file:index-updated');
    }
    // Gossip updated storage stats so free-space reflects the freed blocks on all nodes.
    this.broadcastStorageStatsForLocalProviders().catch(() => {});
  }

  // ── Replace request (owner initiates) ────────────────────────────────────

  /**
   * Replace content across the network. Broadcasts a signed ReplaceRequest so
   * every provider holding the old CID drops it and caches the new CID.
   * Also redistributes the new CID to up to REDUNDANCY_TARGET providers.
   * Call storeContent / storeContentPublic first to obtain newCid.
   */
  async replaceContent(
    oldCid: string,
    newCid: string,
    ownerPub: string,
    keys: KeyPair,
    oldAdditionalCids: string[] = [],
    newAdditionalCids: string[] = [],
  ): Promise<{ providers: string[]; error?: string }> {
    const ts = Date.now();
    const payload = `replace:${oldCid}:${newCid}:${ownerPub}:${ts}`;
    const signature = this.signMsg(payload, keys);
    const uploaderSmokeAddr = await this.store.getSmokeHostname();

    const request: ReplaceRequest = {
      oldCid,
      oldAdditionalCids: oldAdditionalCids.length > 0 ? oldAdditionalCids : undefined,
      newCid,
      newAdditionalCids: newAdditionalCids.length > 0 ? newAdditionalCids : undefined,
      ownerPub,
      uploaderSmokeAddr,
      timestamp: ts,
      signature,
    };
    this.net.publishReplaceRequest(request as unknown as Record<string, unknown>);

    // Remove old tracked CID tracking so retries don't re-distribute it
    this.trackedCids.delete(oldCid);
    this.net.deleteTrackedCid(oldCid);
    this.signals.forget(oldCid);
    // Transfer known smoke addresses for the old CID to the new one
    const oldAddrs = this.cidToSmokeAddrs.get(oldCid);
    if (oldAddrs) {
      this.cidToSmokeAddrs.delete(oldCid);
      const newAddrs = this.cidToSmokeAddrs.get(newCid) ?? new Set<string>();
      for (const a of oldAddrs) newAddrs.add(a);
      this.cidToSmokeAddrs.set(newCid, newAddrs);
    }

    // Distribute new content to providers (CacheRequest path)
    const result = await this.distributeContent(newCid, ownerPub, keys, newAdditionalCids);
    console.log(`[StorageManager] Replace broadcast: ${oldCid.slice(0, 16)}… → ${newCid.slice(0, 16)}… (${result.providers.length} providers)`);
    return result;
  }

  // ── Replace request handling (provider side) ──────────────────────────────

  private async handleReplaceRequest(req: ReplaceRequest): Promise<void> {
    if (!req.oldCid || !req.newCid || !req.ownerPub || !req.signature) return;

    const payload = `replace:${req.oldCid}:${req.newCid}:${req.ownerPub}:${req.timestamp}`;
    if (!this.verifyMsg(req.signature, payload, req.ownerPub)) {
      console.warn('[StorageManager] Rejected replace request - invalid signature');
      return;
    }

    if (!this.store.isStarted()) return;

    const oldCids = [req.oldCid, ...(Array.isArray(req.oldAdditionalCids) ? req.oldAdditionalCids : [])];
    const newCids = [req.newCid, ...(Array.isArray(req.newAdditionalCids) ? req.newAdditionalCids : [])];

    // Determine whether we are a provider that had the old content cached
    const myProviderPub = Array.from(this.localKeys.keys()).find(pub => {
      const provider = this.ledger.storageProviders.get(pub);
      return provider && provider.capacityGB > 0;
    });

    let wasProvider = false;
    if (myProviderPub) {
      const localDeviceId = getDeviceId();
      const provider = this.ledger.storageProviders.get(myProviderPub);
      if (provider && (!provider.deviceId || provider.deviceId === localDeviceId)) {
        wasProvider = await this.store.isCached(req.oldCid);
      }
    }

    // Drop all old blocks from local storage (idempotent for non-holders)
    for (const cid of oldCids) {
      await this.store.deleteBlock(cid);
    }

    // Providers that held the old content fetch and cache the new content
    if (wasProvider && myProviderPub) {
      try {
        for (const cid of newCids) {
          await this.store.cache(cid, 600_000, req.uploaderSmokeAddr as string | undefined, req.ownerPub);
        }
        const keys = this.localKeys.get(myProviderPub);
        if (keys && this.net.running) {
          const providerSmokeAddr = await this.store.getSmokeHostname();
          const ts = Date.now();
          const receiptPayload = `receipt:${req.newCid}:${myProviderPub}:${myProviderPub}:0:true:${ts}`;
          const sig = this.signMsg(receiptPayload, keys);
          const receipt: StorageReceipt = {
            providerPub: myProviderPub, requesterPub: myProviderPub,
            cid: req.newCid, latencyMs: 0, success: true,
            timestamp: ts, signature: sig, providerSmokeAddr,
          };
          this.net.publishStorageReceipt(receipt);
        }
        console.log(`[StorageManager] Provider replaced: ${req.oldCid.slice(0, 16)}… → ${req.newCid.slice(0, 16)}…`);
        this.emit('storage:replaced', { pub: myProviderPub, oldCid: req.oldCid, newCid: req.newCid });
        this.broadcastStorageStats(myProviderPub, keys!).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[StorageManager] Failed to cache replacement ${req.newCid.slice(0, 16)}…: ${msg}`);
      }
    }

    // Remove old tracking entry and file index entry if this node was the owner
    const oldTracked = this.trackedCids.get(req.oldCid);
    if (oldTracked && oldTracked.ownerPub === req.ownerPub) {
      this.trackedCids.delete(req.oldCid);
      this.net.deleteTrackedCid(req.oldCid);
      this.signals.forget(req.oldCid);
      this.fileIndex.delete(req.oldCid);
      this.net.deleteFileIndexRecord(req.oldCid);
      this.emit('file:index-updated');
    }
  }

  // ── Receipt handling ──────────────────────────────────────────────────────

  async handleReceipt(receipt: StorageReceipt): Promise<void> {
    console.log(`[StorageManager] handleReceipt: cid=${receipt.cid.slice(0, 20)}… provider=${receipt.providerPub.slice(0, 12)}… success=${receipt.success} latency=${receipt.latencyMs}ms`);
    // Mark provider as confirmed for this CID so we stop retrying
    if (receipt.success) {
      const tracked = this.trackedCids.get(receipt.cid);
      if (tracked) {
        const prevSize = tracked.confirmedProviders.size;
        const wasHandedOff = this.isHandedOff(receipt.cid);
        tracked.confirmedProviders.add(receipt.providerPub);
        this.signals.recordSuccess(receipt.cid, receipt.providerPub);
        this.cidStuckCount.delete(receipt.cid); // new confirmation — reset backoff
        const live = this.liveHolderCount(tracked.confirmedProviders);
        console.log(`[StorageManager] handleReceipt: ${receipt.cid.slice(0, 20)}… now ${live} live holder(s) of ${tracked.confirmedProviders.size} confirmed`);
        // The moment the network takes custody: from here the uploader's device
        // may disappear without losing the content.
        if (!wasHandedOff && live >= MIN_REPLICAS) {
          console.log(`[StorageManager] Handoff complete for ${receipt.cid.slice(0, 16)}… (${live} live holders) — safe to close`);
          this.emit('storage:handoff-complete', { cid: receipt.cid, live });
        }
        // If still under-replicated, reset lastDistributed so the next retry interval
        // fires quickly instead of waiting a full 30s cycle from the original send time.
        if (live < Math.min(this.signals.targetFor(receipt.cid), MAX_REPLICA_TARGET)) {
          tracked.lastDistributed = Date.now() - 20_000; // eligible again in ~5-10s
        }
        // Persist updated confirmed providers
        this.net.saveTrackedCid({ cid: receipt.cid, ownerPub: tracked.ownerPub, confirmedProviders: Array.from(tracked.confirmedProviders), additionalCids: tracked.additionalCids, lastDistributed: tracked.lastDistributed });
        // Notify UI that the confirmed-provider count changed for this CID
        if (tracked.confirmedProviders.size !== prevSize) {
          this.emit('storage:providers-updated', { cid: receipt.cid, count: tracked.confirmedProviders.size });
        }
      }
      // Register provider's smoke address for general fallback and per-CID targeted retrieval
      if (receipt.providerSmokeAddr) {
        this.store.addPeerFallback(receipt.providerSmokeAddr);
        const existing = this.cidToSmokeAddrs.get(receipt.cid) ?? new Set<string>();
        existing.add(receipt.providerSmokeAddr);
        this.cidToSmokeAddrs.set(receipt.cid, existing);
      }
    }

    // If the receipt carries an updated storage byte count, verify the provider signed
    // it themselves before applying — prevents any peer from spoofing another node's stats.
    if (typeof receipt.actualStoredBytes === 'number') {
      const p = this.ledger.storageProviders.get(receipt.providerPub);
      if (p) {
        // Stats-only receipts use cid === providerPub; cache receipts use their own payload.
        const isStatsReceipt = receipt.cid === receipt.providerPub;
        const payload = isStatsReceipt
          ? `stats:${receipt.providerPub}:${receipt.actualStoredBytes}:${receipt.timestamp}`
          : `receipt:${receipt.cid}:${receipt.providerPub}:${receipt.requesterPub}:${receipt.latencyMs}:${receipt.success}:${receipt.timestamp}`;
        const valid = this.verifyMsg(receipt.signature, payload, receipt.providerPub);
        if (valid) p.lastActualStoredBytes = receipt.actualStoredBytes;
        else console.warn(`[StorageManager] Rejected storage stats update from ${receipt.providerPub.slice(0, 12)}… — invalid signature`);
      }
    }

    // Self-signed receipts (provider confirming their own cache) only serve as
    // an acknowledgment - they don't affect score metrics. Only third-party receipts
    // (from spot-checkers) are counted toward latency and pass rate.
    if (receipt.requesterPub === receipt.providerPub) return;

    // Prune receipts older than 24h
    const cutoff = Date.now() - receiptWindowMs();
    const list = (this.receipts.get(receipt.providerPub) || []).filter(r => r.timestamp > cutoff);
    list.push(receipt);
    this.receipts.set(receipt.providerPub, list);

    // Update provider off-chain metrics.
    // If the receipt carries rank info, inflate effective latency for later responders
    // so the score formula rewards being first-to-respond, not just fast on average.
    const provider = this.ledger.storageProviders.get(receipt.providerPub);
    if (provider) {
      const successful = list.filter(r => r.success);
      provider.spotCheckPassRate = list.length > 0 ? successful.length / list.length : 1.0;
      if (successful.length > 0) {
        const adjustedLatencies = successful.map(r => {
          const rankMultiplier = (r.responseRank && r.totalProviders && r.totalProviders > 1)
            ? 1 + (r.responseRank - 1) / r.totalProviders
            : 1.0;
          return r.latencyMs * rankMultiplier;
        });
        provider.avgLatencyMs = adjustedLatencies.reduce((s, v) => s + v, 0) / adjustedLatencies.length;
      }
      this.ledger.updateProviderScore(provider);
    }
  }

  // ── Spot checks ───────────────────────────────────────────────────────────

  /**
   * Periodically spot-check providers by fetching a block directly from each provider's
   * smoke address. All providers for a given CID are checked in parallel; the response
   * arrival order is tracked so faster providers receive a higher score.
   *
   * Only third-party-signed receipts (requesterPub ≠ providerPub) affect scores -
   * this prevents providers from gaming metrics by self-signing.
   */
  private async runSpotChecks(): Promise<void> {
    if (!this.store.isStarted()) return;

    const myPub = Array.from(this.localKeys.keys())[0];
    const myKeys = myPub ? this.localKeys.get(myPub) : undefined;
    if (!myPub || !myKeys) return;

    const localDeviceId = getDeviceId();
    for (const [cid, tracked] of this.trackedCids) {
      // Gather confirmed providers that have a known smoke address
      const confirmedEntries = Array.from(tracked.confirmedProviders)
        .map(pub => ({ pub, provider: this.ledger.storageProviders.get(pub) }))
        .filter((e): e is { pub: string; provider: NonNullable<typeof e.provider> } =>
          !!e.provider?.smokeAddr);

      // For under-replicated CIDs, also probe unconfirmed providers — this discovers
      // providers that cached the content but whose receipts never reached us (e.g.
      // the uploader's relay was down when the receipt was published).
      const unconfirmedEntries = this.liveHolderCount(tracked.confirmedProviders) < REDUNDANCY_TARGET
        ? this.ledger.getStorageProviders()
            .filter(p => p.smokeAddr && !tracked.confirmedProviders.has(p.pub) &&
              (!p.deviceId || p.deviceId !== localDeviceId))
            .map(p => ({ pub: p.pub, provider: p }))
        : [];

      const providerEntries = [...confirmedEntries, ...unconfirmedEntries];

      if (providerEntries.length === 0) continue;

      const totalProviders = confirmedEntries.length; // rank is relative to confirmed only
      let rankCounter = 0;

      const wasConfirmed = (pub: string) => tracked.confirmedProviders.has(pub);

      await Promise.allSettled(providerEntries.map(async ({ pub, provider }) => {
        const start = Date.now();
        let latencyMs = 9999;
        let success = false;
        let responseRank: number | undefined;

        try {
          const fetchedBytes = await this.store.fetchBlockFromProvider(provider.smokeAddr!, cid, 8_000);

          // Proof of retrievability: since blocks are content-addressed, the CID IS the
          // SHA-256 hash. If the provider serves bytes that don't hash to the CID they are
          // serving tampered or corrupted data. No local copy needed for verification.
          const integrous = await this.store.verifyBlockIntegrity(cid, fetchedBytes);
          if (!integrous) {
            // Not a flaky link — the provider answered, and what it served does not
            // hash to the CID. That is proof, so it costs the assignment at once
            // rather than after a streak.
            console.warn(`[StorageManager] CID integrity failure from ${pub.slice(0, 12)}… - block is tampered`);
            tracked.confirmedProviders.delete(pub);
            this.cidStuckCount.delete(cid);
            tracked.lastDistributed = 0;
            // fall through to receipt with success=false and latencyMs=9999
          } else {
            latencyMs = Date.now() - start;
            success = true;
            responseRank = ++rankCounter; // atomic: only one microtask runs at a time
            this.signals.recordSuccess(cid, pub);
            if (!wasConfirmed(pub)) {
              console.log(`[StorageManager] Spot-check discovered unconfirmed provider ${pub.slice(0, 12)}… has ${cid.slice(0, 16)}…`);
            }
          }
        } catch {
          // Only evict from confirmedProviders if we previously confirmed this provider.
          // For unconfirmed candidates a 404/timeout is expected and should not trigger re-replication.
          //
          // And not on the FIRST failure. A WebRTC dial through a flaky relay fails
          // for reasons that have nothing to do with whether the bytes are there;
          // evicting on one made every relay hiccup look like data loss and started
          // a re-replication round against holders that were fine. `CustodySignals`
          // counts CONSECUTIVE failures per (cid, provider) — a success anywhere in
          // between clears the streak.
          if (wasConfirmed(pub)) {
            const streak = this.signals.recordFailure(cid, pub);
            if (this.signals.shouldEvict(cid, pub)) {
              console.warn(`[StorageManager] Evicting ${pub.slice(0, 12)}… from ${cid.slice(0, 16)}… after ${streak} consecutive failures`);
              tracked.confirmedProviders.delete(pub);
              // Reset backoff so the next re-replication interval fires quickly rather
              // than waiting up to 5 minutes from a previous failed-upload backoff.
              this.cidStuckCount.delete(cid);
              tracked.lastDistributed = 0;
            }
          }
        }

        if (!success && !wasConfirmed(pub)) return; // unconfirmed probe failed — skip receipt

        const ts = Date.now();
        const payload = `receipt:${cid}:${pub}:${myPub}:${latencyMs}:${success}:${ts}`;
        const sig = this.signMsg(payload, myKeys!);
        const receipt: StorageReceipt = {
          providerPub: pub,
          requesterPub: myPub,
          cid,
          latencyMs,
          success,
          timestamp: ts,
          signature: sig,
          providerSmokeAddr: provider.smokeAddr,
          responseRank,
          totalProviders,
        };
        this.net.publishStorageReceipt(receipt);
        await this.handleReceipt(receipt);
      }));
    }
  }

  // ── Block submission (via ledger + net, same as current impl) ────────────

  private async submitBlock(block: AccountBlock | EngineBlock): Promise<{ success: boolean; error?: string }> {
    const eb = block as unknown as EngineBlock;
    const result = await this.ledger.addBlock(eb);
    // Storage blocks are engine blocks now — they gossip on the engine topic, not
    // the legacy one. `addBlock` is idempotent for a block we just created and
    // applied locally, so this is the propagation step, not a second apply.
    if (result.success) this.net.publishEngineBlock(eb);
    return result;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getReceipts(providerPub: string): StorageReceipt[] {
    return this.receipts.get(providerPub) || [];
  }

  getTrackedCids(): Map<string, { ownerPub: string; confirmedProviders: Set<string> }> {
    return this.trackedCids;
  }

  /**
   * File records for files this node OWNS — not a view of the network.
   * For anything else, ask the archives (`node.lookupFiles`).
   */
  getFileIndex(): Map<string, FileIndexRecord> {
    return this.fileIndex;
  }

  /**
   * Drop file records belonging to other accounts, in memory and in IDB.
   *
   * The one-time migration off the global index: a device that ran an older
   * build has an IndexedDB store holding a record for every file it ever saw
   * announced, and `start()` loads it back — so filtering the live gossip alone
   * would leave the `O(N)` set sitting on disk forever, growing again on any
   * downgrade. Called after keys are registered, because "ours" is undecidable
   * before that: `start()` runs with `localKeys` still empty, and pruning then
   * would delete the node's own records.
   */
  async pruneForeignFileIndex(): Promise<void> {
    if (this.localKeys.size === 0) return;
    let dropped = 0;
    for (const [cid, rec] of [...this.fileIndex]) {
      if (this.localKeys.has(rec.uploaderPub)) continue;
      this.fileIndex.delete(cid);
      await this.net.deleteFileIndexRecord(cid);
      dropped++;
    }
    if (dropped > 0) {
      console.log(`[StorageManager] Dropped ${dropped} foreign file record(s) — the index is own-files-only now`);
      this.emit('file:index-updated');
    }
  }

  async announceFile(cid: string, sizeBytes: number, mimeType: string | undefined, uploaderPub: string, keys: KeyPair): Promise<void> {
    const timestamp = Date.now();
    const payload = `file:${cid}:${sizeBytes}:${uploaderPub}:${timestamp}`;
    const signature = this.signMsg(payload, keys);
    const record: FileIndexRecord = { cid, sizeBytes, mimeType, timestamp, uploaderPub };
    this.fileIndex.set(cid, record);
    await this.net.saveFileIndexRecord(record);
    this.net.publishFileAnnouncement({ ...record, signature });
    this.emit('file:index-updated');
    // Gossip updated storage stats immediately so free-space reflects the new file on all nodes.
    this.broadcastStorageStats(uploaderPub, keys).catch(() => {});
  }

  async removeFileAnnouncement(cid: string, ownerPub: string, keys: KeyPair): Promise<void> {
    const timestamp = Date.now();
    const payload = `file-remove:${cid}:${ownerPub}:${timestamp}`;
    const signature = this.signMsg(payload, keys);
    this.fileIndex.delete(cid);
    await this.net.deleteFileIndexRecord(cid);
    this.trackedCids.delete(cid);
    this.net.deleteTrackedCid(cid);
    this.cidToSmokeAddrs.delete(cid);
    this.signals.forget(cid);
    this.net.publishFileAnnouncement({ cid, uploaderPub: ownerPub, sizeBytes: 0, timestamp, removed: true, signature });
    this.emit('file:index-updated');
    this.broadcastStorageStats(ownerPub, keys).catch(() => {});
  }

  private async reannounceTrackedFiles(): Promise<void> {
    if (!this.net.isRunning()) return;
    const records = await this.net.loadFileIndex();
    for (const rec of records) {
      const keys = this.localKeys.get(rec.uploaderPub);
      if (!keys) continue;
      const payload = `file:${rec.cid}:${rec.sizeBytes}:${rec.uploaderPub}:${rec.timestamp}`;
      const signature = this.signMsg(payload, keys);
      this.net.publishFileAnnouncement({ ...rec, signature });
    }
  }

  /** Return known provider smoke addresses for a specific CID, for targeted retrieval. */
  getCidSmokeAddrs(cid: string): string[] {
    return Array.from(this.cidToSmokeAddrs.get(cid) ?? []);
  }

  /**
   * Retrieve a block, routing to known providers for this CID first.
   * Wraps SmokeStore.retrieve() with per-CID peer hints so retrieval doesn't
   * broadcast to all peerFallbacks when we know exactly who holds the data.
   *
   * This is also where repair is triggered. A read is the cheapest liveness
   * check there is — it was going to happen anyway — so a successful one counts
   * as demand (which may raise the replica target) and a failed one says every
   * source we knew is unreachable, which is the signal to re-place the content
   * now rather than at whatever a watcher's next poll would have been.
   */
  async retrieve(cid: string, timeoutMs?: number): Promise<Uint8Array> {
    try {
      const data = await this.store.retrieve(cid, timeoutMs, this.getCidSmokeAddrs(cid));
      this.signals.recordRead(cid);
      return data;
    } catch (err) {
      this.repairOnReadFailure(cid);
      throw err;
    }
  }

  /** Check whether a local account is registered as a storage provider */
  isServing(pub: string): boolean {
    const provider = this.ledger.storageProviders.get(pub);
    return !!provider && provider.capacityGB > 0;
  }

  /**
   * Registered as a provider, but on a DIFFERENT device than this one.
   *
   * Custody is per-device, not per-account: the registration records the
   * `deviceId` that made it, and heartbeats, rewards and cache requests all skip
   * an account whose registration belongs elsewhere. That is deliberate — two
   * browsers holding the same account must not both claim to hold the same
   * bytes — but it was entirely silent. Recover an account onto a second
   * browser and its Storage tab shows a full serving row that will never
   * heartbeat, never earn and never accept a cache request, with nothing on
   * screen saying why. Reported by Lucian, 2026-08-16, after recovering bob into
   * Edge and waiting for a transfer that could not happen.
   *
   * Re-registering from this device rebinds it: `createStorageRegister` stamps
   * the current `getDeviceId()`.
   */
  registeredOnAnotherDevice(pub: string): boolean {
    const provider = this.ledger.storageProviders.get(pub);
    return !!provider && provider.capacityGB > 0 && !this.servesFromThisDevice(pub);
  }

  /**
   * May THIS device write storage blocks for this account? Fails CLOSED.
   *
   * The guard used to be "skip if the ids differ", which is false when the
   * registration carries no deviceId at all — so an empty id meant EVERY device
   * holding the account heartbeated, and two unattended writers on one chain
   * fork it. Bob's chain forked at indexes 17 and 18 exactly this way on
   * 2026-08-16; the relays published the evidence and the account froze
   * permanently, which is what fraud proofs are supposed to do and is not
   * recoverable.
   *
   * So the question is no longer "is this someone else's?" but "is this
   * provably mine?" — and recovering an account onto a new device now hands you
   * a registration that stays INERT until you press Serve, which rebinds the id.
   * Raised by Lucian: recovery gives you a registration you never asked for, so
   * defaulting to serving is defaulting to a race.
   */
  private servesFromThisDevice(pub: string): boolean {
    const provider = this.ledger.storageProviders.get(pub);
    if (!provider) return false;
    const local = getDeviceId();
    return !!local && !!provider.deviceId && provider.deviceId === local;
  }

  /**
   * Uptime percentage, or `undefined` when it is not something we measured.
   *
   * Delegates to `ProviderLedger.uptimeFraction` — the single definition. This
   * used to divide by a flat `MAX_HEARTBEATS_PER_DAY` while the SCORE beside it
   * divided by heartbeats-since-registration, so the two columns disagreed about
   * the same provider.
   */
  getUptimePct(pub: string): number | undefined {
    const p = this.ledger.storageProviders.get(pub);
    if (!p) return undefined;
    const fraction = this.ledger.providerUptime(p);
    return fraction === undefined ? undefined : Math.round(fraction * 100);
  }
}
