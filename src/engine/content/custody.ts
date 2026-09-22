import { MAX_OFFLINE_MS, HEARTBEAT_INTERVAL_MS } from './provider-ledger.js';

/**
 * Custody policy: what counts as a replica, when to repair, and what a returning
 * node keeps.
 *
 * `provider-ledger.ts` is the on-chain half — it answers "is this provider's
 * lease live?" from signed evidence. This module is the half that acts on that
 * answer: which holders count toward durability, which have to be replaced, what
 * a node discards when its own lease lapsed while it was away, and how often any
 * of that may be asked.
 *
 * Everything here is a pure function or a small counter with no I/O, because the
 * shape of the rules is the part worth pinning: the network layer that calls
 * them (`src/network/storage-manager.ts`) is covered by no test at all.
 *
 * ## The two rules everything else follows from
 *
 * **Durability is a FLOW.** Content survives because the network re-places the
 * minimum replica count faster than holders are lost — not because many copies
 * exist. A replica count that includes offline or unproven holders is not a
 * measurement, it is a guess, and the first honest failure takes the object
 * below the threshold that the guess said was met. So `liveHolders` is the only
 * count allowed to satisfy a target, and it is derived from the lease.
 *
 * **Verify on use, not continuously** (ARCHITECTURE.md → Fan-IN). Watching every
 * holder of every object costs `O(watchers × watched)`; discovering a dead holder
 * when a fetch actually fails costs `O(use)`. Content nobody reads is exactly the
 * content whose holder liveness matters least to a reader — its durability is
 * still handled, but by the lease expiring, not by anyone watching.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Assigned, leased holders a CID should have. This is a DURABILITY number: it
 * counts only providers under a live lease that the network can hold responsible,
 * never the opportunistic caches that also serve the bytes (see `replicaTarget`).
 *
 * Lives here rather than in `storage-manager.ts` because the constant and the
 * rules that read it have to agree, and only one of the two files is tested.
 */
export const REDUNDANCY_TARGET = 10;

/**
 * Live leases a publish must reach before the uploader may treat the content as
 * handed over. Deliberately far below `REDUNDANCY_TARGET`: the target is where
 * repair steadies out, this is the point at which losing the uploader stops
 * destroying the content. Two rather than one because one holder plus a lease
 * expiry is zero.
 */
export const MIN_REPLICAS = 2;

/** Upper bound on `replicaTarget`, so demand cannot conscript unbounded capacity. */
export const MAX_REPLICA_TARGET = 30;

/**
 * Reads **per demand window** at which popularity starts adding assigned
 * holders. Below this a CID is ordinary and `REDUNDANCY_TARGET` is the whole
 * answer.
 *
 * A RATE, not a lifetime total (changed 2026-09-22, Lucian). The distinction is
 * the whole of demand-scaled replication: a lifetime counter only ever rises,
 * so a CID that went viral once would hold conscripted capacity for the rest of
 * its existence and the target could never come back down. It is also the
 * sustained half of the invariant failing in a cache — a value that grows with
 * history and never shrinks (ARCHITECTURE.md → *The invariant has two
 * dimensions*).
 */
export const POPULARITY_FLOOR = 10;

/**
 * The window demand is measured over: one hour at production timing.
 *
 * Derived from the heartbeat rather than hardcoded, so it compresses with
 * `STORAGE_TIMING=fast` (30 s) exactly like every other storage duration. A
 * fixed hour here would make demand-scaling untestable in a sitting, which is
 * the trap `fmtSpan` was written for — a fixed unit against a clock that moves.
 *
 * A function, not a constant, because `HEARTBEAT_INTERVAL_MS` is an `export
 * let` reassigned by `applyStorageTiming`; capturing it at module load is the
 * "two things measuring different things" failure this codebase keeps paying
 * for.
 */
export function demandWindowMs(): number {
  return HEARTBEAT_INTERVAL_MS / 4;
}

/**
 * Buckets the demand window is divided into. Six gives 10-minute granularity at
 * production timing: fine enough that the rate tracks a spike within the hour,
 * coarse enough that the per-CID cost is six numbers.
 */
