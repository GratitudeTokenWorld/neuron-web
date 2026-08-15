import { sign as engineSign } from '../engine/core/keys';

/**
 * Client side of the pinVersion=3 custody split (see src/core/face-store.ts for
 * the scheme and relay/server.ts for the enforcement).
 *
 * The recovery share is the third key factor. It is minted client-side at
 * account creation, handed to the attester relays over a SIGNED store call, and
 * comes back only through `releaseRecoveryShare` — a face-gated, server-side
 * rate-limited endpoint. Everything here treats the share as radioactive: it is
 * never logged, never persisted outside pin-crypto's device cache, and it
 * crosses the wire only ECDH-wrapped (the dev relays speak plain HTTP; a share
 * sniffed once is a factor lost forever).
 *
 * Store fan-out vs release fan-in is deliberately asymmetric:
 *  - STORE goes to every attester relay and the caller demands a minimum count
 *    — each relay holds the same share, so any single surviving relay suffices
 *    for a later recovery (matches T5's "one relay down" requirement).
 *  - RELEASE tries relays one at a time and stops at the first success — every
 *    extra attempt spends a challenge and, on failure, feeds a relay's backoff
 *    counter, so spraying all relays in parallel would punish the legitimate
 *    user's future attempts.
 */

/** What a relay returns from /recovery-share/release. */
interface WrappedShare { ephPub: string; iv: string; ct: string }

const hex = (b: Uint8Array): string => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/.{2}/g)!.map(x => parseInt(x, 16)));

/**
 * Store the share on one relay, signed by the account's engine key so only the
 * key owner can bind (or later rotate) it — an unsigned store would let anyone
 * overwrite the share and brick the account's recovery. Returns true on 200.
 */
