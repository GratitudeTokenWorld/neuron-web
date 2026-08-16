import { verifyBlock, type Block } from '../core/block.js';
import { MAX_OFFLINE_MS, type StorageProviderState } from './provider-ledger.js';

/**
 * Learning about storage providers you do not hold the chain of.
 *
 * Storage blocks gossip on their account's SHARD topic, and a node subscribes
 * only to the shards it has an interest in — so two providers on different
 * shards never see each other, which is correct (interest-scoped propagation is
 * the scale invariant) and useless (you cannot hand content to a provider you
 * have never heard of). The old behaviour, a global block firehose every node
 * ingested, is exactly the `O(N)` violation this project exists to remove, so
 * the answer is not to broadcast again — it is to ASK, on demand, and verify
 * the answer. Same shape as G1's `/resolve` for accounts.
 *
 * What a relay returns is the provider's own signed blocks, not the relay's
 * opinion: the latest `storage-register` (what capacity it declared) and the
 * latest `storage-heartbeat` (when it last claimed to be alive, and where to
 * reach it). Both are verifiable in isolation — `verifyBlock` re-derives the
 * content hash and checks the signature under `accountId` — so a relay cannot
 * invent a provider, inflate a capacity, or forge a liveness claim. It can only
 * choose which real records to show, and a client asking several relays sees the
 * union.
 *
 * **What this deliberately does NOT prove**, because it cannot without the
 * chain: that these blocks are still current (a later block may supersede them)
 * or that the account has not equivocated. That is proportionate — discovery
 * only feeds *selection*, and every claim here is one the provider could already
 * make about itself. Declared capacity is self-asserted by design; a provider
 * that lies fails its spot-checks and loses the assignment. Nothing here feeds
 * reward validation, which runs against the provider's own full chain on nodes
 * that hold it.
 */

/**
 * Blocks an archive should serve for provider discovery, bounded.
 *
 * Given every storage block an archive holds, pick the ones a client needs: per
 * account, the newest `storage-register` and the newest `storage-heartbeat`.
 * `limit` caps how many PROVIDERS are described, not how many blocks are
 * scanned — an unbounded answer would just be the global firehose again, served
 * over HTTP. Freshest heartbeat first, so a bounded page is the useful half of
 * the set rather than an arbitrary one.
 *
 * Lives here rather than in `relay/` because `relay/` is typechecked by nothing
 * and tested by nothing.
 */
export function selectDiscoveryBlocks(
  blocks: readonly Block[],
  limit: number,
  now: number = Date.now(),
): Block[] {
  const registers = new Map<string, Block>();
  const heartbeats = new Map<string, Block>();
  const deregisters = new Map<string, Block>();
  for (const b of blocks) {
    const into = b.type === 'storage-register' ? registers
      : b.type === 'storage-heartbeat' ? heartbeats
      : b.type === 'storage-deregister' ? deregisters
      : undefined;
    if (!into) continue;
    const prev = into.get(b.accountId);
    if (!prev || b.index > prev.index) into.set(b.accountId, b);
  }

  /** Has this account left? Its newest storage block being a deregister says so. */
  const gone = (pub: string) => {
    const dr = deregisters.get(pub);
    if (!dr) return false;
    const reg = registers.get(pub);
    return !reg || dr.index > reg.index;
  };

  const ranked = [...registers.entries()]
    .filter(([pub, reg]) => (reg.storage?.capacityGB ?? 0) > 0 && !gone(pub))
    .sort((a, b) => (heartbeats.get(b[0])?.timestamp ?? 0) - (heartbeats.get(a[0])?.timestamp ?? 0))
    .slice(0, Math.max(0, limit));

  const out: Block[] = [];
  for (const [pub, reg] of ranked) {
    out.push(reg);
    const hb = heartbeats.get(pub);
    if (hb && hb.index > reg.index) out.push(hb);
  }

  // Serve recent departures too — a TOMBSTONE, for the same reason the file
  // index serves withdrawals. Omitting the provider is not enough: a client asks
  // several relays and takes the UNION, so one relay that missed the deregister
  // and still serves the register would resurrect it. The client folds by chain
  // index, so a single relay carrying the departure is enough to settle it.
  //
  // Bounded by the same derived window as file tombstones: past
  // `2 × MAX_OFFLINE_MS` the lease has lapsed by any measure, the provider
  // cannot be selected for custody, and its stale register has long since sunk
  // below the freshness ranking above.
  for (const [pub, dr] of deregisters) {
    if (!gone(pub)) continue;
    if (now - dr.timestamp > 2 * MAX_OFFLINE_MS) continue;
    out.push(dr);
  }
  return out;
}

