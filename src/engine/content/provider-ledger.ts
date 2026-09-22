import { creditFromSignedReceipts, receiptPayload, MAX_RECEIPTS_PER_SETTLEMENT } from './read-receipts.js';
import { CustodyLiveness } from './custody-sampling.js';
import { verify } from '../core/keys.js';
import type { Block } from '../core/block.js';

/**
 * The storage-provider registry — on-chain custody accounting for Phase 3.
 *
 * Four block types drive it, all on the provider's OWN account chain:
 *   - `storage-register`   declare capacity (the upper bound offered to the network)
 *   - `storage-deregister` release the lease and leave
 *   (The heartbeat and reward block types were removed 2026-09-22: liveness is
 *   observed service, payment is reader-signed receipts settled in bulk.)
 *
 * The custody model this implements (decided 2026-08-10, see CLAUDE.md):
 * **durability is a flow property.** Content survives because the network
 * re-distributes the minimum replica count faster than holders are lost, not
 * because many copies exist. So a replica is never *owned*: it is held under a
 * liveness LEASE that expires `MAX_OFFLINE_MS` after the last heartbeat, and only
 * providers whose lease is live may be counted toward a redundancy target. A
 * provider that stops heartbeating stops being load-bearing automatically —
 * nothing has to notice it left.
 *
 * Pure and dependency-light (engine rule): no browser, no libp2p, no legacy app
 * types. `EngineLedger` composes it; `relay/` can too.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** Bytes in one gigabyte. */
export const GB_BYTES = 1_073_741_824;

/**
 * ⚠ DEV-ONLY TIMING PROFILES — see CLAUDE.md → *Remove before production*.
 *
 * At production timing a single storage cycle is a DAY: 4h between heartbeats,
 * six of them to a reward epoch, twelve hours before a lease lapses. Nothing in
 * the lease/repair/reward path can be exercised end-to-end in a sitting, so it
 * was being verified by reading the code — which is how "deregistering resets
 * the heartbeat clock" survived until someone thought to try it.
 *
 * `fast` divides every duration by 120: 2 min between heartbeats, a 12-minute
 * reward epoch, a 6-minute lease. Every RATIO is identical, so the rules being
 * tested are the rules that ship — only the clock moves.
 *
 * **Three things that will bite if forgotten.**
 *
 * 1. **Every node must agree.** These feed `validate()`: a peer on a different
 *    epoch length rejects a correctly-signed reward block MID-CHAIN and strands
 *    every block after it. Relays do not validate storage blocks (they check
 *    hash + signature only), so this is a client-side agreement — but in dev
 *    both devices load from one Vite server, so restart it for BOTH after
 *    changing `STORAGE_TIMING`, and confirm the badge on the Storage tab matches.
 * 2. **Switching profiles requires a wipe.** `epochDay` is
 *    `floor(timestamp / REWARD_EPOCH_MS)`, so the epoch numbering of an existing
 *    chain is meaningless under the other profile. Dev data is disposable
 *    (CLAUDE.md → *Development mode*); reset before switching.
 * 3. **`fast` must never ship.** A 6-minute lease on a real network would
 *    re-home every replica of every provider that closed a laptop lid.
 */
export interface StorageTimingProfile {
  name: string;
  heartbeatIntervalMs: number;
  /** Must be an exact multiple of the interval — see `MAX_HEARTBEATS_PER_EPOCH`. */
  epochMs: number;
}

export const STORAGE_TIMING_PROFILES: Record<string, StorageTimingProfile> = {
  normal: { name: 'normal', heartbeatIntervalMs: 4 * 60 * 60 * 1000, epochMs: 24 * 60 * 60 * 1000 },
  fast: { name: 'fast', heartbeatIntervalMs: 2 * 60 * 1000, epochMs: 12 * 60 * 1000 },
};

/** Target interval between heartbeat (lease-renewal) blocks. */
export let HEARTBEAT_INTERVAL_MS = STORAGE_TIMING_PROFILES.normal!.heartbeatIntervalMs;