async function storeOnRelay(
  base: string,
  accountId: string,
  network: string,
  shareHex: string,
  enginePriv: string,
  ts: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const sig = engineSign(`recovery-share:${accountId}:${network}:${shareHex}:${ts}`, enginePriv);
    const res = await fetch(`${base}/recovery-share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-network': network },
      body: JSON.stringify({ accountId, share: shareHex, ts, sig }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fan the share out to every relay base. Returns how many accepted — the CALLER
 * decides the minimum (creation requires REQUIRED_ATTESTERS, the same quorum it
 * already demands for attestations, so "account exists but no relay can ever
 * release its share" is not a reachable state).
 *
 * One `ts` for the whole fan-out: the relays keep newest-ts-wins, so distinct
 * timestamps per relay would make a later partial re-store look like a rotation
 * to some relays and a replay to others.
 */
export async function storeRecoveryShare(
  bases: readonly string[],
  accountId: string,
  network: string,
  share: Uint8Array,
  enginePriv: string,
  timeoutMs = 6_000,
): Promise<number> {
  const ts = Date.now();
  const shareHex = hex(share);
  const results = await Promise.all(
    bases.map(base => storeOnRelay(base, accountId, network, shareHex, enginePriv, ts, timeoutMs)),
  );
  return results.filter(Boolean).length;
}

export interface ReleaseFailure {
  /** Longest server-side lockout seen across relays, if any said "locked". */
  retryAfterS?: number;
  /** Human-readable reason from the last relay that answered. */
  reason: string;
}

export type ReleaseResult =
  | { ok: true; share: Uint8Array }
  | ({ ok: false } & ReleaseFailure);

/**
 * Release the share from the first relay that accepts the live face.
 *
 * Flow per relay: fetch a single-use challenge session (the same endpoint the
 * attestation flow uses), then present the live descriptor + an ephemeral ECDH
 * pubkey; unwrap the response with the matching private key. The descriptor
 * here is the one `challengeAndCapture` just produced — the caller has already
 * run the full liveness sequence, so a photo has been rejected client-side and
 * the relay's own nid match is the server-side backstop.
 */
export async function releaseRecoveryShare(
  bases: readonly string[],
  accountId: string,
  network: string,
  descriptor: number[],
  timeoutMs = 8_000,
): Promise<ReleaseResult> {
  let lastReason = 'no relay reachable';
  let retryAfterS: number | undefined;

  for (const base of bases) {
    try {
      // Fresh ephemeral per relay — reusing one across relays would let a
      // malicious relay correlate attempts, and keys are cheap.
      const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

      const chRes = await fetch(`${base}/face-verify/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-network': network },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!chRes.ok) { lastReason = `challenge ${chRes.status}`; continue; }
      const { challengeId } = await chRes.json() as { challengeId: string };

      const res = await fetch(`${base}/recovery-share/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-network': network },
        body: JSON.stringify({ accountId, challengeId, descriptor, ephPub: hex(ephPubRaw) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; retryAfterS?: number };
        lastReason = err.error || `release ${res.status}`;
        if (typeof err.retryAfterS === 'number') retryAfterS = Math.max(retryAfterS ?? 0, err.retryAfterS);
        continue;
      }

      const wrapped = await res.json() as WrappedShare;
      if (!wrapped?.ephPub || !wrapped.iv || !wrapped.ct) { lastReason = 'malformed release response'; continue; }
      const relayPub = await crypto.subtle.importKey(
        'raw', unhex(wrapped.ephPub) as unknown as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [],
      );
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: relayPub }, eph.privateKey, 256);
      // SHA-256 of the ECDH x-coordinate — must mirror wrapShareForClient exactly.
      const aesRaw = await crypto.subtle.digest('SHA-256', bits);
      const aes = await crypto.subtle.importKey('raw', aesRaw, { name: 'AES-GCM' }, false, ['decrypt']);
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unhex(wrapped.iv) as unknown as BufferSource }, aes, unhex(wrapped.ct) as unknown as BufferSource,
      );
      const share = new Uint8Array(plain);
      if (share.length !== 32) { lastReason = 'bad share length'; continue; }
      return { ok: true, share };
    } catch (e) {
      lastReason = (e as Error).message || 'relay unreachable';
    }
  }
  return { ok: false, reason: lastReason, retryAfterS };
}

/**
 * Store the blob on every relay base (targeted replacement for the old global
 * keyblobs gossip — see libp2p-network.ts). Best-effort: the local IDB copy is
 * the primary for same-device use; the relay copies exist for wiped-device
 * recovery, and the next blob update retries any relay that missed this one.
 */
export async function storeKeyBlobOnRelays(
  bases: readonly string[],
  blob: Record<string, unknown>,
  network: string,
  timeoutMs = 6_000,
): Promise<number> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetch(`${base}/keyblob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-network': network },
        body: JSON.stringify({ blob }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`keyblob store ${res.status}`);
    }),
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

/**
 * Fetch the newest key blob for a username (or pub) from the relays. Plain GET
 * with query params only — no preflight, mirroring /resolve. Newest updatedAt
 * across relays wins, same rule the relays apply internally.
 */
export async function fetchKeyBlobFromRelays(
  bases: readonly string[],
  query: { username: string } | { pub: string },
  network: string,
  timeoutMs = 6_000,
): Promise<Record<string, unknown> | null> {
  const param = 'username' in query
    ? `username=${encodeURIComponent(query.username.trim().toLowerCase())}`
    : `pub=${encodeURIComponent(query.pub)}`;
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetch(`${base}/keyblob?${param}&network=${encodeURIComponent(network)}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`keyblob ${res.status}`);
      return (await res.json()) as Record<string, unknown>;
    }),
  );
  let best: Record<string, unknown> | null = null;
  const ts = (b: Record<string, unknown>) => Number(b.updatedAt ?? b.createdAt ?? 0);
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value?.pub || !r.value?.encryptedKeys) continue;
    if (!best || ts(r.value) > ts(best)) best = r.value;
  }
  return best;
}
