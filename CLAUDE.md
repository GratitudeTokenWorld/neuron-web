# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`neuron-web` is a decentralised social dApp: a browser-first P2P network with its own
block-lattice ledger, face+PIN post-quantum identity, and a content-addressed media
store. It is the **re-platformed** successor to `../neuronchain` — the same app shell
(UI, libp2p transport, face identity, relay) being moved onto a new sharded engine
designed to hold the *scale invariant*:

> For any node, memory/storage/bandwidth/CPU must be `O(own data + followed data)` —
> never `O(total network)`. Any `O(N)` subsystem fails at 1B users.

Weigh that invariant on **every** change. Zero common-path overhead, interest-scoped
propagation, no global indexes.

Two **known live violations** are tracked in ARCHITECTURE.md → *Deferred:
scale-invariant gaps in the current build*: **G1** the global `accounts` gossip
topic (every node ingests every account record) and **G2** counterparty
verification pulling whole chains instead of accumulator proofs. Both are
deliberately deferred until the architecture/refactor work is done — don't
re-derive them as new discoveries, and don't build on top of them.

The full design, threat model, and consensus rationale live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — read it before touching the engine,
consensus, or identity code. Relay/super-node operations: [docs/SUPERNODE.md](docs/SUPERNODE.md).
Cloud provisioning: [docs/CLOUD.md](docs/CLOUD.md).

## Commands

```sh
npm run dev          # Vite dev server + auto-spawned relay
npm run relay        # standalone relay (tsx relay/server.ts) — production entry
npm run build        # → dist/ (static bundle)
npm test             # vitest, all of src/**/*.test.ts
npm run typecheck    # ⚠ engine only (tsconfig.engine.json) — see below
```

Current baseline: **199 tests / 47 files passing**, `npm run build` clean.
Keep both green; add tests next to the code (`foo.ts` → `foo.test.ts`).

## Where to pick up (as of 2026-08-09)

The manual E2E matrix passed end to end on the two-relay dev network
(TESTPLAN T1–T6; T7 skipped by decision). Face enrollment, 2-of-2 attestation,
cross-relay sync, transfers both ways incl. offline claim, NFT mint/transfer/
burn/reload, recovery-after-wipe and the uniqueness+face limits all work.

**Next up is the architecture work, not more app fixes.** Phase status and the
recommended order live in ARCHITECTURE.md → *Where this stands*. Short version:
run the `src/engine/sim` harness first to get a measured baseline, then fix
**G1** (global `accounts` topic), then **G2** (counterparty chain replication).

`vitest.config.ts` is deliberately separate from `vite.config.ts` so the test run does
not load the libp2p plugin (which spawns a relay).

## Layout

```
src/
  main.ts          app entry + UI logic (large; still on legacy ledger types)
  api/             neuronchain-api.ts — the app-facing API surface
  core/            legacy app core carried from neuronchain (dag-ledger, vote,
                   face-store, face-verify, pin-crypto, snapshot, tab-lock, …)
  network/         libp2p-network, node.ts (the node orchestrator), smoke-store CDN,
                   storage-manager
  ledger/          EngineLedger — the app↔engine bridge, and where the integration
                   tests live (fraud-safety, committee-finality, multi-attester, nft, …)
  engine/          the scalable core, a self-contained tested library:
    core/          hash, P-256 keys, partition, Merkle accumulator, attestations,
                   identity/nullifier dedup, blocks, light-verify
    node/          partial replication, delta sync, archival tiering, snapshots
    consensus/     VRF (RFC 9381), sortition, committees, weight, slashing, fraud
    content/       CIDs, chunking, provider DHT, replication
    economy/       capped reward inflation
    net/           relay federation (rendezvous hashing)
    sim/           scale-invariant simulation harness
relay/             relay / super-node: server.ts (PORT 9090 ws, +1 tcp, +2
                   http/face-verify), vite-plugin.ts (dev auto-spawn),
                   ecosystem.config.cjs (pm2). Runtime state (identity keys,
                   face DB, archives) lives in gitignored .relay-data/
```