export const DEMAND_BUCKETS = 6;

/**
 * Extra holders tolerated above target before any are released.
 *
 * Without it a target oscillating by one — which log2 growth does constantly
 * around a bucket boundary — would release and re-place a replica forever,
 * spending bandwidth to hold the same number of copies. Releasing is cheap and
 * re-placing is not, so the asymmetry is deliberate: drift up fast, shed slowly.
 */
export const RELEASE_HYSTERESIS = 1;

/**
 * Consecutive failed reads from one holder before its assignment is dropped.
 *
 * One is not evidence: a WebRTC dial through a flaky relay fails for reasons
 * that have nothing to do with whether the bytes are there, and evicting on it
 * would make every relay hiccup look like data loss and start a repair storm
 * against holders that were fine. Two consecutive failures, with a real fetch
 * attempt between them, is the cheapest thing that is actually evidence.
 */
export const FAILURES_BEFORE_EVICTION = 2;

// ── Counting replicas ────────────────────────────────────────────────────────

/** Does this provider hold a live custody lease? */
export type LivePredicate = (pub: string) => boolean;

/**
 * The holders that count. Everything else in this module measures durability
 * through this function, so there is exactly one place where "announced it once"
 * could be mistaken for "has it now".
 */
export function liveHolders(holders: Iterable<string>, isLive: LivePredicate): string[] {
  return [...holders].filter(isLive);
}

/**
 * How many assigned holders a CID should have, given its CURRENT read rate.
 *
 * `readsPerWindow` is reads in the last `demandWindowMs()` — an hour at
 * production timing — so this number falls again when demand falls. That is the
 * half that was missing until 2026-09-22: the input was a lifetime counter, so
 * the target could only ever rise.
 *
 * The base is durability and never moves: **every file has at least
 * `REDUNDANCY_TARGET` copies**, however unpopular. The surplus is fan-in: a CID
 * with a large audience must not turn its holders into a bottleneck, and
 * *popularity has to add serving capacity rather than only load*
 * (ARCHITECTURE.md → Fan-IN, principle 2).
 *
 * **Growth is LINEAR, capped** — one more copy per `POPULARITY_FLOOR` reads in
 * the window (Lucian's rule, adopted 2026-09-22 after measuring it). The
 * previous log2 curve was chosen to stop a viral object conscripting the fleet,
 * and `sim/demand-replication.ts` showed that fear was misplaced: over a Zipf
 * workload uncapped linear costs ~2x total fleet storage, not 100x, because the
 * tail sits at the floor. The real risk was concentration — one object
 * demanding 82,721 copies — and `MAX_REPLICA_TARGET` is what answers that, not
 * the shape of the curve.
 *
 * With both capped, log and linear differ by ~11% of fleet storage and 1.6
 * points of required cache hit rate. What differs materially is responsiveness:
 * linear reaches the cap at 200 reads/window where log needs ~5 million, so hot
 * content gets its copies while the demand is still there. That is the entire
 * point of demand-scaling, and performance on reads is the priority
 * (CUSTODY-PROOFS.md → Reframe: people abandon an image at three seconds).
 *
 * Screened before the switch: security is unchanged (same cap, same
 * attacker-written target, same clamp on arrival); performance improves where
 * it is felt and costs ~11% more storage; decentralisation improves slightly,
 * since more copies sooner means more nodes serving.
 *
 * The cap is not a tuning choice. This target travels inside a `CacheRequest`,
 * so it is a number an ATTACKER writes; `MAX_REPLICA_TARGET` is what stops a
 * publisher claiming unbounded capacity, and receivers clamp it again on
 * arrival.
 *
 * Note what this is NOT doing: opportunistic caches are never counted here,
 * because a cache is bandwidth and a lease is durability. This function only
 * raises the number of holders the network holds *responsible*.
 */
export function replicaTarget(readsPerWindow: number): number {
  if (!(readsPerWindow > 0)) return REDUNDANCY_TARGET;
  // One more copy per `POPULARITY_FLOOR` reads in the window — Lucian's rule,
  // adopted 2026-09-22 after the measurement showed the curve barely matters
  // once the cap is applied, and that this one reaches the cap far sooner.
  const surplus = Math.floor(readsPerWindow / POPULARITY_FLOOR);
  return Math.min(MAX_REPLICA_TARGET, REDUNDANCY_TARGET + surplus);
}

