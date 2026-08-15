import type { Block } from '../core/block.js';

/**
 * The storage-provider registry — on-chain custody accounting for Phase 3.
 *
 * Four block types drive it, all on the provider's OWN account chain:
 *   - `storage-register`   declare capacity (the upper bound offered to the network)
 *   - `storage-deregister` release the lease and leave
 *   - `storage-heartbeat`  the periodic liveness proof — **this is the lease renewal**
 *   - `storage-reward`     the daily self-issued mint, metered by the two above
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

/** Target interval between heartbeat (lease-renewal) blocks: ~4h. */
export const HEARTBEAT_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Slack on the heartbeat interval. Timers jitter and clocks drift, so a renewal
 * arriving up to a minute early still counts — without this a provider that fires
 * at 3h59m silently loses a sixth of its day's uptime credit.
 */
export const HEARTBEAT_GRACE_MS = 60_000;

/** Heartbeats a fully-online provider produces per reward epoch (24h / 4h). */
export const MAX_HEARTBEATS_PER_DAY = 6;

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
export const MAX_HEARTBEATS_PER_DAY_HARD = 4 * MAX_HEARTBEATS_PER_DAY;

/** Reward epoch: one day. `epochDay = floor(timestamp / REWARD_EPOCH_MS)`. */
export const REWARD_EPOCH_MS = 24 * 60 * 60 * 1000;

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

/** Base earning rate: 1 UNIT per stored GB per day, in milli-UNIT. */
export const BASE_STORAGE_RATE_MILLI = 1_000;

/**
 * How long a lease survives without a renewal before the provider is treated as
 * gone. Three heartbeat intervals (12h) — two missed renewals of slack, so a
 * reboot, a laptop lid, or a flaky hour does not cost a provider its assignments,
 * while a genuinely departed node stops counting toward redundancy within half a
 * day. This is the number the repair loop races: repair must re-place a replica
 * faster than leases expire, or durability decays.
 */
export const MAX_OFFLINE_MS = 3 * HEARTBEAT_INTERVAL_MS;

/**
 * Per-provider epoch records retained. Generous, because the only cost is a few
 * dozen bytes per provider per active day, and the only thing pruning can break
 * is validating an old reward block on replay (see `pruneEpochs`).
 */
const RETAIN_EPOCHS = 32;

/** Recent heartbeat timestamps kept per provider — enough to count any 24h window. */
const HEARTBEAT_RING = 2 * MAX_HEARTBEATS_PER_DAY;

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
  /** Bytes actually held, as of the latest heartbeat that reported them. */
  lastActualStoredBytes: number;
  /** Timestamp of the most recent *counted* heartbeat — the lease renewal clock. */
  lastHeartbeat: number;
  heartbeatsLast24h: number;
  /** epochDay of the last reward claimed (0 = never). */
  lastRewardEpoch: number;
  totalEarned: number;
  /** Current smoke/WebRTC address, from the latest heartbeat. */
  smokeAddr?: string;
  /** ISO 3166-1 alpha-2, self-reported; feeds geographic diversity in selection. */
  countryCode?: string;
  avgLatencyMs: number;
  spotCheckPassRate: number;
  score: number;
  earningRate: number;
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

