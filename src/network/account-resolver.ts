import { verify as engineVerify } from '../engine/core/keys';
import { decodeBlock, verifyBlock, type Block } from '../engine/core/block';
import { hexToBytes, type Hex } from '../engine/core/hash';
import type { CounterpartyPacket, MintProof } from '../engine/core/counterparty-proof';
import type { FileRecord } from '../engine/content/file-index';

/**
 * G1 fix — on-demand account/username resolution (client side).
 *
 * Before: every client subscribed to the global `accounts` gossip topic and
 * ingested every account record ever created — O(total users) memory, bandwidth
 * and storage per node, re-amplified by the 20 s re-publish tick. That was the
 * first-failing scale-invariant violation (ARCHITECTURE.md → G1; measured in
 * `src/engine/sim/directory.ts`).
 *
 * After: nobody ingests the directory. A client that needs a counterparty
 * (send/NFT-transfer/search) RESOLVES it at that moment from a relay's account
 * archive over HTTP (`/resolve`), verifies the record's signature locally, and
 * caches only what it resolved. Per-client directory cost drops from O(N) to
 * O(contacts). At dev scale the two relays are the directory servers; at scale
 * this same lookup goes to the DHT (`findProviders`) — the call site is the
 * seam, the record format is unchanged.
 *
 * Trust model: the record is self-certifying — signed by the account's own key
 * over `account:{pub}:{username}:{createdAt}:{faceMapHash}` — so a relay can
 * serve it but cannot forge it. Unsigned records are REJECTED here (the gossip
 * path historically tolerated them; an on-demand result authorizes a transfer
 * target, so the bar is strict).
 */

/** The gossiped/served account record shape (app-layer, legacy field names). */
export interface AccountRecord {
  pub: string;
  username: string;
  createdAt: number;
  faceMapHash: string;
  _sig?: string;
  _version?: number;
  [key: string]: unknown;
}