// ── Repair ───────────────────────────────────────────────────────────────────

export interface RepairPlan {
  /** Holders whose lease has lapsed — the network has re-homed their bytes. */
  drop: string[];
  /** Candidates to hand the content to, in the order given. */
  add: string[];
  /** Holders that still count right now — counted by distinct failure domain. */
  live: number;
  /** Holders still missing after `add` is placed (0 = the plan restores the target). */
  shortfall: number;
  /**
   * Assignments to hand back because demand fell: the lease obligation ends,
   * the BYTES stay as an uncounted spare (see `planEviction`). Never takes the
   * object below `REDUNDANCY_TARGET`.
   */
  release: string[];
}

/**
 * What repairing this CID requires: who to forget, and who to hand it to.
 *
 * Lapsed holders are *dropped*, not merely uncounted. Keeping them would grow
 * the holder set without bound as the fleet churns, and — worse — would leave a
 * record that reads like custody long after the lease that made it custody
 * expired. The lease already decided this: past `MAX_OFFLINE_MS` the network
 * treats those replicas as gone and repairs onto live nodes, so the holder set
 * has to agree or the two views of durability drift apart.
 *
 * `candidates` is whatever selection produced (scored, capacity-filtered,
 * geographically spread); this function only takes as many as the shortfall
 * needs and skips anyone already holding it.
 */
export function planRepair(args: {
  holders: Iterable<string>;
  isLive: LivePredicate;
  candidates: readonly string[];
  target?: number;
  /**
   * The failure domain a provider belongs to. **A replica is only a replica if
   * it is on an independent machine** (Lucian, 2026-09-22), and a distinct
   * public key does not establish that: multi-device custody gives one account
   * several keys, and two accounts can run on one box. Ten copies inside one
   * failure domain is one copy wearing ten names, and the redundancy is
   * fictional in exactly the situation redundancy exists for.
   *
   * Defaults to the pub itself, which is the old behaviour, so a caller that
   * has no domain information is no worse off than before. Callers that do —
   * `storage-manager.ts` has `deviceId` today — should pass it.
   */
  domainOf?: (pub: string) => string;
}): RepairPlan {
  const { holders, isLive, candidates, target = REDUNDANCY_TARGET } = args;
  const domainOf = args.domainOf ?? ((pub: string) => pub);
  const all = [...holders];
  const live = all.filter(isLive);
  const drop = all.filter(p => !isLive(p));

  // Count by DOMAIN, not by holder: two keys on one machine satisfy one slot.
  const liveDomains = new Set(live.map(domainOf));
  const need = Math.max(0, target - liveDomains.size);

  const held = new Set(all);
  const claimedDomains = new Set(liveDomains);
  const add: string[] = [];
  for (const c of candidates) {
    if (add.length >= need) break;
    if (held.has(c)) continue;
    const d = domainOf(c);
    // A new copy must be a new NODE. Skipping a candidate whose domain is
    // already represented is what makes "another copy" mean another machine.
    if (claimedDomains.has(d)) continue;
    held.add(c);
    claimedDomains.add(d);
    add.push(c);
  }

  // Shedding surplus when demand falls. Released newest-first: the holders
  // added for a popularity spike are the ones the spike conscripted, and the
  // long-standing ones have proven they serve. Never below REDUNDANCY_TARGET,
  // and never within the hysteresis band.
  const floor = Math.max(REDUNDANCY_TARGET, target);
  const surplus = liveDomains.size - floor;
  const release = surplus > RELEASE_HYSTERESIS
    ? live.slice(-(surplus - RELEASE_HYSTERESIS))
    : [];

  return { drop, add, live: liveDomains.size, shortfall: need - add.length, release };
}