/**
 * Slack on the heartbeat interval. Timers jitter and clocks drift, so a renewal
 * arriving slightly early still counts — without this a provider that fires at
 * 3h59m silently loses a sixth of its epoch's uptime credit.
 *
 * Derived rather than fixed, because a flat 60 s of slack on a 2-minute interval
 * would be half the interval: heartbeats would count at twice the honest rate
 * and the reward would follow. An eighth of the interval keeps the ratio the
 * production profile has (60 s of 4 h is well under an eighth, so `normal` keeps
 * exactly its measured 60 s).
 */
export let HEARTBEAT_GRACE_MS = 60_000;

/**
 * Heartbeats a fully-online provider produces per reward epoch (epoch ÷ interval).
 * Six under both profiles — the ratio is what the reward maths depends on, not
 * the wall-clock durations.
 */
export let MAX_HEARTBEATS_PER_EPOCH = 6;

/**
 * Hard ceiling on heartbeat blocks accepted per provider per epoch, counted or
 * not. Four times the honest rate — no amount of clock skew, timer jitter or
 * restart-storm reaches it, so the only chain that ever trips it is one
 * deliberately padding itself.
 *
 * This is the one place a storage block is rejected mid-chain, which strands
 * every later block on that chain (see `validate`). That is the intended
 * outcome here and is safe *only* because the bar is set far above honest
 * behaviour: without a ceiling, appending heartbeats is free for the spammer
 * and costs every peer holding that shard the bandwidth and disk to carry them.
 */
export let MAX_HEARTBEATS_PER_EPOCH_HARD = 4 * MAX_HEARTBEATS_PER_EPOCH;

/** Reward epoch. `epochDay = floor(timestamp / REWARD_EPOCH_MS)`. */
export let REWARD_EPOCH_MS = STORAGE_TIMING_PROFILES.normal!.epochMs;

/**
 * The most recent epoch a reward may be claimed for: the last **completed** day,
 * never the running one.
 *
 * A day's uptime is not known until the day is over, so pricing the current day
 * pays whatever fraction happens to have elapsed — and since a claim closes the
 * epoch for good, a provider polling for eligibility claims at the first
 * heartbeat and locks in 1/6 of what it earned. Settling a day behind makes the
 * evidence complete before it is priced, and makes the amount a function of the
 * chain rather than of when the claim ran.
 */
export function claimableEpochDay(now: number): number {
  return Math.floor(now / REWARD_EPOCH_MS) - 1;
}



/**
 * Uptime assumed for a provider whose chain we do not hold, when a number is
 * unavoidable (the score formula needs one). Neutral, matching `UNKNOWN_SCORE`
 * in provider-discovery: scoring the unknown as perfect made every node rank
 * strangers above itself, and scoring it as zero would do the reverse. Anywhere
 * a number is avoidable — every display — `uptimeFraction` returns `undefined`
 * and the UI shows "—".
 */
export const UNKNOWN_UPTIME = 0.5;

/**
 * How long a lease survives without a renewal before the provider is treated as
 * gone. Three heartbeat intervals (12h) — two missed renewals of slack, so a
 * reboot, a laptop lid, or a flaky hour does not cost a provider its assignments,
 * while a genuinely departed node stops counting toward redundancy within half a
 * day. This is the number the repair loop races: repair must re-place a replica
 * faster than leases expire, or durability decays.
 */
export let MAX_OFFLINE_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * Switch the timing profile. Every derived value is recomputed here — a value
 * captured at module load would keep the old profile's number and disagree with
 * the rest, which is the "two things measuring different things" failure this
 * codebase keeps paying for.
 *
 * Importers see the change: these are `export let`, so ESM live bindings carry
 * it. They are still read-only to every other module — only this one can assign.
 *
 * Call before any block is applied. Switching mid-chain re-numbers `epochDay`
 * under existing blocks and invalidates their rewards.
 */
