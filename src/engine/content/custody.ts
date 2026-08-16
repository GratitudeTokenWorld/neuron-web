import { MAX_OFFLINE_MS } from './provider-ledger.js';

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
 * Reads at which popularity starts adding assigned holders. Below this a CID is
 * ordinary and `REDUNDANCY_TARGET` is the whole answer.
 */
export const POPULARITY_FLOOR = 100;

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
 * How many assigned holders a CID should have, given how much it is read.
 *
 * The base is durability and never moves. The surplus is fan-in: a CID with a
 * large audience must not turn its holders into a bottleneck, and *popularity
 * has to add serving capacity rather than only load* (ARCHITECTURE.md → Fan-IN,
 * principle 2). Growth is logarithmic — a hundred reads buys one more holder, a
 * thousand buys three — because demand is unbounded and capacity is not; a
 * linear response would let one viral object consume the fleet.
 *
 * Note what this is NOT doing: opportunistic caches (anyone who fetched the CID
 * and will serve it) already absorb most of a popularity spike for free, and
 * they are never counted here, because a cache is bandwidth and a lease is
 * durability. This function only raises the number of holders the network holds
 * *responsible*.
 */
export function replicaTarget(reads: number): number {
  if (!(reads > POPULARITY_FLOOR)) return REDUNDANCY_TARGET;
  const surplus = Math.floor(Math.log2(reads / POPULARITY_FLOOR)) + 1;
  return Math.min(MAX_REPLICA_TARGET, REDUNDANCY_TARGET + surplus);
}

// ── Repair ───────────────────────────────────────────────────────────────────

export interface RepairPlan {
  /** Holders whose lease has lapsed — the network has re-homed their bytes. */
  drop: string[];
  /** Candidates to hand the content to, in the order given. */
  add: string[];
  /** Holders that still count right now. */
  live: number;
  /** Holders still missing after `add` is placed (0 = the plan restores the target). */
  shortfall: number;
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
}): RepairPlan {
  const { holders, isLive, candidates, target = REDUNDANCY_TARGET } = args;
  const all = [...holders];
  const live = all.filter(isLive);
  const drop = all.filter(p => !isLive(p));
  const need = Math.max(0, target - live.length);

  const held = new Set(all);
  const add: string[] = [];
  for (const c of candidates) {
    if (add.length >= need) break;
    if (held.has(c)) continue;
    held.add(c);
    add.push(c);
  }

  return { drop, add, live: live.length, shortfall: need - add.length };
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

  if (offlineMs >= MAX_OFFLINE_MS) {
    return {
      keep: [],
      discard: [...held],
      lapsed: true,
      reason: `lease lapsed ${Math.round(offlineMs / 3_600_000)}h ago `
        + `(max ${Math.round(MAX_OFFLINE_MS / 3_600_000)}h) — content re-homed, discarding ${held.length} CID(s)`,
    };
  }

  const keep: string[] = [];
  const discard: string[] = [];
  for (const cid of held) (released?.has(cid) ? discard : keep).push(cid);
  return {
    keep,
    discard,
    lapsed: false,
    reason: discard.length > 0
      ? `lease live — keeping ${keep.length} CID(s), dropping ${discard.length} released by their owner`
      : `lease live — keeping all ${keep.length} CID(s), no re-transfer needed`,
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
  private readonly readCounts = new Map<string, number>();
  private readonly failures = new Map<string, number>();

  private key(cid: string, pub: string): string {
    return `${cid} ${pub}`;
  }

  /** A successful read of this CID — demand, which feeds `replicaTarget`. */
  recordRead(cid: string): void {
    this.readCounts.set(cid, (this.readCounts.get(cid) ?? 0) + 1);
  }

  reads(cid: string): number {
    return this.readCounts.get(cid) ?? 0;
  }

  /** This CID's current assigned-holder target, given the demand seen so far. */
  targetFor(cid: string): number {
    return replicaTarget(this.reads(cid));
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
    this.readCounts.delete(cid);
    const prefix = `${cid} `;
    for (const k of this.failures.keys()) if (k.startsWith(prefix)) this.failures.delete(k);
  }

  clear(): void {
    this.readCounts.clear();
    this.failures.clear();
  }
}