/**
 * A duration in the largest unit that still says something.
 *
 * Hardcoded hours were wrong here: `MAX_OFFLINE_MS` scales with the active
 * timing profile, so under `STORAGE_TIMING=fast` (6-minute lease) the lapse
 * message read `lease lapsed 0h ago (max 0h)` — the same defect family as
 * `LAST REWARD -59066340h ago`, a fixed unit rendered against a clock that
 * moved. The unit has to follow the profile, or the one line that explains why
 * a node just discarded its entire disk is unreadable in exactly the profile
 * that discarding is tested under.
 */
function fmtSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  const h = Math.round(ms / 3_600_000);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * May the publisher delete its own copy now?
 *
 * **Authorship is not custody.** Published content is handed to the network;
 * the publisher is not automatically a replica and keeps no copy by default —
 * only for as long as the network has not finished taking custody
 * (ARCHITECTURE.md → Subsystem 4). Until this returns true the publisher's copy
 * is the only one in existence and the content is *staging*.
 *
 * The threshold is `MIN_REPLICAS`, not `REDUNDANCY_TARGET`, because that is
 * exactly what `MIN_REPLICAS` means: the point at which losing the uploader
 * stops destroying the content. Waiting for the full target before releasing
 * would pin every publisher's disk to a fleet that may simply not be that large
 * yet, and re-replication from the minimum up to the target is repair's job —
 * it pulls from the holders, not from the author.
 *
 * `live` must be LIVE holders, never "confirmed ever": releasing against a
 * remembered confirmation deletes the last real copy.
 */
export function mayReleasePublisherCopy(live: number): boolean {
  return live >= MIN_REPLICAS;
}

// ── Rejoin ───────────────────────────────────────────────────────────────────

export interface RejoinPlan {
  /** Foreign CIDs this node may go on serving. */
  keep: string[];
  /** Foreign CIDs to delete locally. */
  discard: string[];
  /** True when the absence outran the lease: everything foreign goes. */
  lapsed: boolean;
  /** Human-readable reason, for the log line that will be the only trace of this. */
  reason: string;
}

/**
 * What a node that has been away keeps, and what it throws out.
 *
 * Past `MAX_OFFLINE_MS` the lease is gone and, with it, every assignment: those
 * bytes were re-homed while the node was absent. Keeping them would (a) consume
 * the capacity the node is about to re-advertise for *current* assignments,
 * (b) inflate apparent redundancy with copies nobody is counting on, and
 * (c) grow without bound as a node accumulates everything it ever touched —
 * which is the storage tier's version of the `O(N)` violation this whole
 * architecture exists to remove. So: discard, re-declare capacity, refill from
 * whatever the network assigns next.
 *
 * Inside the lease, a restart costs nothing: the node is still assigned
 * everything it was assigned, so it keeps the lot. `released` carries the only
 * exception a provider can actually know about — CIDs an owner has since deleted
 * or replaced. A provider cannot otherwise self-determine that it was
 * unassigned; that judgement belongs to the owner's spot-check, which will
 * simply stop counting it.
 *
 * **Authorship buys no exemption, and this function is deliberately blind to
 * it.** `held` is foreign content — bytes held under a lease. A node's own
 * uploads are its own storage decision and are not in scope here, but they are
 * also not replicas: publishing hands content to the network, and the publisher
 * is not automatically one of its holders.
 */