export function applyStorageTiming(profile: StorageTimingProfile | string): StorageTimingProfile {
  const p = typeof profile === 'string' ? STORAGE_TIMING_PROFILES[profile] : profile;
  if (!p) throw new Error(`unknown storage timing profile: ${String(profile)}`);
  const perEpoch = p.epochMs / p.heartbeatIntervalMs;
  if (!Number.isInteger(perEpoch) || perEpoch < 1) {
    // Not pedantry: `rewardTerms` divides counted heartbeats by this, so a
    // fractional value pays a full-uptime provider something other than 1.0.
    throw new Error(`storage timing ${p.name}: epoch must be a whole number of intervals`);
  }
  HEARTBEAT_INTERVAL_MS = p.heartbeatIntervalMs;
  REWARD_EPOCH_MS = p.epochMs;
  MAX_HEARTBEATS_PER_EPOCH = perEpoch;
  MAX_HEARTBEATS_PER_EPOCH_HARD = 4 * perEpoch;
  MAX_OFFLINE_MS = 3 * p.heartbeatIntervalMs;
  HEARTBEAT_GRACE_MS = Math.min(60_000, Math.floor(p.heartbeatIntervalMs / 8));
  activeProfile = p;
  return p;
}

let activeProfile: StorageTimingProfile = STORAGE_TIMING_PROFILES.normal!;

/** Which profile is in force. Surfaced in the UI so a mismatch is visible, not silent. */
export function storageTiming(): StorageTimingProfile {
  return activeProfile;
}

// Selected at module load from the build-time define, so nothing can read a
// constant before the profile is applied. `__STORAGE_TIMING__` is baked by
// vite.config.ts from the STORAGE_TIMING env var; in Node (tests, relay,
// scripts) the global is absent and production timing is the default.
declare const __STORAGE_TIMING__: string | undefined;
try {
  const configured = typeof __STORAGE_TIMING__ === 'string' ? __STORAGE_TIMING__ : 'normal';
  if (configured !== 'normal') applyStorageTiming(configured);
} catch { /* unknown profile name — stay on production timing */ }

/**
 * Per-provider epoch records retained. Generous, because the only cost is a few
 * dozen bytes per provider per active day, and the only thing pruning can break
 * is validating an old reward block on replay (see `pruneEpochs`).
 */
const RETAIN_EPOCHS = 32;

/**
 * Recent heartbeat timestamps kept per provider — enough to count any full
 * epoch window. A function, not a constant: capturing it at module load would
 * freeze the production ring size onto a `fast` profile whose epoch holds the
 * same six heartbeats but arrives 120× sooner.
 */
const heartbeatRing = () => 2 * MAX_HEARTBEATS_PER_EPOCH;

// ── State ────────────────────────────────────────────────────────────────────

/**
 * A provider's live profile. Chain-derived fields are authoritative; the
 * `avgLatencyMs` / `spotCheckPassRate` pair is off-chain telemetry that the
 * network layer writes in (informational — it moves `score`, never the reward
 * ceiling, which only on-chain evidence may set).
 *
 * Field names match the legacy `StorageProvider` shape on purpose: `StorageManager`
 * reads and mutates these objects directly, and parity means it keeps working
 * against the engine without a rewrite.
 */
export interface StorageProviderState {
  pub: string;
  /** Stable device id — custody is per-device, not per-account. */
  deviceId: string;
  registeredAt: number;
  /** Declared capacity (GB) from the latest register block: an upper bound, not a claim of usage. */
  capacityGB: number;
  /**
   * Declared device class and concurrent-read offer from the register block.
   *
   * Both are self-reported, so they are a STARTING POINT for calibration and
   * never an answer: `effectiveCapacity` prefers what probers measured, and in
   * mandatory mode ignores these entirely until a measurement exists
   * (content/calibration.ts).
   */
  deviceClass?: string;
  declaredConcurrency?: number;
  /** Bytes actually held, as of the latest heartbeat that reported them. */
  lastActualStoredBytes: number;
  /** Timestamp of the most recent *counted* heartbeat — the lease renewal clock. */
  lastHeartbeat: number;
  heartbeatsLast24h: number;
  /** Current smoke/WebRTC address, from the latest heartbeat. */
  smokeAddr?: string;
  /** ISO 3166-1 alpha-2, self-reported; feeds geographic diversity in selection. */
  countryCode?: string;
  avgLatencyMs: number;
  spotCheckPassRate: number;
  score: number;
  /** Highest settlement period applied for this provider (-1 = never settled). */
  lastSettledPeriod?: number;
  /**
   * True when this record came from discovery rather than from a chain we hold
   * (see provider-discovery.ts). Its `score` and `heartbeatsLast24h` are NOT
   * measurements — we have no history for it — so they must be shown as
   * unknown, not as fact.
   */
  discovered?: boolean;
}

