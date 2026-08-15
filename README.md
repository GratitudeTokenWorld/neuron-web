# neuron-web

The scalable social-dApp build: the **neuronchain app** (UI, P2P transport,
face+PIN+network-share identity, relay) carried over and being re-platformed
onto a new **sharded, age-weighted-personhood engine** designed to scale to 10B
users.

- `npm run dev` runs the app exactly like neuronchain (same UI).
- `src/engine/` is the new scalable core — a tested library that the app's
  ledger/consensus/storage are being refactored onto. The engine **is** wired in
  (`node.ts` runs `EngineLedger`); the remaining seam is the app-layer types +
  `storage-manager` (see `CLAUDE.md`). Test suite: 330 passing.
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

Deploy = serve `dist/` as static files behind your host, and run `npm run relay`
on a reachable server (pm2: `pm2 start relay/ecosystem.config.cjs`).

## Layout

```
index.html, vite.config.ts    app shell (from neuronchain)
relay/                        relay / super-node (server.ts, vite-plugin.ts, pm2 config)
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
  storage/       Node-side block backends (filesystem; S3 opt-in, operator-set)
```

## Status

- **App** — runs and builds (the neuronchain UI/transport/face/relay, unchanged).
- **Engine** (`src/engine/` + `src/ledger/`) — phases 0–2 done, Phase 2 consensus
  (fraud proofs + ECVRF committee finality), native NFTs, 2-attester identity;
  **330 tests passing, engine + storage typechecked**, all 7 scale-invariants
  demonstrated by tests (see `docs/ARCHITECTURE.md`). Wired into the app via
  `EngineLedger` (`src/network/node.ts`).
- **Scale invariant restored** — three `O(N)` violations closed. G1 + G2
  (2026-08-10): accounts resolve on demand from an archive tier instead of a
  global gossip topic, and payments *and* NFTs claim from `O(log n)` Merkle
  proofs instead of replicating counterparty chains. G3 (2026-08-15): the
  global `keyblobs` topic, which handed every account's encrypted-key blob to
  every node, replaced by targeted HTTP. Live on the two-relay dev network;
  manual matrix green.
- **Key custody split** (2026-08-15) — account keys are sealed under
  `XOR(face, PIN, relay-held share)`; the share is Shamir 2-of-n across the
  attesters and released only to a relay-verified live action sequence under
  server-side backoff. The previous scheme was PIN-strength only, which a test
  in `src/core/face-match.test.ts` still demonstrates as the control case.
- **Next** — Phase 3 (storage): the CID-native backend seam, a filesystem
  adapter (`src/storage/`), and the on-chain provider economy are in — capacity,
  liveness **leases** (a heartbeat renews custody; an expired lease stops
  counting toward redundancy) and evidence-priced rewards, with
  `storage-manager` moved off the legacy ledger. Still to do: the repair loop,
  the publish handoff, and the file index → DHT. Then Phase 4, and the app-layer
  type seam paid down per caller. Manual validation: `docs/TESTPLAN.md`.

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