export function planRejoin(args: {
  /** Time since the last lease renewal (heartbeat), or since registration if none. */
  offlineMs: number;
  /** Foreign CIDs currently on disk. */
  held: readonly string[];
  /** CIDs known to have been released — deleted or replaced by their owner. */
  released?: ReadonlySet<string>;
}): RejoinPlan {
  const { offlineMs, held, released } = args;
  const lapsed = offlineMs >= MAX_OFFLINE_MS;

  // KEEP THE BYTES. Reversed 2026-09-21 (Lucian's call).
  //
  // This used to discard every foreign byte once the lease had lapsed, on the
  // reasoning that the network had re-homed the content so holding an uncounted
  // copy was waste. That is tidiness winning over durability, and it is the
  // wrong trade: over-replication is cheap and safe, under-replication is the
  // risk, and the discarded bytes were redundancy the network had already spent
  // bandwidth creating. Deleting them converts a returning node from "extra
  // resilience, free" into "a node that must be re-fed".
  //
  // The decentralisation leg optimises for FLEXIBILITY and the speed at which
  // the network restores redundancy — cleanup is secondary
  // (PRINCIPLES.md → 3, CUSTODY-PROOFS.md → Reframe). So a lapsed lease stops
  // the copy COUNTING toward `REDUNDANCY_TARGET`; it does not stop it existing
  // or serving. Space is reclaimed under real pressure instead — `planEviction`.
  //
  // What a lapse still means, unchanged: `liveHolders` must not count this node,
  // or the durability figure becomes a guess again.
  const keep: string[] = [];
  const discard: string[] = [];
  for (const cid of held) (released?.has(cid) ? discard : keep).push(cid);

  return {
    keep,
    discard,
    lapsed,
    reason: lapsed
      ? `lease lapsed ${fmtSpan(offlineMs)} ago (max ${fmtSpan(MAX_OFFLINE_MS)}) — `
        + `keeping ${keep.length} CID(s) as uncounted spare redundancy`
        + (discard.length > 0 ? `, dropping ${discard.length} released by their owner` : '')
      : discard.length > 0
        ? `lease live — keeping ${keep.length} CID(s), dropping ${discard.length} released by their owner`
        : `lease live — keeping all ${keep.length} CID(s), no re-transfer needed`,
  };
}

/**
 * What to delete when the disk is actually full.
 *
 * This is where cleanup belongs: driven by SPACE PRESSURE, not by a clock. A
 * node discards only as much as it must to get back under its declared
 * capacity, and it discards the least useful bytes first.
 *
 * Order of sacrifice, least valuable first:
 *  1. CIDs their owner released — nobody wants these at all.
 *  2. Copies whose lease has lapsed (uncounted spares) — losing one costs the
 *     network nothing it is counting on.
 *  3. Leased copies, oldest-touched first — only if the first two were not
 *     enough, because dropping one of these really does reduce redundancy.
 *
 * Returns the CIDs to delete, in order, stopping as soon as enough space is
 * freed. Deleting more than necessary is the behaviour this replaces.
 */
export function planEviction(args: {
  /** Bytes currently used. */
  usedBytes: number;
  /** Bytes this node offered to provide. */
  capacityBytes: number;
  /** Candidates with their size and status, in any order. */
  held: ReadonlyArray<{ cid: string; bytes: number; leased: boolean; releasedByOwner?: boolean; lastTouched?: number }>;
}): { evict: string[]; freedBytes: number; reason: string } {
  const over = args.usedBytes - args.capacityBytes;
  if (over <= 0) {
    return { evict: [], freedBytes: 0, reason: 'within declared capacity — nothing to evict' };
  }

  const rank = (h: { leased: boolean; releasedByOwner?: boolean }): number =>
    h.releasedByOwner ? 0 : h.leased ? 2 : 1;
  const ordered = [...args.held].sort((a, b) =>
    rank(a) - rank(b) || (a.lastTouched ?? 0) - (b.lastTouched ?? 0));

  const evict: string[] = [];
  let freed = 0;
  for (const h of ordered) {
    if (freed >= over) break;
    evict.push(h.cid);
    freed += h.bytes;
  }
  return {
    evict,
    freedBytes: freed,
    reason: `over capacity by ${Math.round(over / 1e6)}MB — evicting ${evict.length} CID(s) `
      + `(released first, then uncounted spares, then leased)`,
  };
}

// ── Cadence ──────────────────────────────────────────────────────────────────

/**
 * A polling interval that does not turn a growing population into growing load
 * on whoever answers.
 *
 * `P` clients on a fixed interval `T` hit the answering tier at `P/T`. Holding
 * that rate constant would need `T ∝ P`, which makes a large network's data
 * uselessly stale; leaving `T` fixed makes the answering tier's cost `O(N)` —
 * the scale invariant violated from the fan-in side, which is the direction that
 * is easy to miss because no single node is holding anything extra. The
 * compromise is sub-linear: `T = base × √(P / ref)`, clamped, so aggregate load
 * grows as `√P` and freshness degrades as `√P` instead of either growing as `P`.
 *
 * **The jitter is not decoration.** A million clients that computed the same
 * interval from the same population estimate fire together, and the tier sees
 * the entire population inside one round-trip no matter how large the average
 * interval was. This is the same reasoning as the heartbeat's ±5 min jitter,
 * applied to queries.
 *
 * Below `refPopulation` this returns `base` — a two-relay dev network should not
 * pay for a scale it does not have.
 */
