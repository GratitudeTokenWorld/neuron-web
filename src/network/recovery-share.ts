import { sign as engineSign } from '../engine/core/keys';
import { shamirSplit, shamirCombine } from '../core/shamir';
import type { TrajectoryProof, RecoveryAction } from '../core/recovery-challenge';

/**
 * Client side of the pinVersion=3 custody split (see src/core/face-store.ts for
 * the scheme, relay/server.ts + src/core/recovery-challenge.ts for the gate).
 *
 * Two hardenings beyond the original v3 landing, both 2026-08-15:
 *
 *  - **Shamir 2-of-n distribution.** With ≥2 reachable attester relays the
 *    secret is SPLIT (src/core/shamir.ts): each relay stores one share that is
 *    information-theoretically independent of the secret, so no single relay —
 *    rogue, compromised, or subpoenaed — holds the third key factor, and an
 *    attacker must pass TWO independent face-gated, backoff-limited releases.
 *    Any 2 of n reconstruct, which keeps one-relay-down recovery working in
 *    the 3-attester dev topology. With only one relay reachable (LOCAL_ONLY
 *    dev) the store falls back to a legacy full-secret record — custody-split
 *    against a single custodian is not a meaningful construction.
 *
 *  - **Challenge-trajectory release.** A release attempt must perform the
 *    relay's server-drawn, ordered action sequence and submit the detector's
 *    own numbers plus per-action descriptors (recovery-challenge.ts). This
 *    kills the still-photo attack and stolen-session replay; the ceiling
 *    (fabrication via custom tooling around a photo descriptor) is documented
 *    in that module's header, not hidden here.
 *
 * The share/secret is still treated as radioactive: never logged, never
 * persisted outside pin-crypto's device cache, ECDH-wrapped on the wire.
 */

/** What a relay returns from /recovery-share/release. */
interface WrappedShare { ephPub: string; iv: string; ct: string; x?: number; ts?: number }

const hex = (b: Uint8Array): string => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/.{2}/g)!.map(x => parseInt(x, 16)));

