# neuron-web

A scalable, sharded, **age-weighted-personhood** account-chain core — the clean
re-architecture of the NeuronChain design, built to scale to 1B+ users.

The full design rationale, threat model, and phased plan live in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The one-line invariant everything
serves:

> **Per-node cost (memory, storage, bandwidth, CPU) must be `O(own + followed)`,
> never `O(total network)`.**

## Status — Phase 0 (foundations)

Phase 0 establishes the cryptographic primitives every later phase builds on.
(The whole project: `npm test` — 96 passing across all phases, typechecked.)

**All 7 plan scale-invariants are now met by a test** — including #7 (no destructive
history loss): see archival tiering below.

| Module | Purpose |
|--------|---------|
| [`src/core/hash.ts`](src/core/hash.ts) | SHA-256 + canonical JSON (deterministic, bigint-safe) |
| [`src/core/keys.ts`](src/core/keys.ts) | P-256 account keys, sign/verify (PQ keys slot in later) |
| [`src/core/partition.ts`](src/core/partition.ts) | Deterministic account→shard mapping (data location) |
| [`src/core/accumulator.ts`](src/core/accumulator.ts) | Per-account Merkle accumulator (RFC 6962) — light-verifiable history |
| [`src/core/attestation.ts`](src/core/attestation.ts) | Typed pluggable attestations + k-of-N quorum |
| [`src/core/identity.ts`](src/core/identity.ts) | Global identity dedup — one human, one account |
| [`src/core/block.ts`](src/core/block.ts) | Account-chain block model (header carries accumulator root + shard) |
| [`src/core/light-verify.ts`](src/core/light-verify.ts) | Verify a followed account's head from a proof alone |

**Phase 0 validation criterion (met):** a light client verifies a followed
account's head — its identity quorum and its membership in the account's history —
from an `O(log n)` proof, without holding or replaying the chain. See
[`src/core/light-verify.test.ts`](src/core/light-verify.test.ts).

## Status — Phase 1 (partial replication + discovery)

Partial replication: a node holds and receives only the accounts it cares about,
so per-node cost is `O(own + followed)`, not `O(network)`.