interface EpochRecord {
  /** Heartbeats in this epoch that satisfied the interval rule (spam is not counted). */
  heartbeats: number;
  /** Every heartbeat block seen in this epoch, counted or not — the flood ceiling. */
  submitted: number;
  /** Latest `storedBytes` reported inside this epoch, and when. */
  latestBytes: number;
  latestBytesAt: number;
}


export class ProviderLedger {
  /**
   * pub → live profile. Exposed directly (not a copy) because the network layer
   * mutates off-chain telemetry on these objects in place.
   */
  readonly providers = new Map<string, StorageProviderState>();

  /**
   * Providers learned by ASKING an archive rather than by holding their chain
   * (see provider-discovery.ts). Kept separate from `providers` on purpose:
   * these records are verified signatures, not verified chain state, so they may
   * feed *selection* but must never be mistaken for the authoritative view that
   * reward validation reads. Where both know a provider, authoritative wins.
   */
  private discovered = new Map<string, StorageProviderState>();

  /**
   * Per-account facts that **deregistering must not erase**.
   *
   * The heartbeat interval is what turns 6 heartbeats into a proof of 24 hours
   * of uptime, and it was held on the live profile — which `storage-deregister`
   * deletes. So `register → heartbeat → deregister → register → heartbeat → …`
   * reset `lastHeartbeat` to 0 every cycle, and `countsAsRenewal` treats 0 as
   * "first heartbeat, always due". A provider could bank a full day's uptime in
   * under a minute and claim the whole reward for capacity it never held
   * (measured: 6/6 counted heartbeats in 60 s, paying exactly what an honest
   * 24-hour day pays). Found by Lucian, 2026-08-15.
   *
   * `firstRegisteredAt` is durable for the same reason: re-registering would
   * otherwise refresh the initial lease grace, so an account could look live
   * forever without ever proving possession.
   *
   * The rule: leaving the storage ledger releases the LEASE. It does not launder
   * the account's history.
   */
  private readonly durable = new Map<string, { firstRegisteredAt: number; lastHeartbeat: number }>();

  private readonly epochs = new Map<string, Map<number, EpochRecord>>();
  /** pub → capacity changes over time, oldest first. One entry per register/deregister. */
  /**
   * Cumulative bytes already settled, per (provider, reader).
   *
   * Derived only from settle blocks that have been APPLIED, so every node that
   * holds the same chain holds the same baselines — which is what lets
   * validation be deterministic without anyone sharing receipt history.
   */
  private readonly settledBytes = new Map<string, Map<string, number>>();

  /** Highest settled period per provider, so a period can never be replayed. */
  private readonly lastSettledPeriod = new Map<string, number>();

  private readonly capacityHistory = new Map<string, { ts: number; capacityGB: number }[]>();
  /** pub → timestamps of recent counted heartbeats (bounded ring). */
  private readonly heartbeatTimes = new Map<string, number[]>();

  // ── Lease ──────────────────────────────────────────────────────────────────

  /**
   * Is this provider's lease still live? The only question that may gate counting
   * a replica toward a redundancy target — "declared capacity" and "once held it"
   * both survive a node that has been gone for a week, and neither keeps content
   * alive.
   */
  /**
   * Observed custody, feeding the lease.
   *
   * Populated from spot checks, reads and sampled challenges — evidence the
   * network generates anyway. This is what replaced the heartbeat as the
   * liveness signal: the heartbeat asked the holder, this watches what it did.
   */
  readonly liveness = new CustodyLiveness();

  /**
   * Is this provider still holding?
   *
   * **Answered by observation since 2026-09-22.** The heartbeat lease worked,
   * and cost a block per interval per provider forever — growth driven by the
   * clock rather than by anything a user did. Sampled reads answer the same
   * question from evidence that already exists.
   *
   * A registered provider nobody has probed yet is live for one window, so
   * joining is possible (Principle 1), and no longer after that, so being
   * unobserved is not a permanent free pass.
   */
  isLive(pub: string, now: number): boolean {
    const p = this.get(pub);
    if (!p || p.capacityGB <= 0) return false;
    this.liveness.noteRegistered(pub, p.registeredAt);
    return this.liveness.isLive(pub, now, MAX_OFFLINE_MS);
  }