/** What a reward for one epoch may claim, derived entirely from on-chain evidence. */
export interface RewardTerms {
  epochDay: number;
  storedGB: number;
  heartbeatCount: number;
  /** milli-UNIT ceiling. A reward block claiming more than this is invalid. */
  amount: number;
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
  isLive(pub: string, now: number): boolean {
    const p = this.get(pub);
    if (!p || p.capacityGB <= 0) return false;
    // A provider that registered but has not heartbeated yet is inside its initial
    // grace: the lease runs from registration until the first renewal is due.
    const since = p.lastHeartbeat > 0 ? p.lastHeartbeat : p.registeredAt;
    return now - since < MAX_OFFLINE_MS;
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
   * Would this heartbeat renew the lease, or is it early? Heartbeats are how uptime
   * is metered, so an unthrottled provider could mint a full day's reward in a
   * minute. Returns false for one that arrives inside the interval.
   */
  countsAsRenewal(pub: string, timestamp: number): boolean {
    if (!this.providers.has(pub)) return false;
    // Read the clock from the DURABLE record, never the live profile: the
    // profile is destroyed by a deregister, and a provider that can destroy its
    // own interval clock has no interval. See `durable`.
    const last = this.durable.get(pub)?.lastHeartbeat ?? 0;
    if (last === 0) return true;
    return timestamp - last >= HEARTBEAT_INTERVAL_MS - HEARTBEAT_GRACE_MS;
  }

  /**
   * The reward terms an epoch supports — the single source of truth for both
   * *issuing* a reward and *validating* someone else's. Legacy kept two copies of
   * this arithmetic in sync by comment ("compute the effective GB the same way
   * createStorageReward does"); one function means they cannot drift.
   *
   * Returns a string when no reward is owed at all.
   */
  rewardTerms(pub: string, epochDay: number): RewardTerms | string {
    const p = this.providers.get(pub);
    if (!p || p.capacityGB <= 0) return 'not a registered storage provider';
    if (p.lastRewardEpoch >= epochDay) return `epoch ${epochDay} already rewarded`;

    // Capacity as of the START of the epoch, never current capacity — otherwise a
    // provider bumps its declared GB minutes before claiming and is paid for a day
    // it never offered.
    const capacityAtStart = this.capacityAtEpochStart(pub, epochDay);
    if (capacityAtStart === 0) return 'not registered at epoch start';

    const heartbeatCount = this.heartbeatsInEpoch(pub, epochDay);
    if (heartbeatCount === 0) return 'no heartbeats recorded in this epoch';

    // Pay ONLY for bytes actually held, capped by what was declared at epoch
    // start. Storing nothing earns nothing — declared capacity is self-asserted,
    // so paying for it pays for a claim rather than for custody.
    //
    // This used to fall back to declared capacity when no bytes were reported, a
    // backward-compatibility rule carried over from the legacy ledger, where
    // heartbeats predating the `storedBytes` field had to stay claimable. That
    // premise does not exist here: `storage-heartbeat` is a new block type and
    // has carried `storedBytes` since its first line, so there are no such
    // chains. What the fallback actually did was pay a provider its full
    // declared rate for storing nothing — and, because the field is optional,
    // hand a free full-capacity reward to anyone who simply omitted it.
    const actualGB = this.storedGBInEpoch(pub, epochDay);
    const effectiveGB = Math.min(actualGB, capacityAtStart);
    const uptimeFactor = Math.min(heartbeatCount / MAX_HEARTBEATS_PER_DAY, 1);
    const amount = Math.floor(BASE_STORAGE_RATE_MILLI * effectiveGB * uptimeFactor);
    if (amount <= 0) return 'calculated reward is zero';

    return { epochDay, storedGB: effectiveGB, heartbeatCount, amount };
  }

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
      case 'storage-heartbeat': {
        const p = this.providers.get(block.accountId);
        if (!p || p.capacityGB <= 0) return 'storage-heartbeat: not a registered storage provider';
        // A future-dated heartbeat would extend a lease the provider has not earned
        // and inflate a not-yet-started epoch. Past-dated ones are fine — replaying
        // an old chain from disk must not reject its own history.
        if (block.timestamp > now + 10 * 60 * 1000) {
          return 'storage-heartbeat: timestamp too far in the future';
        }
        // The flood ceiling — the only mid-chain rejection here, deliberately set
        // 4× above the honest rate so only a padding chain reaches it. Counted off
        // the chain itself, so every node draws the line at the same block.
        const epochDay = Math.floor(block.timestamp / REWARD_EPOCH_MS);
        if (this.submittedInEpoch(block.accountId, epochDay) >= MAX_HEARTBEATS_PER_DAY_HARD) {
          return `storage-heartbeat: more than ${MAX_HEARTBEATS_PER_DAY_HARD} heartbeats in one epoch`;
        }
        return null;
      }
      case 'storage-reward': {
        const claimed = block.storage;
        if (!claimed || typeof claimed.epochDay !== 'number') return 'storage-reward: missing epochDay';
        if (block.amount === undefined || block.amount <= 0n) return 'storage-reward: amount must be positive';
        // A reward may ONLY bill the day before the block that carries it.
        //
        // This is what keeps the reward verifiable forever. Evidence is retained
        // for RETAIN_EPOCHS; a claim for anything older would find the heartbeats
        // pruned and be rejected — mid-chain, stranding every later block. Pinning
        // the claim to the block's own timestamp means the evidence is always one
        // day old, so the retention window can never be reached and there is no
        // second constant to keep below it. The rule is decidable from the block
        // alone, so every node agrees without holding any state: a violating block
        // is malformed, not merely unverifiable.
        const billable = claimableEpochDay(block.timestamp);
        if (claimed.epochDay !== billable) {
          return `storage-reward: may only claim epoch ${billable} (the day before this block), got ${claimed.epochDay}`;
        }
        const terms = this.rewardTerms(block.accountId, claimed.epochDay);
        if (typeof terms === 'string') return `storage-reward: ${terms}`;
        if (block.amount > BigInt(terms.amount)) {
          return `storage-reward: amount ${block.amount} exceeds maximum ${terms.amount} `
            + `(${terms.storedGB.toFixed(3)}GB × ${(terms.heartbeatCount / MAX_HEARTBEATS_PER_DAY).toFixed(2)} uptime)`;
        }
        if ((claimed.storedGB ?? 0) > terms.storedGB + 1e-9) {
          return `storage-reward: storedGB ${claimed.storedGB} exceeds allowed ${terms.storedGB.toFixed(3)}`;
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
      case 'storage-heartbeat': return this.applyHeartbeat(block, now);
      case 'storage-reward': return this.applyReward(block);
      default: return;
    }
  }

  private applyRegister(block: Block): void {
    const pub = block.accountId;
    const capacityGB = block.storage?.capacityGB ?? 0;
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
      lastActualStoredBytes: existing?.lastActualStoredBytes ?? 0,
      lastHeartbeat: d.lastHeartbeat,
      heartbeatsLast24h: existing?.heartbeatsLast24h ?? 0,
      lastRewardEpoch: existing?.lastRewardEpoch ?? 0,
      totalEarned: existing?.totalEarned ?? 0,
      smokeAddr: existing?.smokeAddr,
      countryCode: existing?.countryCode,
      avgLatencyMs: existing?.avgLatencyMs ?? 0,
      spotCheckPassRate: existing?.spotCheckPassRate ?? 1,
      score: existing?.score ?? 1,
      earningRate: 0,
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

  private applyHeartbeat(block: Block, now: number): void {
    const pub = block.accountId;
    const p = this.providers.get(pub);
    if (!p) return;

    // Address/geo/usage travel on every heartbeat, counted or not — they are
    // reports, not earnings, and stale routing data helps nobody.
    const s = block.storage;
    if (s?.smokeAddr) p.smokeAddr = s.smokeAddr;
    if (typeof s?.storedBytes === 'number' && s.storedBytes >= 0) p.lastActualStoredBytes = s.storedBytes;
    if (s?.countryCode && /^[A-Z]{2}$/.test(s.countryCode)) p.countryCode = s.countryCode;

    // Every heartbeat counts toward the flood ceiling, even one worth no uptime —
    // otherwise padding the chain with early blocks costs nothing at all.
    const epochDay = Math.floor(block.timestamp / REWARD_EPOCH_MS);
    const rec = this.epochRecord(pub, epochDay);
    rec.submitted += 1;

    // Only a heartbeat that satisfies the interval renews the lease or earns uptime.
    if (this.countsAsRenewal(pub, block.timestamp)) {
      p.lastHeartbeat = block.timestamp;
      const d = this.durable.get(pub);
      if (d) d.lastHeartbeat = block.timestamp;   // survives a deregister
      this.recordHeartbeatTime(pub, block.timestamp);
      rec.heartbeats += 1;
      if (typeof s?.storedBytes === 'number' && s.storedBytes >= 0 && block.timestamp >= rec.latestBytesAt) {
        rec.latestBytes = s.storedBytes;
        rec.latestBytesAt = block.timestamp;
      }
    }
    this.pruneEpochs(pub, epochDay);

    // Count against *now*, not the block timestamp: a block can be up to an
    // interval old, and a window anchored on it reads high, then drops on the next
    // restart when the count is recomputed against the wall clock.
    p.heartbeatsLast24h = this.countHeartbeatsLast24h(pub, now);
    this.updateScore(p);
  }

  private applyReward(block: Block): void {
    const p = this.providers.get(block.accountId);
    if (!p) return;
    const epochDay = block.storage?.epochDay;
    if (typeof epochDay !== 'number') return;
    p.lastRewardEpoch = epochDay;
    p.totalEarned += Number(block.amount ?? 0n);
    this.updateScore(p);
  }

  // ── Chain-derived evidence ───────────────────────────────────────────────────

  /** Counted heartbeats inside a reward epoch — what the reward is priced on. */
  heartbeatsInEpoch(pub: string, epochDay: number): number {
    return this.epochs.get(pub)?.get(epochDay)?.heartbeats ?? 0;
  }

  /** Every heartbeat block seen in an epoch, counted or not — what the ceiling bounds. */
  submittedInEpoch(pub: string, epochDay: number): number {
    return this.epochs.get(pub)?.get(epochDay)?.submitted ?? 0;
  }

  /** Latest reported stored GB inside a reward epoch (0 = nothing reported). */
  storedGBInEpoch(pub: string, epochDay: number): number {
    const rec = this.epochs.get(pub)?.get(epochDay);
    return rec ? rec.latestBytes / GB_BYTES : 0;
  }

  /** Declared capacity as it stood when an epoch began (0 = not registered then). */
  capacityAtEpochStart(pub: string, epochDay: number): number {
    const history = this.capacityHistory.get(pub);
    if (!history) return 0;
    const epochStart = epochDay * REWARD_EPOCH_MS;
    let capacity = 0;
    for (const entry of history) {
      if (entry.ts >= epochStart) break;
      capacity = entry.capacityGB;
    }
    return capacity;
  }

  /** Counted heartbeats in the 24h window ending at `refTime`. */
  countHeartbeatsLast24h(pub: string, refTime: number): number {
    const times = this.heartbeatTimes.get(pub);
    if (!times) return 0;
    const cutoff = refTime - REWARD_EPOCH_MS;
    return times.filter(t => t >= cutoff).length;
  }

  /**
   * Recompute the 24h counts and scores against the wall clock. Call after a chain
   * replay: the counts written during replay are relative to blocks that may be
   * hours old.
   */
  refresh(now: number): void {
    for (const p of this.providers.values()) {
      p.heartbeatsLast24h = this.countHeartbeatsLast24h(p.pub, now);
      this.updateScore(p);
    }
  }

  /**
   * Composite score: uptime × latency × spot-check, each floored at 0.1 so one bad
   * signal cannot zero a provider out entirely. Earning rate projects the daily
   * reward at the current score, metered on bytes actually held (capped by declared
   * capacity) — declared-but-empty capacity earns nothing.
   */
  updateScore(p: StorageProviderState): void {
    const uptimeFactor = Math.max(0.1, Math.min(1, p.heartbeatsLast24h / MAX_HEARTBEATS_PER_DAY));
    const latencyFactor = p.avgLatencyMs > 0
      ? Math.max(0.1, Math.min(1, 1_000 / p.avgLatencyMs))
      : 1;
    const spotFactor = Math.max(0.1, Math.min(1, p.spotCheckPassRate));
    p.score = uptimeFactor * latencyFactor * spotFactor;
    // Metered on bytes HELD, never on capacity offered — and by exactly the rule
    // `rewardTerms` pays by, so the projected rate cannot promise what the reward
    // will refuse. A provider holding nothing shows 0, which is what it earns.
    const effectiveGB = Math.min(p.lastActualStoredBytes / GB_BYTES, p.capacityGB);
    p.earningRate = Math.floor(BASE_STORAGE_RATE_MILLI * effectiveGB * p.score);
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
    if (times.length > HEARTBEAT_RING) times.splice(0, times.length - HEARTBEAT_RING);
  }
}