| Module | Purpose |
|--------|---------|
| [`src/node/account-store.ts`](src/node/account-store.ts) | Per-node store of held account chains, fully validated on apply |
| [`src/node/subscription.ts`](src/node/subscription.ts) | Interest model — light client (own+followed) vs super-node (shards) |
| [`src/node/delta-sync.ts`](src/node/delta-sync.ts) | Account-scoped delta sync (catch up one account's tail independently) |
| [`src/node/archive.ts`](src/node/archive.ts) + [`archiving-store.ts`](src/node/archiving-store.ts) | Bounded hot window + cold history archived to content-addressed storage — **invariant #7**: archived blocks stay provable + retrievable, nothing destroyed |
| [`src/node/snapshot.ts`](src/node/snapshot.ts) | Per-shard snapshots — bootstrap trusted account heads from proofs alone (no replay) |
| [`src/sim/network.ts`](src/sim/network.ts) | Interest-routed simulation substrate with per-node metrics |
| [`src/sim/scenario.ts`](src/sim/scenario.ts) | Scale-invariant scenario builder |

**Phase 1 validation criterion (met, measured):** sweeping the network 16× (40 →
640 accounts) with a fixed follow count, per-node receive/store cost stays
**constant** while the broadcast baseline (old "everyone sees everything" gossip)
grows linearly:

```
  N      per-node recv   per-node store   broadcast would be   saving
  40     33              33               120                  3.6x
  160    33              33               480                  14.5x
  640    33              33               1920                 58.2x
```

See [`src/sim/scenario.test.ts`](src/sim/scenario.test.ts).

## Status — Phase 2 (consensus: age-weighted personhood)

The consensus layer: capital cannot buy dominance; weight comes from being a
unique, long-active human. `weight = saturating_activity_age × √(bonded ≤ cap)`,
with the cap = the free mint.

| Module | Purpose |
|--------|---------|
| [`src/consensus/weight.ts`](src/consensus/weight.ts) | Voting weight (age × concave stake); documents why 1h1a enables concave weighting |
| [`src/consensus/validators.ts`](src/consensus/validators.ts) | Validator set: bond/unbond (capped, lockable), activity-age, slashing |
| [`src/consensus/committee.ts`](src/consensus/committee.ts) | Beacon-seeded per-shard committee sortition (unbiasable, non-grindable, seniority floor) |
| [`src/consensus/vote.ts`](src/consensus/vote.ts) | Weighted optimistic + conflict-only voting with equivocation detection |
| [`src/consensus/slashing.ts`](src/consensus/slashing.ts) | Burn an equivocator's bond — skin in the game |
| [`src/consensus/fraud.ts`](src/consensus/fraud.ts) | Double-spend fraud proof — basis of recipient-witnessed cross-shard finality |
| [`src/consensus/rate-limit.ts`](src/consensus/rate-limit.ts) | Stake-bonded per-epoch write/fork budget (anti-spam moat) |

**Phase 2 security properties (tested):**
- **No whale dominance** — stake capped + concave; a fully-aged validator is at
  most `MAX_AGE_MULTIPLIER`× a fresh one.
- **Concave weighting is Sybil-safe** *only because of* 1h1a — the splitting
  exploit is demonstrated and shown to require Sybil accounts.
- **Single-shard takeover resistance** — a 40%-global attacker holds a committee
  majority in <5% of randomly-sampled committees (random-sampling argument).
- **Equivocation is self-incriminating** — double-voting / double-spending
  produces verifiable evidence that burns the offender's bond.

## Status — Phase 3 (content & discovery)

Fixes the two storage killers from the audit: the global file index (replaced by a
DHT) and the 100 MB-file crash (quota-guarded chunking).

| Module | Purpose |
|--------|---------|
| [`src/content/cid.ts`](src/content/cid.ts) | Content addressing (SHA-256 CIDs, integrity check) |
| [`src/content/chunking.ts`](src/content/chunking.ts) | Chunk/manifest/reassemble — no blob exceeds the chunk size |
| [`src/content/content-store.ts`](src/content/content-store.ts) | Quota-aware store; pre-checks space, dedups chunks |
| [`src/content/dht.ts`](src/content/dht.ts) | Chord provider-record DHT — distributed index, O(log N) discovery |
| [`src/content/replication.ts`](src/content/replication.ts) | Redundancy tracking, churn-repair to target, TTL/refcount GC |

**Phase 3 validation criteria (met, measured):**
- **100 MB media works** — chunked into bounded blobs, reassembled by CID; an
  undersized quota fails cleanly with nothing written (no crash).
- **Per-node index independent of total files** — grows the network + files 16×,
  per-node provider-record index stays flat while old global-index would grow:

```
  N      files    avg index   max index   max hops   log2(N)
  64     256      32.0        59          6          6
  256    1024     32.0        76          7          8
  1024   4096     32.0        72          8          10
```

See [`src/content/discovery.test.ts`](src/content/discovery.test.ts).

## Status — Phase 4 (economy & relay federation)

The incentive and connectivity layers that make the tiered network self-sustaining.

| Module | Purpose |
|--------|---------|
| [`src/economy/rewards.ts`](src/economy/rewards.ts) | Capped reward inflation minted to active validators/providers by contribution |
| [`src/net/relay-directory.ts`](src/net/relay-directory.ts) | Relay federation via rendezvous (HRW) hashing — scales past the old 1024 cap |

**Phase 4 properties (tested):** emission is capped at a parts-per-million rate of
supply (with a bootstrap floor) and nothing mints without contributors; relay
assignment is deterministic + balanced, reshuffles <10% of peers when a relay
joins, and scales by *adding relays* (1B peers ÷ 100k/relay = 20k relays) rather
than raising any single relay's ceiling.

## End-to-end capstone

[`src/integration.test.ts`](src/integration.test.ts) exercises **all four phases in
one scenario**: open accounts with identity attestations + global dedup (P0) →
followers partially replicate only what they follow (P1) → a double-spend is caught,
a committee resolves the fork and an equivocating validator is slashed, the
double-spend is independently proven (P2) → 20 MB media is chunked, stored
quota-safely, announced to the DHT, and discovered by another node (P3).

## Develop

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
```

## Roadmap (next phases)

- **Phase 1 ✓** — partial replication + account-scoped delta sync; scale invariant
  measured. (Real libp2p/DHT transport replaces the simulation substrate later.)
- **Phase 2 ✓** — age-weighted-personhood consensus: committee sortition, weighted
  conflict voting, slashing, double-spend fraud proofs, stake-bonded rate limit.
  (Real randomness beacon + per-validator VRF proofs, and the end-to-end
  cross-shard settlement flow, land when wired to transport.)
- **Phase 3 ✓** — content addressing + chunking (quota-safe large files), Chord
  provider-record DHT (distributed index, O(log N) discovery). (Real libp2p
  Kademlia + smoke-HTTP transport + replication/repair land with transport.)
- **Phase 4 ✓** — capped reward inflation + relay federation (rendezvous hashing).
  (Live transport wiring, real beacon/VRF, and load tests are the remaining
  integration work; every interface they need is built and tested here.)

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan, the consensus
threat model, and the defense-in-depth around the personhood dependency.