  /**
   * A provider's record — the chain-backed one if we hold it, else whatever
   * discovery taught us. Every liveness/capacity question goes through here so
   * the two views cannot answer differently.
   */
  get(pub: string): StorageProviderState | undefined {
    return this.providers.get(pub) ?? this.discovered.get(pub);
  }

  /** When this provider's lease lapses (0 if it holds no lease at all). */
  leaseExpiresAt(pub: string): number {
    const p = this.get(pub);
    if (!p || p.capacityGB <= 0) return 0;
    return (p.lastHeartbeat > 0 ? p.lastHeartbeat : p.registeredAt) + MAX_OFFLINE_MS;
  }

  /** Every provider whose lease is live, best score first. */
  liveProviders(now: number): StorageProviderState[] {
    return this.allProviders().filter(p => this.isLive(p.pub, now));
  }

  /**
   * Every known registered provider, best score first — chains we hold plus
   * anything discovery taught us, with the authoritative record winning on
   * conflict. This is the selection pool; it is deliberately the widest view,
   * because a provider you have never heard of is one you can never hand
   * content to.
   */
  allProviders(): StorageProviderState[] {
    const merged = new Map<string, StorageProviderState>();
    for (const [pub, p] of this.discovered) merged.set(pub, p);
    for (const [pub, p] of this.providers) merged.set(pub, p);   // authoritative wins
    return [...merged.values()]
      .filter(p => p.capacityGB > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Replace what discovery knows. A whole-set replace rather than a merge, so a
   * provider that has deregistered actually disappears instead of lingering on a
   * stale record forever — the same "expand-only is wrong here" reasoning the
   * lease itself rests on.
   */
  setDiscovered(records: readonly StorageProviderState[]): void {
    this.discovered = new Map(records.map(r => [r.pub, r]));
  }

  /** Is this provider one we hold the chain for, or only heard about? */
  isAuthoritative(pub: string): boolean {
    return this.providers.has(pub);
  }

  /** Free bytes a provider is offering: declared capacity minus what it reports holding. */
  freeBytes(pub: string): number {
    const p = this.get(pub);
    if (!p) return 0;
    return Math.max(0, p.capacityGB * GB_BYTES - p.lastActualStoredBytes);
  }

  // ── Validation (shared by block creation and block application) ─────────────

    /**
   * The reward terms an epoch supports — the single source of truth for both
   * *issuing* a reward and *validating* someone else's. Legacy kept two copies of
   * this arithmetic in sync by comment ("compute the effective GB the same way
   * createStorageReward does"); one function means they cannot drift.
   *
   * Returns a string when no reward is owed at all.
   */
  /**
   * Validate a storage block against provider state. Returns an error string, or
   * null if the block may be applied.
   *
   * NOTE what is deliberately NOT rejected: a heartbeat that arrives too early.
   * Rejecting a block mid-chain truncates it, and every later block then fails as
   * non-sequential — the failure mode that made NFTs vanish on reload (see
   * `nftCustody` in engine-ledger). An early heartbeat is instead *accepted and not
   * counted*: it renews nothing, earns nothing, and the chain stays intact. Safety
   * comes from the reward ceiling, which only counts renewals.
   */
  /** Baselines for one provider — empty until its first settlement. */
  settledFor(pub: string): ReadonlyMap<string, number> {
    return this.settledBytes.get(pub) ?? new Map();
  }

  /**
   * What a settle block is worth, re-derived from the receipts it carries.
   *
   * Pure in everything that matters: the only state it reads is the settled
   * baselines, which come from applied blocks. Two nodes holding the same chain
   * cannot disagree.
   */
  settlementCredit(block: Block): { payableBytes: number; distinctReaders: number; reason: string } {
    const receipts = block.storage?.receipts ?? [];
    return creditFromSignedReceipts({
      provider: block.accountId,
      receipts: receipts.map(r => ({ receipt: r.receipt, signature: r.signature })),
      verify: (payload, signature, reader) => verify(signature, payload, reader),
      settledBytes: this.settledFor(block.accountId),
    });
  }

  validate(block: Block, now: number): string | null {
    switch (block.type) {
      case 'storage-register': {
        const cap = block.storage?.capacityGB;
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0) {
          return 'storage-register: capacityGB must be a positive number';
        }
        return null;
      }
      case 'storage-deregister': {
        const p = this.providers.get(block.accountId);
        if (!p || p.capacityGB <= 0) return 'storage-deregister: not a registered storage provider';
        return null;
      }
      case 'storage-settle': {
        const st = block.storage;
        if (!st) return 'storage-settle: missing storage payload';
        if (typeof st.periodIndex !== 'number') return 'storage-settle: missing periodIndex';
        const last = this.lastSettledPeriod.get(block.accountId) ?? -1;
        if (st.periodIndex <= last) {
          // Replaying a period would pay twice for the same bytes: the
          // baselines have already moved past them.
          return `storage-settle: period ${st.periodIndex} is not after ${last}`;
        }
        const receipts = st.receipts ?? [];
        if (receipts.length > MAX_RECEIPTS_PER_SETTLEMENT) {
          // Bounded so one block cannot be arbitrarily large. Readers that do
          // not fit simply settle next period — their baselines have not moved.
          return `storage-settle: ${receipts.length} receipts exceeds ${MAX_RECEIPTS_PER_SETTLEMENT}`;
        }
        const derived = this.settlementCredit(block);
        if (derived.payableBytes <= 0) return `storage-settle: ${derived.reason}`;
        const claimed = Number(block.amount ?? 0n);
        if (!(claimed > 0)) return 'storage-settle: amount must be positive';
        if (claimed > derived.payableBytes) {
          // THE check. The provider signs this block and is paid by it, and
          // still cannot choose the number: every node recomputes it from the
          // reader-signed receipts carried inside.
          return `storage-settle: amount ${claimed} exceeds ${derived.payableBytes} supported by receipts`;
        }
        return null;
      }

      default:
        return null;
    }
  }

  // ── Application ──────────────────────────────────────────────────────────────

  /** Fold a validated storage block into provider state. */
  apply(block: Block, now: number): void {
    switch (block.type) {
      case 'storage-register': return this.applyRegister(block);
      case 'storage-deregister': return this.applyDeregister(block);
      case 'storage-settle': return this.applySettle(block);
      default: return;
    }
  }

  private applyRegister(block: Block): void {
    const pub = block.accountId;
    const capacityGB = block.storage?.capacityGB ?? 0;
    const deviceClass = block.storage?.deviceClass;
    const declaredConcurrency = block.storage?.declaredConcurrency;
    const existing = this.providers.get(pub);
    // Seed from the durable record, so a deregister/re-register cycle inherits
    // the account's real registration age and heartbeat clock instead of a fresh
    // one. Without this, churning resets both and the uptime proof collapses.
    let d = this.durable.get(pub);
    if (!d) this.durable.set(pub, (d = { firstRegisteredAt: block.timestamp, lastHeartbeat: 0 }));
    const p: StorageProviderState = {
      pub,
      deviceId: block.storage?.deviceId ?? existing?.deviceId ?? '',
      registeredAt: d.firstRegisteredAt,
      capacityGB,
      deviceClass,
      declaredConcurrency,
      lastActualStoredBytes: existing?.lastActualStoredBytes ?? 0,
      lastHeartbeat: d.lastHeartbeat,
      heartbeatsLast24h: existing?.heartbeatsLast24h ?? 0,
      smokeAddr: existing?.smokeAddr,
      countryCode: existing?.countryCode,
      avgLatencyMs: existing?.avgLatencyMs ?? 0,
      spotCheckPassRate: existing?.spotCheckPassRate ?? 1,
      score: existing?.score ?? 1,
    };
    this.updateScore(p);
    this.providers.set(pub, p);
    this.pushCapacity(pub, block.timestamp, capacityGB);
  }

  private applyDeregister(block: Block): void {
    const pub = block.accountId;
    // The capacity history outlives the profile, and must: a provider that leaves
    // and later re-registers gets a fresh profile, but the gap still has to resolve
    // to 0 capacity. Without the closing entry, `capacityAtEpochStart` would walk
    // back past the gap to the *old* declaration and pay for days it was away.
    this.pushCapacity(pub, block.timestamp, 0);
    this.providers.delete(pub);
  }

  /**
   * Move the baselines so the same bytes can never be settled twice.
   *
   * Only receipts that actually verified are advanced, and only up to the
   * cumulative total they attested — so a receipt rejected during validation
   * leaves its reader's baseline untouched and it can settle later.
   */
  private applySettle(block: Block): void {
    const st = block.storage;
    if (!st || typeof st.periodIndex !== 'number') return;
    let baselines = this.settledBytes.get(block.accountId);
    if (!baselines) { baselines = new Map(); this.settledBytes.set(block.accountId, baselines); }
    for (const env of st.receipts ?? []) {
      const r = env.receipt;
      if (r.provider !== block.accountId || r.reader === r.provider) continue;
      if (!verify(env.signature, receiptPayload(r), r.reader)) continue;
      const prev = baselines.get(r.reader) ?? 0;
      if (r.bytesTotal > prev) baselines.set(r.reader, r.bytesTotal);
    }
    this.lastSettledPeriod.set(block.accountId, st.periodIndex);
    const p = this.providers.get(block.accountId);
    if (p) p.lastSettledPeriod = st.periodIndex;
  }

  /**
   * Composite score: uptime × latency × spot-check, each floored at 0.1 so one bad
   * signal cannot zero a provider out entirely. Earning rate projects the daily
   * reward at the current score, metered on bytes actually held (capped by declared
   * capacity) — declared-but-empty capacity earns nothing.
   */
      updateScore(p: StorageProviderState, now: number = Date.now()): void {
    // Uptime is scored against the heartbeats this provider could actually have
    // sent since it registered, not against a flat epoch's worth — see
    // `uptimeFraction`, which is the one definition every caller now shares.
    //
    // Uptime is no longer a factor: it was counted from heartbeat blocks, and
    // those are gone. What remains is observation — how fast a provider
    // answered, and whether it passed its spot checks — which is what a score
    // should have been built on anyway. A provider that is not live does not
    // reach scoring at all, because `isLive` gates custody first.
    const latencyFactor = p.avgLatencyMs > 0
      ? Math.max(0.1, Math.min(1, 1_000 / p.avgLatencyMs))
      : 1;
    const spotFactor = Math.max(0.1, Math.min(1, p.spotCheckPassRate));
    p.score = latencyFactor * spotFactor;
  }

  /** Drop all state (ledger reset). */
  clear(): void {
    this.providers.clear();
    this.discovered.clear();
    this.durable.clear();
    this.epochs.clear();
    this.capacityHistory.clear();
    this.heartbeatTimes.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private epochRecord(pub: string, epochDay: number): EpochRecord {
    let byEpoch = this.epochs.get(pub);
    if (!byEpoch) this.epochs.set(pub, (byEpoch = new Map()));
    let rec = byEpoch.get(epochDay);
    if (!rec) byEpoch.set(epochDay, (rec = { heartbeats: 0, submitted: 0, latestBytes: 0, latestBytesAt: 0 }));
    return rec;
  }

  /**
   * Retire epoch records older than the retention window — **per provider, against
   * that provider's own newest epoch**, never a global high-water mark. Chains
   * replay accountId-then-index: a global mark would be dragged to today by the
   * first account replayed, and the next account's month-old heartbeats would land
   * in already-pruned epochs, so its reward blocks would fail validation and
   * truncate its chain. Each account's own chain IS totally ordered, so pruning
   * relative to it is safe.
   */
  private pruneEpochs(pub: string, newestEpoch: number): void {
    const byEpoch = this.epochs.get(pub);
    if (!byEpoch || byEpoch.size <= RETAIN_EPOCHS) return;
    const cutoff = newestEpoch - RETAIN_EPOCHS;
    for (const epochDay of byEpoch.keys()) {
      if (epochDay < cutoff) byEpoch.delete(epochDay);
    }
  }

  private pushCapacity(pub: string, ts: number, capacityGB: number): void {
    let history = this.capacityHistory.get(pub);
    if (!history) this.capacityHistory.set(pub, (history = []));
    history.push({ ts, capacityGB });
  }

  private recordHeartbeatTime(pub: string, ts: number): void {
    let times = this.heartbeatTimes.get(pub);
    if (!times) this.heartbeatTimes.set(pub, (times = []));
    times.push(ts);
    const ring = heartbeatRing();
    if (times.length > ring) times.splice(0, times.length - ring);
  }
}
