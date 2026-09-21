/**
 * Can storage work with NO payment at all?
 *
 * `storage-accounting.ts` measured what paying for custody on the ledger costs:
 * 2,555 blocks per provider per year, accruing with the clock rather than with
 * anything a user did. The reflex is to make the payment cheaper. The other
 * move — PRINCIPLES.md → 3, and Lucian's standing instruction to ask what can
 * be REMOVED — is to delete the payment and see whether the system still
 * stands up.
 *
 * What replaces it: **pairwise reciprocal service budgets**. Every node meters
 * every counterparty locally. Serving a peer earns credit WITH THAT PEER and
 * nobody else; spending credit is how you get served. Reads and writes are
 * throttled by that budget, and the budget rises with demonstrated
 * reciprocity — the "throttle, and raise the limit on trust" design.
 *
 * Why this is a security improvement and not merely a cheaper payment
 * (screened per PRINCIPLES.md → 4, security first):
 *
 *  - **There is no mintable value, so there is nothing to steal.** The open
 *    finding in SCREENING.md → 11 (rewards metered by self-report) disappears
 *    rather than being patched: a lie about bytes held buys credit only in the
 *    liar's own bookkeeping, where it is worth nothing.
 *  - **Credit is local and non-transferable, so collusion buys nothing.** Two
 *    nodes inflating each other's score change no third node's budget. This is
 *    the attack that defeats every receipt-based payment design, including the
 *    monotone-counter one — and here it is structurally absent rather than
 *    defended against.
 *  - **Observation replaces testimony.** A node raises a peer's budget because
 *    of transfers it performed itself. There is no claim to verify, so there is
 *    no claim to forge.
 *
 * The cost, stated because PRINCIPLES.md → 4 requires conflicts to be said out
 * loud: reciprocity is exclusionary by nature, and Principle 1 is about ACCESS.
 * A phone or an IoT sensor has little to give back. That is what `newPeerPrior`
 * is for — an unconditional floor every peer gets, always, before it has done
 * anything. The floor is the principle; the earned budget above it is the
 * mechanism, and the test that the floor holds is the one that matters most.
 *
 * Seeded and deterministic, like `repair.ts`: a result that changed between
 * runs would be an anecdote.
 */

/** mulberry32 — same generator as `repair.ts`, for the same reason. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type PeerKind = 'contributor' | 'freerider' | 'newcomer';

export interface ReciprocityParams {
  contributors: number;
  freeriders: number;
  newcomers: number;
  rounds: number;
  /** Requests each node issues per round. */
  requestsPerRound: number;
  /** Requests a node is willing to serve per round (its bandwidth). */
  capacityPerRound: number;
  /**
   * Free requests a node will serve each round for peers that have earned
   * nothing. The access floor — Principle 1 lives in this number.
   *
   * Read `priorPerPeer` before changing it: this is a budget the SERVER has,
   * not a grant each stranger has.
   */
  newPeerPrior: number;
  /**
   * How the floor is allocated, and the difference is the whole security of it.
   *
   * `false` (the design): `newPeerPrior` free serves per server per round,
   * shared among all strangers who ask. Bounded by the server's own generosity.
   *
   * `true` (the naive version): `newPeerPrior` free serves **per stranger**.
   * That is a subsidy keyed by something an attacker chooses — the shape
   * SCREENING.md → 1 warns about — so free-riding becomes free by spreading
   * requests across peers. Kept because the failure is worth measuring rather
   * than asserting.
   */
  priorPerPeer?: boolean;
  /** Credit earned with a peer for serving it once. */
  creditPerServe: number;
  /** Credit consumed at a peer for being served once. */
  costPerRequest: number;
  /** Per-round decay, so credit is a recent-behaviour signal, not a bank balance. */
  decay: number;
  /** Round at which newcomers join (they are absent before it). */
  newcomerJoinsAtRound: number;
  /**
   * How many distinct peers a node actually deals with — its working set.
   *
   * This turned out to be the parameter the whole design lives or dies on.
   * With partners drawn uniformly from the population, pairwise credit never
   * accumulates: at any real scale you never meet the same peer twice, so
   * every request is a first request and everyone is left on the floor.
   * Measured, not argued — see `reciprocity.test.ts`.
   *
   * The real topology is not uniform. Custody is an ASSIGNMENT to k named
   * holders, a node follows the same accounts for months, and repair talks to
   * the holders of content it already cares about. `0` means "uniform", i.e.
   * the pessimal case, and is kept so the failure stays reproducible.
   */
  neighbourhood: number;
  /**
   * Whether the working set is MUTUAL — if I deal with you, you deal with me.
   *
   * The second thing the design lives on, and the less obvious one. Sticky
   * partners are not enough: if I ask the peers in my set but am asked by a
   * different set, I still never earn credit where I spend it. Reciprocity
   * needs demand in BOTH directions, which is exactly why it works for
   * BitTorrent (everyone wants the same file at the same time) and why storage
   * markets normally reach for money instead (a provider serves readers who
   * have nothing it wants).
   *
   * The design consequence is concrete and testable: **custody assignments
   * should be paired.** A node that wants its bytes held takes someone else's
   * bytes in return, so storage is paid for in storage. `false` is the
   * unpaired case, kept because it is the one that fails.
   */
  mutual: boolean;
  seed?: number;
}

export interface ClassResult {
  kind: PeerKind;
  requested: number;
  served: number;
  /** Share of this class's requests that were answered. */
  servedFraction: number;
}

