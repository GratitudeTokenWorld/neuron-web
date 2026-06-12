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
All implemented with tests (`npm test` — 31 passing) and typechecked.

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
- **Phase 2** — sharded consensus (per-shard committees, VRF assignment),
  age-weighted-personhood voting + slashing, pluggable-attestation quorum on open.
- **Phase 3** — content/media CDN via DHT provider records; quota-safe large files.
- **Phase 4** — relay federation, incentives, security hardening.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full plan, the consensus
threat model, and the defense-in-depth around the personhood dependency.