## The migration seam — read before editing app code

The engine **is** wired into the app: `node.ts` constructs an `EngineLedger`
([node.ts:121](src/network/node.ts#L121)). But the migration is unfinished, and this is
the single most important thing to know about the codebase:

- `npm run typecheck` covers **only `src/engine`**. Running `tsc -p tsconfig.json`
  surfaces ~180 errors in `main.ts`, `node.ts`, `neuronchain-api.ts` — the app layer
  still speaks the legacy `AccountBlock`/`Account` shapes while the engine speaks
  `Block`/`LedgerAccount` (`accountPub` vs `accountId` + `shard` + `accumulatorRoot`).
  Vite does not typecheck, so this builds and runs anyway. **Type errors in app files
  are not proof your change is wrong — but never add new ones.**
- `storage-manager.ts` is still fully on the legacy `DAGLedger`; the matching
  `createStorage*` methods on `EngineLedger` are deliberate `deferred()` stubs.
  Contracts are stubbed too and are **out of scope by design** (no general VM —
  see ARCHITECTURE.md).
- `EngineLedger` carries a "DAGLedger compatibility surface" (`allBlocks`, `accounts`,
  `votes`, no-op `castVote`, …) so app code can treat it like the old ledger. When you
  migrate a caller, prefer deleting its use of that surface over extending it.
- Known bug, do not replicate: `switchNetwork()` reassigns `this.ledger = new DAGLedger(...)`
  onto an `EngineLedger`-typed field ([node.ts:1082](src/network/node.ts#L1082)).

## Security-critical areas

Changes here need adversarial tests, not just happy-path ones.

- **Identity / Sybil resistance.** Consensus weight is age-weighted *personhood*, so
  breaking one-human-one-account breaks consensus. A nullifier (`nid#index`) is issued
  per human by an attester; `src/engine/core/identity.ts` dedups it permanently.
  `REQUIRED_ATTESTERS` is build-aware (1 for `LOCAL_ONLY` dev, 2 for production).
  The single-attester SPOF is a **known, deferred** risk — quorum + federation is the
  fix (ARCHITECTURE.md → Subsystem 5).
- **Face capture / liveness** (`src/core/face-verify.ts`). Every threshold there is
  derived from measured `neuron_debug` traces, not geometry — the numbers and the
  reasoning are in the comments beside each one. **Do not retune from intuition:**
  get a trace (`localStorage.neuron_debug = '1'`, run an enrollment, read the
  `[face]` lines), compute rest-vs-action separation, and set the threshold from
  the data. Three traps that have each bitten more than once:
  - *Bar and test measuring different things.* A progress bar that divides by a
    different reference than the pass condition reads "nearly there" while the
    check can never fire. Fixed twice (close-eyes, head turn).
  - *A rolling reference fed by frames that are part of the action.* It chases the
    action, the threshold runs away, and the check becomes unpassable. Feed a
    reference only from frames that are clearly NOT the action.
  - *Time-based windows assume ~16 fps* (60 ms poll). On slow hardware a "400 ms
    window" holds one frame and the √n noise averaging silently stops working.
  Detection uses `detectAllFaces` everywhere and aborts on >1 face:
  `detectSingleFace` does **not** fail on two faces, it returns the highest-scoring
  one — which let a photo held beside a real head supply the enrolled descriptor.
- **Consensus.** Fraud-proof safety + ECVRF committee finality. Don't weaken the
  challenge window, slashing, or equivocation freezing.
- **Cross-account replay order.** Persisted blocks are replayed sorted
  accountId-then-index, so a recipient's chain may load before the sender's.
  Anything that validates against another account's block must tolerate arriving
  first (see the NFT mint/receive guards in `engine-ledger.ts`), or a reload
  silently drops state and truncates the chain behind it.
- **Secrets.** `.relay-*` files (attester key, signing key, face DB, operator list) and
  `*.openrc` are gitignored and contain live secrets/biometrics. Never commit, print,
  or copy them into docs or logs.

## Cloud / infrastructure

Super-nodes run on **cloudify.ro (Acvile)**, an OpenStack platform, region
`eu-east-1`, authenticated with an application credential in `lucian.openrc`
(gitignored — see Secrets above; `open stack app credentials.txt` is the same
credential, also gitignored).

```sh
powershell -File scripts/os-setup.ps1     # one-time: .openstack-venv + python-openstackclient
./scripts/os.sh flavor list               # any openstack command, credentials pre-loaded
./scripts/os.sh server list
```

**Status 2026-08-08: cloudify compute provisioning is DOWN platform-wide** —
server builds fail from their own panel too (user-reproduced), so don't debug our
API usage when `server create` errors; check whether the platform is healthy first
(one probe boot, then stop). Two standing rules: **Ubuntu 26 images only**
(`base-ubuntu-26.04` = `e321df69-…`), and **create SSH keys in the panel, never
via the API** (API-created keypairs get silently deleted; the panel-created
`neuron-ops` persists — local private key `~/.ssh/neuron-ops`). Relay boxes:
2× `b2i.2c-2g`, ports 22/9090–9092; software via `scripts/setup-relay-box.sh`.
Full runbook: [docs/CLOUD.md](docs/CLOUD.md).

Existing (persisted) resources: `neuron-net` (10.10.0.0/24) + `neuron-router` →
`public`, and security group `neuron-relay` (TCP 22/9090/9091/9092). Quota: 20
instances / 128 vCPU / 160 GB RAM. Cheapest flavor: `b2i.2c-2g`.

**Confirm with the user before creating, resizing, or deleting any cloud resource** —
they are billable and outward-facing. Read-only commands (`list`, `show`, `token issue`)
are fine unprompted.

## Development mode — data is disposable

**The network is in development mode until Lucian explicitly says otherwise.**
The two cloud relays are the only relays that exist (old neuronweb.org /
akashicrecords.dev deployments are dead — never account for them), and all
blockchain/relay data is disposable: don't preserve chain state, write migration
shims, or fear resets when a change calls for wiping `.relay-data/` and client
storage. What must still survive any wipe: the relay **peer-id and attester key**
files (identity — the baked bootstrap addrs embed the peerIds) and, as always,
never commit secrets. Leaving dev mode is an explicit user call, not inferred.

## Two-relay dev network & manual testing

The dev/test topology is 2 cloud relays (each = archive super-node + attester) +
the local dev relay. The manual E2E matrix (face flows can't be automated —
account creation with 2-of-2 attesters, cross-relay sync, transfers, NFTs,
recovery-after-wipe, operator reset) lives in [docs/TESTPLAN.md](docs/TESTPLAN.md).
Point the dev stack at the relays with `PEER_RELAYS` + `BOOTSTRAP_ADDRS` env vars
(no code edit needed); test from `http://localhost:5173`, never the https tunnel
(mixed content blocks `ws://`/`http://` to raw-IP relays).

There is **no contract VM** — "smart contract" testing means the native-NFT surface
(`createDeploy`/`createCall` are deliberate deferred stubs).

## Conventions

- TypeScript, ESM (`"type": "module"`), 2-space indent, single quotes, semicolons.
- Comments explain *why* — the existing code is heavily commented with rationale and
  invariants. Match that density; don't strip it.
- Engine modules are pure and dependency-light (`@noble/*` crypto only) so they stay
  testable in Node without a browser. Keep browser/libp2p concerns in `src/network`.
- The relay is `.ts` run via `tsx`; there is no separate build step for it.
  ⚠ `relay/` is covered by **neither** `npm run typecheck` (engine only) nor any
  test — an undefined variable in a 60 s timer once crash-looped both cloud boxes
  47 times before anyone noticed. Re-read relay edits carefully, and after
  deploying check `pm2 jlist` restart counts **after** the interval has fired
  (>60 s), not immediately.