/** The exact payload the account owner signs (same as node.ts signAccountData). */
export function accountRecordPayload(acc: AccountRecord): string {
  return `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
}

/** True iff the record carries a valid self-signature by `pub`. */
export function verifyAccountRecordSig(acc: AccountRecord): boolean {
  if (!acc || !acc._sig || !acc.pub) return false;
  try {
    return engineVerify(String(acc._sig), accountRecordPayload(acc), String(acc.pub));
  } catch {
    return false;
  }
}

/**
 * HTTP base for a relay's `/relay-info` + `/face-verify/*` + `/resolve`
 * endpoints, derived from its multiaddr. Two shapes:
 *  - `/dns4/<host>/…/wss/…`  → `https://<host>`      (nginx-fronted production relay)
 *  - `/ip4/<ip>/tcp/<p>/ws`  → `http://<ip>:<p+2>`   (bare dev relay; HTTP is PORT+2)
 * Empty string ⇒ same-origin relay → use the relative path (Vite/nginx proxy).
 */
export function relayHttpBase(addr: string | undefined): string {
  if (!addr) return '';
  const dns = addr.match(/\/dns[46]\/([^/]+)\//);
  if (dns) {
    if (typeof window !== 'undefined' && dns[1] === window.location.hostname) return ''; // origin → relative
    return `https://${dns[1]}`;
  }
  const ip = addr.match(/\/ip4\/([^/]+)\/tcp\/(\d+)\/ws(\/|$)/);
  if (ip) return `http://${ip[1]}:${Number(ip[2]) + 2}`;
  return '';
}

/**
 * Told whether each base answered, so a caller can retire one that never does.
 *
 * Every archive query fans out to EVERY base a node has ever heard of, and the
 * known-relay set is persisted and expand-only — so a base that has gone away
 * costs a full timeout on every `/resolve`, `/providers` and `/files` for the
 * life of the profile, and the client's per-query cost grows with the number of
 * relays it has ever met rather than with the number that work. Fan-in read from
 * the asking side.
 *
 * `Libp2pNetwork.markRelayFailed` already evicts after `RELAY_FAIL_EVICT`
 * consecutive failures; it was fed only by libp2p DIAL failures, so a relay that
 * was undialable-but-archived-over-HTTP — or, in dev, another device's dead
 * tunnel hostname — was never retired.
 */
export type BaseResultReporter = (base: string, ok: boolean) => void;

export type ResolveQuery = { username: string } | { pub: string };

/** A compressed-point P-256 pub key hex — how we tell a pub from a username. */
export function looksLikeAccountPub(identifier: string): boolean {
  return /^0[23][0-9a-f]{64}$/i.test(identifier);
}

/**
 * Resolve one account record from a set of relay HTTP bases, in parallel.
 * Returns the best VERIFIED record (highest `_version` among valid responses),
 * or null if no relay returned a verifiable record. Unreachable relays and
 * 404s are skipped silently — any single healthy relay suffices.
 */
export async function resolveAccountFromRelays(
  bases: readonly string[],
  query: ResolveQuery,
  network: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
): Promise<AccountRecord | null> {
  const param = 'username' in query
    ? `username=${encodeURIComponent(query.username.trim().toLowerCase())}`
    : `pub=${encodeURIComponent(query.pub)}`;
  // Plain GET with query params only — no custom headers, so cross-origin
  // requests to the bare-IP dev relays need no CORS preflight.
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(`${base}/resolve?${param}&network=${encodeURIComponent(network)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`resolve ${res.status}`);
      return (await res.json()) as AccountRecord;
    }),
  );

  let best: AccountRecord | null = null;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const rec = r.value;
    if (!rec || !rec.pub || !rec.username) continue;
    if (!verifyAccountRecordSig(rec)) continue; // forged/unsigned → useless
    // The username asked for must be the one the record binds (a relay must not
    // answer "alice" with a valid record for "mallory").
    if ('username' in query && String(rec.username).toLowerCase() !== query.username.trim().toLowerCase()) continue;
    if ('pub' in query && rec.pub !== query.pub) continue;
    if (!best) { best = rec; continue; }
    if (rec.pub === best.pub) {
      // Same account from two relays → the owner's monotonic counter ranks them.
      if (Number(rec._version ?? 0) > Number(best._version ?? 0)) best = rec;
    } else if (Number(rec.createdAt ?? 0) > Number(best.createdAt ?? 0)) {
      // DIFFERENT accounts claiming one username — a relay still serving a
      // pre-reset registration vs the account that re-registered the name.
      // `_version` is a per-BROWSER counter and meaningless across accounts
      // (comparing them once routed a payment to generation-7 bob). The later
      // registration is the live one: newest `createdAt` wins.
      best = rec;
    }
  }
  return best;
}

/** One row of a relay's answer to "which sends are addressed to this account?" */
export interface PendingSendHint {
  sender: string;
  blockHash: string;
  shard: number;
  type: 'send' | 'nft-send';
}

export interface PendingSendsResult {
  /**
   * The archives' highest index for the asking account (max across relays; −1
   * if unknown). SAFETY GATE: a client whose local head is BEHIND this must
   * finish syncing its own chain before claiming anything — a receive built on
   * a stale head forks the claimant's own chain, which is indistinguishable
   * from a deliberate double-spend and freezes the account network-wide.
   */
  headIndex: number;
  sends: PendingSendHint[];
}

/**
 * G1 follow-up — offline-transfer discovery. Ask the relays' block archives
 * which send/nft-send blocks are addressed to `pub` (GET /pending-sends), so a
 * recipient that was offline — or wiped and freshly recovered — learns WHICH
 * sender chains to pull. The old behavior free-rode on the O(N) accounts
 * firehose: a recovered device learned every account that existed and the
 * startup refresh pulled every chain, so inbound sends were found by accident.
 * This is the interest-scoped replacement: O(own inbound), union across relays,
 * dead relays skipped. The result is a HINT only — the caller pulls the
 * sender's chain through the normal fully-verified delta path, so a lying
 * relay can at worst waste one delta request.
 */
export async function fetchPendingSends(
  bases: readonly string[],
  pub: string,
  network: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
): Promise<PendingSendsResult> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(`${base}/pending-sends?pub=${encodeURIComponent(pub)}&network=${encodeURIComponent(network)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`pending-sends ${res.status}`);
      return (await res.json()) as { headIndex?: number; sends?: PendingSendHint[] } | PendingSendHint[];
    }),
  );
  const byHash = new Map<string, PendingSendHint>();
  let headIndex = -1;
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    // Tolerate the pre-headIndex relay shape (bare array) during rollout.
    const body = Array.isArray(r.value) ? { headIndex: -1, sends: r.value } : r.value;
    headIndex = Math.max(headIndex, Number(body.headIndex ?? -1));
    for (const hint of body.sends ?? []) {
      if (!hint || typeof hint.sender !== 'string' || typeof hint.blockHash !== 'string') continue;
      byHash.set(hint.blockHash, hint);
    }
  }
  return { headIndex, sends: [...byHash.values()] };
}

