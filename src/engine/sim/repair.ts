import { planRepair, planRejoin, REDUNDANCY_TARGET } from '../content/custody.js';
import { MAX_OFFLINE_MS } from '../content/provider-ledger.js';

/**
 * Durability is a FLOW — measured, not asserted.
 *
 * `archival.ts` measures the *assignment*: that K holders per account can be
 * derived without a coordinator and that no node is required to hold everything.
 * That is a statement about a stock — how many copies exist — and it is the half
 * that is easy to get right. The half that actually keeps content alive is the
 * rate:
 *
 * > Content survives iff the network restores `REDUNDANCY_TARGET` **live**
 * > replicas faster than holders are lost. Repair throughput ≥ churn rate ×
 * > object size.
 *
 * Until this file existed, that sentence was a design claim with nothing behind
 * it: `archival.ts` models churn but not lease expiry, and not repair at all, so
 * a configuration where repair could never keep up would have measured exactly
 * as healthy as one where it trivially could.
 *
 * What this simulates, per tick:
 *
 *   1. online nodes fail (`churnPerTick`), offline nodes return (`rejoinPerTick`);
 *   2. an absence longer than the LEASE lapses that node's assignments — the
 *      replicas stop counting *without anyone noticing*, which is the whole
 *      point of leases and the reason repair can be lazy;
 *   3. a returning node runs the real `planRejoin`, so a long absence discards
 *      its content instead of resurrecting replicas the network re-homed;
 *   4. repair runs `planRepair` against a bounded budget of placements per tick —
 *      the throughput term in the inequality above.
 *
 * Steps 3 and 4 call the SHIPPING policy from `content/custody.ts` rather than a
 * model of it, so this measures the code, not a paraphrase of it. Everything is
 * seeded and deterministic: a durability result that changed between runs would
 * be useless as a threshold.
 */

// ── Deterministic PRNG ───────────────────────────────────────────────────────

/** mulberry32 — small, seeded, and good enough for churn coin-flips. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Config / results ─────────────────────────────────────────────────────────

export interface RepairScenarioConfig {
  /** Distinct objects (CIDs) the network is keeping alive. */
  objects: number;
  /** Storage nodes available to hold them. */
  fleet: number;
  /** Live holders each object must have. */
  redundancy?: number;
  /** Ticks a node may be absent before its lease lapses. One tick = one hour by convention. */
  leaseTicks?: number;
  /** Per-tick probability an online node goes offline. */
  churnPerTick: number;
  /** Per-tick probability an offline node returns. */
  rejoinPerTick: number;
  /**
   * Replica placements the network can COMPLETE per tick — the throughput term.
   * This is bandwidth ÷ object size in disguise, and it is the parameter the
   * whole flow property turns on.
   */
  repairPerTick: number;
  /** Objects one node may hold. Bounds the fleet the way declared capacity does. */
  capacityPerNode?: number;
  ticks: number;
  seed?: number;
}

export interface RepairStats {
  config: Required<RepairScenarioConfig>;
  /** Fewest live holders any object had at any point. */
  minLiveReplicas: number;
  /** Live holders averaged over objects at the end of the run. */
  finalMeanReplicas: number;
  /** Objects that spent at least one tick below the target. */
  everUnderReplicated: number;
  /** Objects that reached ZERO live holders — content actually lost. */
  lost: number;
  /** Replica-assignments lost to lease expiry per tick, averaged over the run. */
  churnRate: number;
  /** Replica placements completed per tick, averaged over the run. */
  repairRate: number;
  /** Placements the shortfall asked for but the budget could not fund, per tick. */
  starvedRate: number;
  /**
   * The flow property held: no object was ever lost, and the run ended with the
   * target restored. Note this is deliberately NOT "repairRate ≥ churnRate" —
   * that ratio reads 1.0 in a steady state whether the steady state is healthy
   * or collapsed, because a network holding zero replicas also loses zero per
   * tick. The stock at the end is what says which one happened.
   */
  durable: boolean;
}

// ── Scenario ─────────────────────────────────────────────────────────────────