export interface ReciprocityResult {
  byClass: Record<PeerKind, ClassResult>;
  /** Newcomer served-fraction per round after joining — the ramp. */
  newcomerRamp: number[];
  /** Contributor served-fraction per round, for comparison. */
  contributorRamp: number[];
}

export const DEFAULT_RECIPROCITY: ReciprocityParams = {
  contributors: 40,
  freeriders: 20,
  newcomers: 5,
  rounds: 40,
  requestsPerRound: 6,
  capacityPerRound: 12,
  newPeerPrior: 1,
  creditPerServe: 1,
  costPerRequest: 1,
  decay: 0.9,
  newcomerJoinsAtRound: 20,
  neighbourhood: 8,
  mutual: true,
  seed: 7,
};

export function runReciprocity(p: ReciprocityParams = DEFAULT_RECIPROCITY): ReciprocityResult {
  const rand = rng(p.seed ?? 1);
  const kinds: PeerKind[] = [
    ...Array<PeerKind>(p.contributors).fill('contributor'),
    ...Array<PeerKind>(p.freeriders).fill('freerider'),
    ...Array<PeerKind>(p.newcomers).fill('newcomer'),
  ];
  const n = kinds.length;

  // credit[server][client] — what the SERVER believes the CLIENT has earned
  // with it. Deliberately asymmetric and never shared: that is the whole
  // security argument, so it must not become a global table by accident.
  const credit: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  // Each node's working set: the peers it actually deals with. Drawn once, so
  // a relationship has somewhere to accumulate.
  const sets: Array<Set<number>> = Array.from({ length: n }, () => new Set<number>());
  if (p.neighbourhood) {
    const target = Math.min(p.neighbourhood, n - 1);
    for (let i = 0; i < n; i++) {
      let guard = 0;
      while (sets[i]!.size < target && guard++ < n * 10) {
        const j = Math.floor(rand() * n);
        if (j === i) continue;
        sets[i]!.add(j);
        // A mutual working set is an UNDIRECTED edge: the peer I deal with
        // deals with me, which is what gives credit somewhere to accumulate.
        if (p.mutual) sets[j]!.add(i);
      }
    }
  }
  const workingSet: number[][] = sets.map((s) => [...s]);

  const requested = { contributor: 0, freerider: 0, newcomer: 0 };
  const served = { contributor: 0, freerider: 0, newcomer: 0 };
  const newcomerRamp: number[] = [];
  const contributorRamp: number[] = [];

  const present = (i: number, round: number) =>
    kinds[i]! !== 'newcomer' || round >= p.newcomerJoinsAtRound;

  for (let round = 0; round < p.rounds; round++) {
    const capacity = new Array(n).fill(p.capacityPerRound);
    // The unconditional floor, refreshed every round so it can never be
    // exhausted permanently by a bad patch of history. One budget per SERVER
    // unless `priorPerPeer` asks for the naive per-stranger form.
    const priorBudget = new Array(n).fill(p.newPeerPrior);
    const priorPerPeer: number[][] | undefined = p.priorPerPeer
      ? Array.from({ length: n }, () => new Array(n).fill(p.newPeerPrior))
      : undefined;

    const roundReq = { contributor: 0, freerider: 0, newcomer: 0 };
    const roundServed = { contributor: 0, freerider: 0, newcomer: 0 };

    for (let i = 0; i < n; i++) {
      if (!present(i, round)) continue;
      for (let r = 0; r < p.requestsPerRound; r++) {
        const ws = workingSet[i]!;
        let j: number;
        if (ws.length) {
          j = ws[Math.floor(rand() * ws.length)]!;
        } else {
          j = Math.floor(rand() * n);
          if (j === i) j = (j + 1) % n;
        }
        if (!present(j, round)) continue;

        requested[kinds[i]!]++;
        roundReq[kinds[i]!]++;

        // A free-rider answers nothing. Nothing else distinguishes it: same
        // identity, same bandwidth, same right to ask.
        if (kinds[j]! === 'freerider') continue;
        if (capacity[j]! <= 0) continue;

        // Earned credit is spent first, so the floor stays available for peers
        // that have nothing — it is a floor, not a discount for regulars.
        if (credit[j]![i]! >= p.costPerRequest) {
          credit[j]![i]! -= p.costPerRequest;
        } else if (priorPerPeer) {
          if (priorPerPeer[j]![i]! < p.costPerRequest) continue;
          priorPerPeer[j]![i]! -= p.costPerRequest;
        } else if (priorBudget[j]! >= p.costPerRequest) {
          priorBudget[j]! -= p.costPerRequest;
        } else {
          continue; // throttled: asked for more than it earned, floor spent
        }

        capacity[j]--;
        served[kinds[i]!]++;
        roundServed[kinds[i]!]++;
        // Serving earns credit WITH THE CLIENT — recorded by the party that did
        // the work, about the party that benefited.
        credit[i]![j]! += p.creditPerServe;
      }
    }

    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) credit[a]![b]! *= p.decay;
    }

    contributorRamp.push(roundReq.contributor ? roundServed.contributor / roundReq.contributor : 0);
    if (round >= p.newcomerJoinsAtRound) {
      newcomerRamp.push(roundReq.newcomer ? roundServed.newcomer / roundReq.newcomer : 0);
    }
  }

  const mk = (kind: PeerKind): ClassResult => ({
    kind,
    requested: requested[kind],
    served: served[kind],
    servedFraction: requested[kind] ? served[kind] / requested[kind] : 0,
  });

  return {
    byClass: { contributor: mk('contributor'), freerider: mk('freerider'), newcomer: mk('newcomer') },
    newcomerRamp,
    contributorRamp,
  };
}