/**
 * Storage-provider discovery (GET /providers) — the union across relays.
 *
 * Storage blocks gossip on their account's SHARD topic, so a node only ever
 * sees providers whose shard it holds; on a 4096-shard network that is
 * effectively only its own. Re-broadcasting them globally is the `O(N)`
 * firehose this project removed, so providers are ASKED for instead, exactly
 * like accounts under G1.
 *
 * The relays serve the PROVIDER's own signed blocks, never their own opinion —
 * decoding happens here and verification in `foldProviderBlocks`, so a lying
 * relay wastes a fetch and nothing more. Asking every relay and taking the union
 * means one relay cannot hide a provider either.
 */
export async function fetchProviders(
  bases: readonly string[],
  network: string,
  limit = 20,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
  onBaseResult?: BaseResultReporter,
): Promise<Block[]> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(
        `${base}/providers?network=${encodeURIComponent(network)}&limit=${encodeURIComponent(String(limit))}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) throw new Error(`providers ${res.status}`);
      return (await res.json()) as { blocks?: string[] };
    }),
  );
  const byHash = new Map<string, Block>();
  for (const [i, r] of results.entries()) {
    onBaseResult?.(bases[i]!, r.status === 'fulfilled');
    if (r.status !== 'fulfilled') continue;
    for (const hex of r.value?.blocks ?? []) {
      try {
        const block = decodeBlock(hexToBytes(hex));
        byHash.set(block.hash, block);   // union across relays, deduped
      } catch { /* undecodable row — the fold would reject it anyway */ }
    }
  }
  return [...byHash.values()];
}

/**
 * File-record lookup (GET /files) — the union across relays, plus what each
 * archive says it holds.
 *
 * The last `O(N)` in storage: every node used to ingest a global `files` topic
 * and persist a record for every file on the network. Now a node keeps only its
 * OWN files and asks here for anything else — the shape G1 and G3 settled on.
 *
 * Records are returned unverified; `foldFileRecords` (engine/content/file-index)
 * does that, rebuilding each payload from the record's own fields so a relay
 * cannot serve an inflated size under a valid signature. Asking every relay and
 * taking the union means one relay cannot hide a file either.
 *
 * `archiveTotals` is per-relay ON PURPOSE. No node knows how many files exist on
 * the network, and summing the relays would double-count everything they both
 * hold while still missing whatever neither does. The caller gets the raw
 * per-archive figures and must present them as what an archive can see.
 */
export async function fetchFileRecords(
  bases: readonly string[],
  network: string,
  query: { cid?: string; owner?: string; limit?: number } = {},
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
  onBaseResult?: BaseResultReporter,
): Promise<{ records: FileRecord[]; archiveTotals: number[] }> {
  const params = new URLSearchParams({ network });
  if (query.cid) params.set('cid', query.cid);
  if (query.owner) params.set('owner', query.owner);
  if (query.limit !== undefined) params.set('limit', String(query.limit));

  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(`${base}/files?${params.toString()}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`files ${res.status}`);
      return (await res.json()) as { records?: FileRecord[]; total?: number };
    }),
  );

  // Union, newest-per-CID. A relay serving a stale announcement must not
  // outrank another relay's newer withdrawal of the same file.
  const byCid = new Map<string, FileRecord>();
  const archiveTotals: number[] = [];
  for (const [i, r] of results.entries()) {
    onBaseResult?.(bases[i]!, r.status === 'fulfilled');
    if (r.status !== 'fulfilled') continue;
    if (typeof r.value?.total === 'number') archiveTotals.push(r.value.total);
    for (const rec of r.value?.records ?? []) {
      if (!rec || typeof rec.cid !== 'string') continue;
      const prev = byCid.get(rec.cid);
      if (!prev || Number(rec.timestamp) > Number(prev.timestamp)) byCid.set(rec.cid, rec);
    }
  }
  return { records: [...byCid.values()], archiveTotals };
}