async function postJson(base: string, path: string, network: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-network': network },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/** Store one share (or the full secret, x undefined) on one relay, signed. */
async function storeOnRelay(
  base: string,
  accountId: string,
  network: string,
  shareHex: string,
  x: number | undefined,
  enginePriv: string,
  ts: number,
  timeoutMs: number,
): Promise<boolean> {
  try {
    // x rides inside the signed payload — a MITM must not be able to strip or
    // renumber a share coordinate (silent reconstruction corruption).
    const payload = x !== undefined
      ? `recovery-share:${accountId}:${network}:${x}:${shareHex}:${ts}`
      : `recovery-share:${accountId}:${network}:${shareHex}:${ts}`;
    const sig = engineSign(payload, enginePriv);
    const res = await postJson(base, '/recovery-share', network, { accountId, share: shareHex, ts, sig, ...(x !== undefined ? { x } : {}) }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

export interface StoreShareResult {
  /** Relays that accepted their share. */
  stored: number;
  /** 'shamir' = 2-of-n split; 'full' = single-custodian legacy record. */
  mode: 'shamir' | 'full';
}

/**
 * Distribute the recovery secret across the relay bases.
 *
 * ≥2 bases → Shamir split, one share per base, ONE ts for the whole fan-out
 * (relays keep newest-ts-wins; distinct timestamps would make a partial
 * re-store look like a rotation to some relays and a replay to others, and
 * shares from different splits combine into garbage — see shamir.test.ts).
 *
 * The CALLER judges `stored` sufficiency: creation demands ≥2 in shamir mode
 * (k=2 needs two releasable custodians) and aborts otherwise.
 */
export async function storeRecoveryShare(
  bases: readonly string[],
  accountId: string,
  network: string,
  secret: Uint8Array,
  enginePriv: string,
  timeoutMs = 6_000,
): Promise<StoreShareResult> {
  const ts = Date.now();
  if (bases.length < 2) {
    const ok = bases.length === 1
      && await storeOnRelay(bases[0], accountId, network, hex(secret), undefined, enginePriv, ts, timeoutMs);
    return { stored: ok ? 1 : 0, mode: 'full' };
  }
  const shares = shamirSplit(secret, bases.length);
  const results = await Promise.all(
    bases.map((base, i) => storeOnRelay(base, accountId, network, hex(shares[i].data), shares[i].x, enginePriv, ts, timeoutMs)),
  );
  return { stored: results.filter(Boolean).length, mode: 'shamir' };
}

/** A relay's drawn recovery challenge, kept with the base that issued it. */
export interface RelayRecoveryChallenge {
  base: string;
  challengeId: string;
  sequence: RecoveryAction[];
}

/**
 * Fetch a release challenge from each base, keeping relay↔challenge pairing.
 * `want` caps how many relays we will perform for (2 covers Shamir k=2; a
 * legacy full-share account completes after the first release anyway).
 */
export async function fetchRecoveryChallenges(
  bases: readonly string[],
  network: string,
  want = 2,
  timeoutMs = 6_000,
): Promise<RelayRecoveryChallenge[]> {
  const out: RelayRecoveryChallenge[] = [];
  for (const base of bases) {
    if (out.length >= want) break;
    try {
      const res = await postJson(base, '/recovery-share/challenge', network, {}, timeoutMs);
      if (!res.ok) continue;
      const { challengeId, sequence } = await res.json() as { challengeId?: string; sequence?: RecoveryAction[] };
      if (challengeId && Array.isArray(sequence) && sequence.length) out.push({ base, challengeId, sequence });
    } catch { /* relay unreachable — try the next */ }
  }
  return out;
}

export interface ReleaseFailure {
  /** Longest server-side lockout seen across relays, if any said "locked". */
  retryAfterS?: number;
  /** Human-readable reason from the last relay that answered. */
  reason: string;
}

export type ReleaseResult =
  | { ok: true; secret: Uint8Array }
  | ({ ok: false } & ReleaseFailure);

/**
 * Release the recovery secret using per-relay trajectory proofs.
 *
 * `proofs` maps each challenged relay's base to the proof for ITS sequence —
 * one camera session performs the concatenation, the caller slices it up.
 * Completes on the first legacy full-secret release, or on two same-generation
 * Shamir shares with distinct x (mixing generations is refused — combining
 * across splits yields silent garbage, which is worse than failing).
 */
export async function releaseRecoveryShare(
  challenges: readonly RelayRecoveryChallenge[],
  proofs: ReadonlyMap<string, TrajectoryProof>,
  accountId: string,
  network: string,
  timeoutMs = 8_000,
): Promise<ReleaseResult> {
  let lastReason = 'no relay reachable';
  let retryAfterS: number | undefined;
  const shares: { x: number; data: Uint8Array; ts: number }[] = [];

  for (const ch of challenges) {
    const proof = proofs.get(ch.base);
    if (!proof) continue;
    try {
      // Fresh ephemeral per relay — reusing one across relays would let a
      // malicious relay correlate attempts, and keys are cheap.
      const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const ephPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

      const res = await postJson(ch.base, '/recovery-share/release', network, {
        accountId, challengeId: ch.challengeId, proof, ephPub: hex(ephPubRaw),
      }, timeoutMs);
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
      const data = new Uint8Array(plain);
      if (data.length !== 32) { lastReason = 'bad share length'; continue; }

      if (!wrapped.x) return { ok: true, secret: data };   // legacy full-secret record

      shares.push({ x: wrapped.x, data, ts: wrapped.ts ?? 0 });
      const partner = shares.find(s => s.x !== wrapped.x && s.ts === (wrapped.ts ?? 0));
      if (partner) {
        return { ok: true, secret: shamirCombine({ x: partner.x, data: partner.data }, { x: wrapped.x, data }) };
      }
      lastReason = 'one share obtained — need a second relay';
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
      const res = await postJson(base, '/keyblob', network, { blob }, timeoutMs);
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