/** A provider learned by query rather than by holding its chain. */
export interface DiscoveredProvider extends StorageProviderState {
  /** Always true — marks this as unverified-against-chain (see module docs). */
  discovered: true;
}

/**
 * Score given to a provider we have no history for.
 *
 * Explicitly NOT 1.0, which is what this used to be. Score drives provider
 * selection (weight = capacity × score), so scoring the unknown as *perfect*
 * made every node rank every stranger above the providers it had real evidence
 * about — including itself — and would have routed content preferentially to
 * the least-verified nodes on the network. It also produced the visibly absurd
 * row of "0% uptime, score 1.000".
 *
 * A neutral prior instead: unknown providers are neither favoured nor punished,
 * and a provider we HAVE watched overtakes it by actually being reliable. The
 * UI shows this as "—" rather than as a number, because it is a placeholder for
 * a measurement, not a measurement.
 */
export const UNKNOWN_SCORE = 0.5;

/**
 * Verify a batch of provider blocks and fold them into provider records.
 *
 * Input is whatever a relay served; everything unverifiable is dropped
 * silently, because a bad row in an archive must not deny service for the good
 * ones. Per account the NEWEST register and the NEWEST heartbeat win, decided by
 * chain index — timestamps are self-reported and a provider could backdate them,
 * but index is monotonic within a signed chain.
 */
export function foldProviderBlocks(blocks: readonly Block[]): DiscoveredProvider[] {
  const registers = new Map<string, Block>();
  const heartbeats = new Map<string, Block>();
  const deregisters = new Map<string, Block>();

  for (const b of blocks) {
    if (b.type !== 'storage-register' && b.type !== 'storage-heartbeat'
      && b.type !== 'storage-deregister') continue;
    let ok = false;
    try { ok = verifyBlock(b); } catch { ok = false; }
    if (!ok) continue;
    const into = b.type === 'storage-register' ? registers
      : b.type === 'storage-heartbeat' ? heartbeats
      : deregisters;
    const prev = into.get(b.accountId);
    if (!prev || b.index > prev.index) into.set(b.accountId, b);
  }

  const out: DiscoveredProvider[] = [];
  for (const [pub, reg] of registers) {
    // A departure supersedes the registration it ends. Without this a
    // deregistered provider stayed in every other node's list forever: the
    // registry deleted its own record, `setDiscovered` replaced the whole
    // discovered set — and the next poll put it straight back, because nothing
    // in the discovery path had ever looked at `storage-deregister`.
    // Found by Lucian, 2026-08-16, running TESTPLAN T8 step 4.
    const dr = deregisters.get(pub);
    if (dr && dr.index > reg.index) continue;
    const capacityGB = reg.storage?.capacityGB ?? 0;
    if (capacityGB <= 0) continue;                 // deregistered or malformed
    const hb = heartbeats.get(pub);
    // Only count a heartbeat that belongs to the CURRENT registration. An older
    // one describes a lease that the re-registration already ended, and using it
    // would make a provider look live on the strength of a previous life.
    const live = hb && hb.index > reg.index ? hb : undefined;
    out.push({
      pub,
      deviceId: reg.storage?.deviceId ?? '',
      registeredAt: reg.timestamp,
      capacityGB,
      lastActualStoredBytes: live?.storage?.storedBytes ?? 0,
      lastHeartbeat: live?.timestamp ?? 0,
      heartbeatsLast24h: 0,        // no history without the chain — shown as "—"
      lastRewardEpoch: 0,
      totalEarned: 0,
      smokeAddr: live?.storage?.smokeAddr,
      countryCode: live?.storage?.countryCode,
      avgLatencyMs: 0,
      spotCheckPassRate: 1,
      score: UNKNOWN_SCORE,
      earningRate: 0,
      discovered: true,
    });
  }
  return out;
}