/**
 * G2 — fetch a counterparty proof packet (GET /head-proof) from the relays'
 * archives: the sender's open + head + the send (hex) with the two RFC-6962
 * audit paths. Decoded here; VERIFICATION happens in the ledger
 * (registerVerifiedSend → verifyPacket), so a lying relay only wastes a fetch.
 * Returns the first packet that decodes; null if no relay can serve one (the
 * caller falls back to the chain-pull path).
 */
export async function fetchHeadProof(
  bases: readonly string[],
  senderId: string,
  sendBlockHash: string,
  network: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
): Promise<CounterpartyPacket | null> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(
        `${base}/head-proof?pub=${encodeURIComponent(senderId)}&send=${encodeURIComponent(sendBlockHash)}&network=${encodeURIComponent(network)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) throw new Error(`head-proof ${res.status}`);
      return (await res.json()) as {
        openHex?: string; headHex?: string; sendHex?: string; openProof?: Hex[]; sendProof?: Hex[];
      };
    }),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const p = r.value;
    if (!p?.openHex || !p.headHex || !p.sendHex || !Array.isArray(p.openProof) || !Array.isArray(p.sendProof)) continue;
    try {
      return {
        openBlock: decodeBlock(hexToBytes(p.openHex)),
        headBlock: decodeBlock(hexToBytes(p.headHex)),
        sendBlock: decodeBlock(hexToBytes(p.sendHex)),
        openInclusionProof: p.openProof,
        sendInclusionProof: p.sendProof,
      };
    } catch { /* malformed — try the next relay */ }
  }
  return null;
}

/**
 * G2 for NFTs — fetch a token's mint proof (GET /token) from the relays'
 * archives: the MINTER's open + head + the nft-mint block, with audit paths.
 * A transfer packet proves the send; this proves what the token IS
 * (`contentRef` + metadata), which lives on the minter's chain — a different
 * account once the token has moved at least once. Verification happens in the
 * ledger (registerVerifiedMint → verifyMintProof).
 */
export async function fetchMintProof(
  bases: readonly string[],
  tokenId: string,
  network: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
): Promise<MintProof | null> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(
        `${base}/token?id=${encodeURIComponent(tokenId)}&network=${encodeURIComponent(network)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) throw new Error(`token ${res.status}`);
      return (await res.json()) as {
        openHex?: string; headHex?: string; mintHex?: string; openProof?: Hex[]; mintProof?: Hex[];
      };
    }),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const p = r.value;
    if (!p?.openHex || !p.headHex || !p.mintHex || !Array.isArray(p.openProof) || !Array.isArray(p.mintProof)) continue;
    try {
      return {
        openBlock: decodeBlock(hexToBytes(p.openHex)),
        headBlock: decodeBlock(hexToBytes(p.headHex)),
        mintBlock: decodeBlock(hexToBytes(p.mintHex)),
        openInclusionProof: p.openProof,
        mintInclusionProof: p.mintProof,
      };
    } catch { /* malformed — try the next relay */ }
  }
  return null;
}

/**
 * Explorer block lookup by hash from the relays' archive (GET /block) — for
 * blocks the local interest-scoped view does not hold. The returned block is
 * verified here (content hash + account signature), so a relay can serve it
 * but cannot forge it; a hash mismatch with what was asked for is rejected too.
 */
export async function fetchBlockByHash(
  bases: readonly string[],
  hash: string,
  network: string,
  fetchFn: typeof fetch = (...args) => fetch(...args),
  timeoutMs = 5_000,
): Promise<Block | null> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(`${base}/block?hash=${encodeURIComponent(hash)}&network=${encodeURIComponent(network)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`block ${res.status}`);
      return (await res.json()) as { blockHex?: string };
    }),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.blockHex) continue;
    try {
      const block = decodeBlock(hexToBytes(r.value.blockHex));
      if (block.hash === hash && verifyBlock(block)) return block;
    } catch { /* malformed — try the next relay */ }
  }
  return null;
}