export function pollIntervalMs(
  baseMs: number,
  population: number,
  opts: {
    /** Population at which `baseMs` is the right cadence. */
    refPopulation?: number;
    maxMs?: number;
    /** Spread each caller uniformly over ±this fraction of the interval. */
    jitterFrac?: number;
    rand?: () => number;
  } = {},
): number {
  const {
    refPopulation = 100,
    maxMs = 6 * 60 * 60 * 1000,
    jitterFrac = 0.2,
    rand = Math.random,
  } = opts;

  const scale = Math.max(1, Math.sqrt(Math.max(1, population) / Math.max(1, refPopulation)));
  const scaled = Math.min(maxMs, baseMs * scale);
  const jitter = scaled * jitterFrac * (rand() * 2 - 1);
  return Math.max(1, Math.round(scaled + jitter));
}

// ── Use-driven evidence ──────────────────────────────────────────────────────

/**
 * The evidence repair runs on: how much a CID is read, and which holders failed
 * to serve it.
 *
 * In-memory and lossy on purpose. Both signals are local observations of local
 * usage — the only measurements a relay cannot bias and the only ones that stay
 * bounded by what this node actually does (ARCHITECTURE.md → Fan-IN: network-wide
 * uptime history is deliberately abandoned). Losing them on restart costs a
 * little re-learning and nothing else; persisting them would invite treating a
 * stale local opinion as a network fact.
 */
export class CustodySignals {
  /**
   * Reads per CID as a SLIDING WINDOW, not a lifetime total.
   *
   * A ring of `DEMAND_BUCKETS` counters plus the bucket index they start at.
   * Advancing zeroes whatever the clock has passed, so the sum is always "reads
   * in the last `demandWindowMs()`" and it falls on its own when reading stops.
   * No timer is involved: buckets are advanced lazily whenever the CID is
   * touched, which costs O(1) and cannot leak a callback.
   *
   * An exponential decay would have been fewer lines, but its value is not a
   * quantity anyone can state — a decayed count under constant load settles at
   * `rate / ln 2`, which is a number you have to apologise for in the UI. This
   * sums to a real measured rate, which matters because it is rendered.
   */
  private readonly demand = new Map<string, { buckets: number[]; startBucket: number }>();
  private readonly failures = new Map<string, number>();

  /** Which absolute bucket `now` falls in. */
  private bucketIndex(now: number): number {
    return Math.floor(now / (demandWindowMs() / DEMAND_BUCKETS));
  }

  /**
   * Roll the ring forward to `now`, zeroing every bucket the clock passed.
   * Returns the entry, or undefined if the CID was never read.
   */
  private advance(cid: string, now: number): { buckets: number[]; startBucket: number } | undefined {
    const e = this.demand.get(cid);
    if (!e) return undefined;
    const idx = this.bucketIndex(now);
    const elapsed = idx - e.startBucket;
    if (elapsed <= 0) return e;
    if (elapsed >= DEMAND_BUCKETS) {
      e.buckets.fill(0);
    } else {
      for (let k = 1; k <= elapsed; k++) e.buckets[(e.startBucket + k) % DEMAND_BUCKETS] = 0;
    }
    e.startBucket = idx;
    return e;
  }

  private key(cid: string, pub: string): string {
    return `${cid} ${pub}`;
  }

  /**
   * Mean service time per CID, as an EWMA — the second half of the concurrency
   * estimate. Kept beside the rate because the two are only meaningful together.
   */
  private readonly latencyMs = new Map<string, number>();