export function runRepairScenario(config: RepairScenarioConfig): RepairStats {
  const full: Required<RepairScenarioConfig> = {
    redundancy: REDUNDANCY_TARGET,
    leaseTicks: Math.round(MAX_OFFLINE_MS / (60 * 60 * 1000)),   // 1 tick = 1h
    capacityPerNode: Math.ceil((config.objects * REDUNDANCY_TARGET) / Math.max(1, config.fleet)) * 3,
    seed: 1,
    ...config,
  };
  const { objects, fleet, redundancy, leaseTicks, churnPerTick, rejoinPerTick,
    repairPerTick, capacityPerNode, ticks, seed } = full;

  const rand = rng(seed);

  /** How long each node has been absent; 0 = online. */
  const offlineFor = new Int32Array(fleet);
  const online = (n: number) => offlineFor[n] === 0;
  /**
   * A lease lapses at `leaseTicks` of absence — exactly the rule `isLive` applies
   * to a heartbeat clock. Note the node is still *reachable-ish* the whole time;
   * what expires is the network's willingness to count it.
   */
  const leaseLive = (n: number) => offlineFor[n]! < leaseTicks;

  /** object → the nodes assigned to hold it. */
  const holders: Set<number>[] = Array.from({ length: objects }, () => new Set());
  /** node → the objects it physically holds (may exceed its live assignments). */
  const held: Set<number>[] = Array.from({ length: fleet }, () => new Set());

  const place = (obj: number, node: number) => {
    holders[obj]!.add(node);
    held[node]!.add(obj);
  };
  const unplace = (obj: number, node: number) => {
    holders[obj]!.delete(node);
    held[node]!.delete(obj);
  };

  // Seed the initial assignment round-robin, so the run starts at the target and
  // any shortfall observed later is caused by the churn under test.
  for (let o = 0; o < objects; o++) {
    for (let k = 0; k < redundancy; k++) place(o, (o * redundancy + k) % fleet);
  }

  let minLive = redundancy;
  const lostObjects = new Set<number>();
  let lapsedTotal = 0;
  let placedTotal = 0;
  let starvedTotal = 0;
  const everUnder = new Set<number>();

  for (let t = 0; t < ticks; t++) {
    // 1 — churn.
    for (let n = 0; n < fleet; n++) {
      if (online(n)) {
        if (rand() < churnPerTick) offlineFor[n] = 1;
      } else if (rand() < rejoinPerTick) {
        // 3 — a returning node runs the real rejoin policy. Past the lease it
        // discards everything: those bytes were re-homed while it was away, and
        // keeping them would consume the capacity it is re-advertising while
        // inflating apparent redundancy with copies nobody counts.
        const plan = planRejoin({
          offlineMs: offlineFor[n]! * 60 * 60 * 1000,
          held: [...held[n]!].map(String),
        });
        for (const cid of plan.discard) unplace(Number(cid), n);
        offlineFor[n] = 0;
      } else {
        offlineFor[n] = offlineFor[n]! + 1;
      }
    }

    // 2 — lease expiry. Nothing "notices" the node left; the assignment simply
    // stops counting, which is what makes lazy repair safe.
    for (let n = 0; n < fleet; n++) {
      if (leaseLive(n)) continue;
      for (const o of [...held[n]!]) {
        if (holders[o]!.delete(n)) lapsedTotal++;
      }
    }

    // 4 — repair, against a bounded budget. This is the throughput term; below
    // the churn rate the replica stock falls monotonically no matter how the
    // rest of the system is designed.
    let budget = repairPerTick;
    const freeSpace = (n: number) => capacityPerNode - held[n]!.size;
    // Every object is planned every tick even after the budget is spent —
    // otherwise the unfunded demand of the objects the loop never reached would
    // be invisible, and `starvedRate` would read 0 in exactly the collapse this
    // scenario exists to detect. Only *placement* is budgeted.
    //
    // The starting offset rotates so the budget is not spent on the same
    // low-numbered objects every tick. There is no global repair scheduler in the
    // real system — each owner repairs its own content — and index order would be
    // a scheduler, and a maximally unfair one.
    for (let i = 0; i < objects; i++) {
      const o = (i + t) % objects;
      const candidates: number[] = [];
      for (let n = 0; n < fleet && candidates.length < redundancy * 2; n++) {
        if (leaseLive(n) && online(n) && freeSpace(n) > 0 && !holders[o]!.has(n)) candidates.push(n);
      }
      const plan = planRepair({
        holders: [...holders[o]!].map(String),
        isLive: p => leaseLive(Number(p)),
        candidates: candidates.map(String),
        target: redundancy,
      });
      for (const gone of plan.drop) unplace(o, Number(gone));
      let placed = 0;
      for (const add of plan.add) {
        if (budget <= 0) break;
        budget--;
        place(o, Number(add));
        placed++;
        placedTotal++;
      }
      // Both causes of unmet demand: placements the budget could not fund
      // (throughput) and holders the fleet could not offer (capacity).
      starvedTotal += (plan.add.length - placed) + plan.shortfall;
    }

    // Measure the STOCK, which is the only thing that says whether the flow won.
    for (let o = 0; o < objects; o++) {
      let live = 0;
      for (const n of holders[o]!) if (leaseLive(n)) live++;
      if (live < redundancy) everUnder.add(o);
      if (live === 0) lostObjects.add(o);
      if (live < minLive) minLive = live;
    }
  }

  let finalSum = 0;
  for (let o = 0; o < objects; o++) {
    for (const n of holders[o]!) if (leaseLive(n)) finalSum++;
  }
  const finalMeanReplicas = finalSum / objects;

  return {
    config: full,
    minLiveReplicas: minLive,
    finalMeanReplicas,
    everUnderReplicated: everUnder.size,
    lost: lostObjects.size,
    churnRate: lapsedTotal / ticks,
    repairRate: placedTotal / ticks,
    starvedRate: starvedTotal / ticks,
    durable: lostObjects.size === 0 && finalMeanReplicas >= redundancy,
  };
}
