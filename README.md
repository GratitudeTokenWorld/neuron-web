# neuron-web

The scalable social-dApp build: the **neuronchain app** (UI, P2P transport,
face+PIN identity, relay) carried over and being re-platformed onto a new
**sharded, age-weighted-personhood engine** designed to scale to 1B+ users.

- `npm run dev` runs the app exactly like neuronchain (same UI).
- `src/engine/` is the new scalable core — a tested library that the app's
  ledger/consensus/storage are being refactored onto. The engine **is** wired in
  (`node.ts` runs `EngineLedger`); the remaining seam is the app-layer types +
  `storage-manager` (see `CLAUDE.md`). Test suite: 197 passing.
- The full design + threat model + measured results: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
- Ops: relay/super-node deployment [`docs/SUPERNODE.md`](docs/SUPERNODE.md), cloud
  provisioning [`docs/CLOUD.md`](docs/CLOUD.md), manual E2E matrix
  [`docs/TESTPLAN.md`](docs/TESTPLAN.md).

## Run / deploy

```sh
npm install          # clean install, 0 vulnerabilities
npm run dev          # Vite dev server + auto-spawned relay — open the printed URL
npm run relay        # standalone relay (production)
npm run build        # → dist/ (static deployable bundle)
npm run preview      # serve the production build locally
npm test             # engine test suite (vitest)
npm run typecheck    # strict typecheck of the engine
```

Deploy = serve `dist/` as static files behind your host, and run `node relay-server.js`
(`npm run relay`) on a reachable server — same model as neuronchain.

## Layout

```
index.html, vite.config.ts, relay-server.js   app shell + relay (from neuronchain)
public/models/                                face-api model weights
src/
  main.ts                 app entry / UI logic
  core/                   app's current ledger/identity (dag-ledger, face-verify, …)
  network/                libp2p transport, smoke-store CDN, storage-manager
  api/                    app API surface
  engine/                 ← the NEW scalable core (sharded, light-verifiable)
    core/        hashing, P-256 keys, partition, Merkle accumulator,
                 attestations, identity dedup, account-chain blocks, light-verify
    node/        partial replication, delta sync, archival tiering, snapshots
    consensus/   age-weighted-personhood voting, committees, slashing, fraud proofs
    content/     content addressing, quota-safe chunking, provider DHT, replication
    economy/     capped reward inflation
    net/         relay federation (rendezvous hashing)
    sim/         scale-invariant simulation harness
```

## Status

- **App** — runs and builds (the neuronchain UI/transport/face/relay, unchanged).
- **Engine** (`src/engine/` + `src/ledger/`) — phases 0–4, Phase 2 consensus
  (fraud proofs + ECVRF committee finality), native NFTs, 2-attester identity;
  **197 tests passing, engine typechecked**, all 7 scale-invariants demonstrated
  by tests (see `docs/ARCHITECTURE.md`). Wired into the app via `EngineLedger`
  (`src/network/node.ts`).
- **Next** — finish the app-layer seam (unify legacy `AccountBlock`/`Account`
  types, migrate `storage-manager`, drop the DAGLedger compat surface), then the
  live-transport items (real Kademlia/beacon/VRF, smoke-HTTP CDN, load tests)
  noted in the architecture doc. Manual two-relay validation: `docs/TESTPLAN.md`.

## Engine — measured scale invariants

| Invariant | Result |
|-----------|--------|
| Per-node memory/bandwidth = O(own+followed), not O(N) | flat across 16× network growth |
| Content discovery O(log N); index independent of total files | flat per-node index, ≤ log₂N hops |
| Single-shard takeover | 40%-global attacker holds a committee majority <5% of the time |
| No destructive history loss | archived blocks stay provable + retrievable |
| One human → one account | nullifier dedup holds across any attester set |

See `src/engine/sim/scenario.test.ts`, `src/engine/content/discovery.test.ts`,
`src/engine/consensus/committee.test.ts`, `src/engine/node/archive.test.ts`.