  /** A successful read of this CID — demand, which feeds `replicaTarget`. */
  recordRead(cid: string, now: number = Date.now(), serviceMs?: number): void {
    const idx = this.bucketIndex(now);
    let e = this.advance(cid, now);
    if (!e) {
      e = { buckets: new Array(DEMAND_BUCKETS).fill(0), startBucket: idx };
      this.demand.set(cid, e);
    }
    e.buckets[idx % DEMAND_BUCKETS]! += 1;
    if (serviceMs !== undefined && serviceMs > 0) {
      const prev = this.latencyMs.get(cid);
      // EWMA at 0.3: recent enough to track a change in conditions, smooth
      // enough that one slow fetch does not rewrite the estimate.
      this.latencyMs.set(cid, prev === undefined ? serviceMs : prev * 0.7 + serviceMs * 0.3);
    }
  }

  /**
   * Concurrent readers of this CID, DERIVED (PRINCIPLES.md → 5) from two
   * measured quantities by Little's Law: `L = λ × W`, average concurrency is
   * arrival rate times average service time.
   *
   * Derived rather than counted deliberately. Counting in-flight reads would
   * need begin/end bookkeeping threaded through every read path, and a gauge
   * that leaks a decrement — a throw between begin and end — reports phantom
   * load forever and quietly conscripts replicas. Both inputs here already
   * exist and both decay on their own, so the estimate cannot get stuck.
   *
   * Returns 0 when either input is missing, which callers must read as "no
   * evidence" and not as "no demand".
   */
  concurrentReads(cid: string, now: number = Date.now()): number {
    const perWindow = this.reads(cid, now);
    const serviceMs = this.latencyMs.get(cid);
    if (perWindow <= 0 || !serviceMs || serviceMs <= 0) return 0;
    const ratePerMs = perWindow / demandWindowMs();
    return ratePerMs * serviceMs;
  }

  /** Reads in the last `demandWindowMs()` — a rate, and it falls again. */
  reads(cid: string, now: number = Date.now()): number {
    const e = this.advance(cid, now);
    if (!e) return 0;
    let sum = 0;
    for (const b of e.buckets) sum += b;
    return sum;
  }

  /** This CID's current assigned-holder target, given its current read rate. */
  targetFor(cid: string, now: number = Date.now()): number {
    return replicaTarget(this.reads(cid, now));
  }

  /**
   * Drop CIDs whose demand has fallen to zero. Returns how many went.
   *
   * The map is keyed by a CID any peer can cause us to read, so *something* has
   * to remove an entry or this is unbounded state keyed by an outsider's choice
   * (SCREENING.md → 1). Cheap and idempotent — call it from whatever loop is
   * already running.
   */
  sweepDemand(now: number = Date.now()): number {
    let removed = 0;
    for (const cid of [...this.demand.keys()]) {
      if (this.reads(cid, now) === 0) {
        this.demand.delete(cid);
        this.latencyMs.delete(cid);
        removed++;
      }
    }
    return removed;
  }

  /**
   * A holder served the bytes. Clears its failure streak — the counter is
   * *consecutive* failures, so one success means the previous failure was
   * transport, not loss.
   */
  recordSuccess(cid: string, pub: string): void {
    this.failures.delete(this.key(cid, pub));
  }

  /** A holder failed to serve. Returns the new consecutive-failure count. */
  recordFailure(cid: string, pub: string): number {
    const k = this.key(cid, pub);
    const n = (this.failures.get(k) ?? 0) + 1;
    this.failures.set(k, n);
    return n;
  }

  /** Has this holder failed often enough to lose the assignment? */
  shouldEvict(cid: string, pub: string): boolean {
    return (this.failures.get(this.key(cid, pub)) ?? 0) >= FAILURES_BEFORE_EVICTION;
  }

  /** Drop every signal for a CID (deleted, replaced, or no longer tracked). */
  forget(cid: string): void {
    this.demand.delete(cid);
    this.latencyMs.delete(cid);
    const prefix = `${cid} `;
    for (const k of this.failures.keys()) if (k.startsWith(prefix)) this.failures.delete(k);
  }

  clear(): void {
    this.demand.clear();
    this.latencyMs.clear();
    this.failures.clear();
  }
}
