import { verify as engineVerify } from '../engine/core/keys';
import { decodeBlock, verifyBlock, type Block } from '../engine/core/block';
import { hexToBytes } from '../engine/core/hash';

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
    if (!best || Number(rec._version ?? 0) > Number(best._version ?? 0)) best = rec;
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
): Promise<PendingSendHint[]> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetchFn(`${base}/pending-sends?pub=${encodeURIComponent(pub)}&network=${encodeURIComponent(network)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`pending-sends ${res.status}`);
      return (await res.json()) as PendingSendHint[];
    }),
  );
  const byHash = new Map<string, PendingSendHint>();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const hint of r.value) {
      if (!hint || typeof hint.sender !== 'string' || typeof hint.blockHash !== 'string') continue;
      byHash.set(hint.blockHash, hint);
    }
  }
  return [...byHash.values()];
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
