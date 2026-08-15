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
  /**
   * Optional live descriptor. A relay binds accountId→nid at store time and
   * needs that binding to gate the release, so a relay that never attested
   * this account has nothing to bind and refuses. Passing the descriptor from
   * a just-completed capture lets it derive the nid from its OWN face DB and
   * become a custodian — which is how an account heals onto a relay that was
   * down at creation. Unsigned by design: tampering can only cause a wrong
   * binding or a refusal on a relay that holds nothing yet, and an existing
   * binding is never overwritten.
   */
  descriptor?: number[],
): Promise<boolean> {
  try {
    // x rides inside the signed payload — a MITM must not be able to strip or
    // renumber a share coordinate (silent reconstruction corruption).
    const payload = x !== undefined
      ? `recovery-share:${accountId}:${network}:${x}:${shareHex}:${ts}`
      : `recovery-share:${accountId}:${network}:${shareHex}:${ts}`;
    const sig = engineSign(payload, enginePriv);
    const res = await postJson(base, '/recovery-share', network, {
      accountId, share: shareHex, ts, sig,
      ...(x !== undefined ? { x } : {}),
      ...(descriptor ? { descriptor } : {}),
    }, timeoutMs);
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

// ── Share refresh (redundancy repair) ────────────────────────────────────────
//
// `n` is fixed when an account is created, so a set written while some relays
// were unreachable stays that small forever: an account created with two
// attesters up is 2-of-2 — lose either custodian and it is unrecoverable — and
// a relay returning later never receives a share. Same failure Phase 3 exists
// to prevent for content: durability is a FLOW, and a set fixed at creation
// degrades monotonically. So whenever the client legitimately holds the secret
// (right after creation or a successful recovery) it re-splits across every
// reachable attester, riding the relays' newest-signed-ts-wins rule.

/** One relay's answer to "do you hold a share for this account?" */
export interface ShareStatus {
  base: string;
  has: boolean;
  x: number | null;
  ts: number;
}

export interface RefreshPlan {
  /** Bases holding a share from the CURRENT (newest) split. */
  holders: string[];
  /** True when re-splitting would strictly increase the custodian count. */
  shouldRefresh: boolean;
  reason: string;
}

/**
 * Decide whether to re-split — pure, because getting this wrong DESTROYS
 * redundancy rather than merely failing to add it.
 *
 * Two rules, both load-bearing:
 *  - Only ever EXPAND. Re-splitting across fewer relays than currently hold
 *    shares would overwrite good custodians with a smaller set; a transient
 *    outage during a refresh would then quietly reduce durability, which is
 *    worse than the gap being repaired.
 *  - Count only CURRENT-generation holders. Shares from different splits
 *    combine into garbage, so a relay still holding an older split is not a
 *    usable custodian and must not be counted as one.
 */
export function planShareRefresh(statuses: readonly ShareStatus[]): RefreshPlan {
  const reachable = statuses.map(s => s.base);
  const held = statuses.filter(s => s.has);
  const newestTs = held.reduce((m, s) => Math.max(m, s.ts), 0);
  const holders = held.filter(s => s.ts === newestTs).map(s => s.base);
  if (reachable.length < 2) {
    return { holders, shouldRefresh: false, reason: 'fewer than 2 relays reachable — cannot maintain k=2' };
  }
  if (reachable.length <= holders.length) {
    return { holders, shouldRefresh: false, reason: `already spread across ${holders.length} custodian(s)` };
  }
  return {
    holders,
    shouldRefresh: true,
    reason: `${holders.length} custodian(s) for ${reachable.length} reachable relays`,
  };
}

/** Ask every base whether it holds a share (no secret material crosses). */
export async function fetchShareStatuses(
  bases: readonly string[],
  accountId: string,
  network: string,
  timeoutMs = 5_000,
): Promise<ShareStatus[]> {
  const results = await Promise.allSettled(
    bases.map(async (base) => {
      const res = await fetch(
        `${base}/recovery-share/status?accountId=${encodeURIComponent(accountId)}&network=${encodeURIComponent(network)}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = await res.json() as { has?: boolean; x?: number | null; ts?: number };
      return { base, has: !!body.has, x: body.x ?? null, ts: Number(body.ts ?? 0) };
    }),
  );
  // Unreachable relays are simply absent — never counted as non-holders, which
  // would make a transient outage look like lost redundancy and trigger a
  // pointless (and, per the expand-only rule, refused) re-split.
  return results.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []));
}

export interface RefreshResult {
  refreshed: boolean;
  /** Custodians holding a usable, current-generation share afterwards. */
  custodians: number;
  reason: string;
}

/**
 * Split the targets into the two groups the write order depends on.
 *
 * Pure so the ORDER — the thing that makes a refresh safe or destructive — is
 * unit-testable. A relay holding a stale-generation share counts as a
 * non-holder: its share cannot combine with the current pair, so it has
 * nothing to lose and is safe to write first.
 */
export function orderRefreshTargets(
  statuses: readonly ShareStatus[],
  plan: RefreshPlan,
): { nonHolders: string[]; holders: string[] } {
  const holderSet = new Set(plan.holders);
  return {
    nonHolders: statuses.map(s => s.base).filter(b => !holderSet.has(b)),
    holders: statuses.map(s => s.base).filter(b => holderSet.has(b)),
  };
}

/**
 * Repair redundancy: re-split the secret across every reachable attester.
 *
 * ⚠ WRITE ORDER IS THE SAFETY PROPERTY, not an optimisation. Writing a
 * new-generation share to a relay INVALIDATES the old-generation share it was
 * holding (they cannot combine), so a naive "write to everyone at once" that
 * partially fails can strand exactly one new share and leave the old holders
 * one short — turning a healthy account into an unrecoverable one. That is not
 * hypothetical: it happened in dev on 2026-08-15, breaking a live account.
 *
 * So the write runs in two phases with an invariant: **at every moment, either
 * the old generation still has ≥2 holders, or the new generation does.**
 *
 *  1. Non-holders first — they hold nothing usable, so a failure costs nothing.
 *     If NONE accepts, abort without touching the holders: there was nothing to
 *     gain, and touching them could only do harm. (This is the common case when
 *     a relay refuses because it never attested the account — see below.)
 *  2. Then convert the holders one at a time. A failed conversion leaves that
 *     relay's old share intact, so the old generation never drops below its
 *     starting count except by a conversion that already grew the new one.
 *     All holders are converted, not just enough to reach two, so the next
 *     session sees one consistent generation instead of re-triggering forever.
 *
 * Note a relay can only custody for a human it has ATTESTED (it binds
 * accountId→nid at store time and needs that binding to gate the release). A
 * relay that was down during account creation therefore refuses with 409 and
 * cannot be healed onto by a session sweep, which has no live descriptor to
 * offer. Creation and recovery pass one, so those paths can extend custody.
 */
export async function refreshShareRedundancy(
  bases: readonly string[],
  accountId: string,
  network: string,
  secret: Uint8Array,
  enginePriv: string,
  descriptor?: number[],
  timeoutMs = 6_000,
): Promise<RefreshResult> {
  const statuses = await fetchShareStatuses(bases, accountId, network, timeoutMs);
  const plan = planShareRefresh(statuses);
  if (!plan.shouldRefresh) {
    return { refreshed: false, custodians: plan.holders.length, reason: plan.reason };
  }
  const { nonHolders, holders } = orderRefreshTargets(statuses, plan);
  const targets = [...nonHolders, ...holders];
  const ts = Date.now();
  const shares = shamirSplit(secret, targets.length);
  const shareFor = new Map(targets.map((b, i) => [b, shares[i]]));
  const write = (base: string) => {
    const s = shareFor.get(base)!;
    return storeOnRelay(base, accountId, network, hex(s.data), s.x, enginePriv, ts, timeoutMs, descriptor);
  };

  // ── phase 1: relays with nothing to lose ──
  let newGen = 0;
  for (const base of nonHolders) if (await write(base)) newGen++;
  if (newGen === 0) {
    return {
      refreshed: false,
      custodians: plan.holders.length,
      reason: `no new custodian accepted a share (a relay that never attested this account cannot hold one) — existing set left untouched`,
    };
  }

  // ── phase 2: convert current holders, sequentially ──
  for (const base of holders) if (await write(base)) newGen++;

  if (newGen < 2) {
    // Only reachable when the account was ALREADY below threshold before this
    // call (a single current-generation holder), so nothing was made worse.
    return { refreshed: false, custodians: newGen, reason: `only ${newGen} custodian(s) accepted — account was already below threshold` };
  }
  return { refreshed: true, custodians: newGen, reason: `re-split across ${newGen} of ${targets.length} relays` };
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
