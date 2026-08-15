# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`neuron-web` is a decentralised social dApp: a browser-first P2P network with its own
block-lattice ledger, face+PIN post-quantum identity, and a content-addressed media
store. It is the **re-platformed** successor to `../neuronchain` — the same app shell
(UI, libp2p transport, face identity, relay) being moved onto a new sharded engine
designed to hold the *scale invariant*:

> For any node, memory/storage/bandwidth/CPU must be `O(own data + followed data)` —
> never `O(total network)`. Any `O(N)` subsystem fails at 10B users (the target,
> decided 2026-08-09). No role is *required* to hold everything — archival
> super-nodes included; full mirrors are an opt-in bonus, never load-bearing.

Weigh that invariant on **every** change. Zero common-path overhead, interest-scoped
propagation, no global indexes.

The two known `O(N)` violations — **G1** (global `accounts` gossip topic) and
**G2** (counterparty verification pulling whole chains) — are **closed as of
2026-08-10**; ARCHITECTURE.md → *Scale-invariant gaps G1 + G2* records what
shipped for each. Don't re-derive them as new discoveries, and don't
reintroduce a global topic or a whole-chain pull to make something easier: the
replacements are on-demand, verified archive queries (see *Where to pick up*).

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
npm run typecheck    # engine + src/storage; NOT the app layer — see below
```

Current baseline: **312 tests / 60 files passing**, `npm run build` clean.
Keep both green; add tests next to the code (`foo.ts` → `foo.test.ts`).

## Where to pick up (as of 2026-08-15)

**Phase 3 has STARTED — do not rebuild the seam.** `ede2dd8` landed the
storage backend split: `BlockBackend` + `MemoryBackend`
(`src/engine/content/backend.ts`), `ContentStore` now composes a backend and is
**async** (with `release()` for lease cleanup and `open()` to adopt an existing
disk), and `src/storage/fs-backend.ts` is the filesystem adapter (own
`tsconfig.storage.json`, inside `npm run typecheck`).

**Step 1 (parity) is DONE — 2026-08-15.** The four `createStorage*` methods are
real: storage blocks are engine block types (`storage-register` /
`-deregister` / `-heartbeat` / `-reward`, payload in `block.storage`), and the
provider registry, lease liveness and reward evidence live in the pure
`src/engine/content/provider-ledger.ts`. `storage-manager.ts` is **off the
legacy `DAGLedger`** — it takes an `EngineLedger` and gossips storage blocks on
the engine topic. Three things there are load-bearing and were decided, not
inherited:

- **The heartbeat is the lease renewal.** `isLive()` / `liveStorageProviders()`
  answer custody questions; `getStorageProviders()` (unfiltered) answers routing
  ones. `MAX_OFFLINE_MS` = 3 heartbeat intervals = 12h.
- **An early heartbeat is accepted and not counted; only a flood is rejected.**
  Rejecting a validly-signed block mid-chain truncates it and strands every later
  block as non-sequential — the failure that made NFTs vanish on reload — so
  honest jitter must never be refused. `MAX_HEARTBEATS_PER_DAY_HARD` (24/epoch,
  4× honest) is the sole mid-chain rejection, set where only a padding chain
  reaches it. Uptime credit comes only from counted renewals.
- **A reward bills the day before its own block, and only that day**
  (`claimableEpochDay`, enforced in `validate`). Billing the running day paid a
  partial day and closed the epoch for good (polling every 30 min locked in 1/6);
  billing an *old* day would find the evidence pruned past `RETAIN_EPOCHS` and be
  rejected mid-chain by exactly those nodes that had pruned it. One rule kills
  both: evidence is always one day old, and the rule is decidable from the block
  alone, so every node agrees with no retained state. **Issuance must read the
  clock once** for the claim and the timestamp — twice across midnight builds a
  block that fails its own validation.

**What remains, in this order** — the decisions in *Storage custody rules*
below constrain all of it:

1. **Lease + repair** on top of heartbeat: rejoin discard + refill from declared
   capacity, and counting only *verified-live* replicas toward
   `REDUNDANCY_TARGET`. The lease half exists (`isLive`, `MAX_OFFLINE_MS`); the
   repair half does not, and `StorageManager.deregisterStaleLocalProviders`
   still uses its own 24h rule rather than the lease.
2. **Publish handoff:** a publish is incomplete until minimum replicas confirm;
   until then the uploader's copy is staging and must be retried, or closing
   the tab destroys the content. `checkPublishFeasibility` is real now (it
   counts live leases with free space) but only *warns*.
3. **File index → DHT provider records** — the remaining `O(N)` violation in
   storage (a global gossiped file index today).
4. **Measure repair-rate vs churn** in `src/engine/sim/archival.ts`: it models
   assignment and churn but NOT lease expiry/repair, so "durability is a flow"
   is currently asserted, not measured.
5. **S3 client adapter** — opt-in, operator-configured, never a default.
6. **TESTPLAN T8 (storage)** — the parity work is testable end-to-end now
   (register → heartbeat → reward → deregister across two devices).

`storage-manager.ts` (1379 lines) has more callers than the ledger did —
enumerate them before changing what it broadcasts (see the free-rider trap
below).

### Storage custody rules (decided; they constrain Phase 3)

- **Durability is a FLOW property.** Content survives because the network
  re-distributes the minimum replica count faster than holders are lost
  (repair ≥ churn) — not because many copies exist.
- **Replicas are held under a liveness LEASE, not owned.** Discard + refill
  from declared capacity after `MAX_OFFLINE`.
- **Authorship is not custody.** Published content is handed to the network;
  the publisher keeps no copy by default and is not automatically a replica
  (except while the network finishes replicating it). Ownership is on-chain,
  custody is a network assignment — no authorship exemption from lease rules.
- **Backends are pluggable and OPERATOR-CONFIGURED.** Filesystem is the
  zero-dependency bottom layer and the CI target. Nothing in the core may
  require an object store, and no default config may point at one. We do not
  implement an S3 *server* (commodity work; it competes with the lease/repair
  logic that is the actual novelty).
- **No role is required to hold everything** — archival super-nodes included.
  Full mirrors are an opt-in bonus, never load-bearing.

The custody repair loop in `src/network/recovery-share.ts` is the same shape as
Phase 3's content repair and was debugged the hard way (see *Key custody*
below): expand-only, generation-aware, never trust a partial write. Reuse that
shape rather than rediscovering it.

### Already closed — don't re-derive these

**Both scale gaps are closed, deployed and manually re-tested.** The
`src/engine/sim` baseline ran first (incl. a 10B projection — ARCHITECTURE.md →
*Measured baseline*), then:

- **G1** — no client ingests the global `accounts` topic. Relays archive
  engine-verified account records and answer `GET /resolve`; clients resolve
  counterparties on demand and verify the record's self-signature
  (`src/network/account-resolver.ts`, `node.resolveAccount`). Offline inbound
  transfers are found via `GET /pending-sends`, explorer TX search falls back to
  `GET /block`.
- **G2** — payments claim from a `GET /head-proof` proof packet
  (`engine/core/counterparty-proof.ts` → `EngineLedger.registerVerifiedSend`)
  and register only the send block; no sender chain is held, and the startup
  foreign-chain refresh burst is gone. Fraud safety moved with it: relays
  height-index the archive, detect same-height forks and gossip the evidence.
  NFTs claim the same way, verifying a second proof for the token's mint
  record (`GET /token`) against the **minter's** chain — so no counterparty
  chain is held at all.

- **G3** (found + closed 2026-08-15) — the global `keyblobs` topic, same shape
  as G1 and missed by its sweep because it hid behind a security rationale
  ("gossiped for peer-independent recovery"). Every client received every
  account's encrypted-key blob. Blobs now move over targeted HTTP only
  (`POST`/`GET /keyblob`, per-IP limited).

**Identity/custody was reworked on 2026-08-15** (see *Key custody* under
Security-critical areas — read it before touching `face-store.ts`,
`recovery-share.ts` or the relay's recovery endpoints). Short version:
`pinVersion=3` seals the keys under `XOR(face, PIN, relay-held share)`, the
share is Shamir 2-of-n across the attesters, and release is gated by a
relay-verified action sequence under server-side backoff.

TESTPLAN T1–T7 green; T1, T5 and T5.3 re-verified on v3 (2026-08-15) with all
four T5 sub-checks including photo-refusal and lockout-survives-a-wipe. Run the
live probe `npx tsx scripts/g1-resolve-smoke.mts` (41 checks) after every relay
deploy.

Lessons from these rounds worth carrying into Phase 3:

- Removing an `O(N)` crutch breaks whatever was quietly free-riding on it
  (offline discovery, TX search, a wiped device's own-chain sync, NFT mint
  records all were). **Enumerate the readers before you stop broadcasting.**
- "Everyone should hold this so nobody depends on anyone" always decays into
  "everyone holds everything" — three times now (`accounts`, `keyblobs`, and
  the reflex to gossip the file index). **Redundancy must be a bounded
  assignment (k named holders), never a broadcast.**
- Any epoch/authority state must be read as an aggregate **across relays** —
  reading only the same-origin relay split the brain twice (SUPERNODE.md →
  *Resets*).
- A rule worth writing in a comment is worth a test. The share-refresh
  ordering was described correctly in a comment, shipped without the guard, and
  destroyed a live account's redundancy within the hour.
- `relay/` edits need a **relay restart**, not just a Vite reload — the plugin
  spawns it once. A stale local relay silently rejected its share and left
  accounts at reduced redundancy.

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
                   storage-manager, account-resolver (G1/G2 archive queries:
                   /resolve, /pending-sends, /head-proof, /token, /block — every
                   response verified client-side)
  ledger/          EngineLedger — the app↔engine bridge, and where the integration
                   tests live (fraud-safety, committee-finality, multi-attester,
                   nft, counterparty-claim, …)
  engine/          the scalable core, a self-contained tested library:
    core/          hash, P-256 keys, partition, Merkle accumulator, attestations,
                   identity/nullifier dedup, blocks, light-verify,
                   counterparty-proof (G2 transfer + mint proofs)
    node/          partial replication, delta sync, archival tiering, snapshots
    consensus/     VRF (RFC 9381), sortition, committees, weight, slashing, fraud
    content/       CIDs, chunking, provider DHT, replication, block backends,
                   provider-ledger (storage registry + custody LEASE + rewards)
    economy/       capped reward inflation
    net/           relay federation (rendezvous hashing)
    sim/           scale-invariant harness: scenario (interest routing),
                   directory (G1), counterparty (G2), archival, projection (10B)
  storage/         Node-side block backends behind the engine's `BlockBackend`
                   (filesystem today; an S3 client adapter is opt-in and
                   OPERATOR-CONFIGURED — never a default). Own tsconfig, in
                   `npm run typecheck`.
relay/             relay / super-node: server.ts (PORT 9090 ws, +1 tcp, +2 HTTP
                   API — see docs/SUPERNODE.md), vite-plugin.ts (dev auto-spawn),
                   ecosystem.config.cjs (pm2). Runtime state (identity keys,
                   face DB, archives) lives in gitignored .relay-data/
scripts/           os.sh / os-setup.ps1 (OpenStack), setup-relay-box.sh,
                   g1-resolve-smoke.mts (live archive-API probe, run per deploy)
```

## The migration seam — read before editing app code

The engine **is** wired into the app: `node.ts` constructs an `EngineLedger`
([node.ts:121](src/network/node.ts#L121)). But the migration is unfinished, and this is
the single most important thing to know about the codebase:

- `npm run typecheck` covers **`src/engine` + `src/storage`** (two configs;
  `src/storage` is the one place `node:*` imports are legitimate, so it has its
  own `tsconfig.storage.json` with node types). It does NOT cover the app layer:
  running `tsc -p tsconfig.json`
  surfaces ~123 errors in `main.ts`, `node.ts`, `neuronchain-api.ts` — the app layer
  still speaks the legacy `AccountBlock`/`Account` shapes while the engine speaks
  `Block`/`LedgerAccount` (`accountPub` vs `accountId` + `shard` + `accumulatorRoot`).
  Vite does not typecheck, so this builds and runs anyway. **Type errors in app files
  are not proof your change is wrong — but never add new ones.** (Take a per-file
  count before and after: the total dropping does not prove your file didn't gain
  errors. Storage parity cut it 182 → 123 while adding four in `storage-manager`.)
- Contracts remain deliberate `deferred()` stubs and are **out of scope by
  design** (no general VM — see ARCHITECTURE.md). Storage no longer is:
  `storage-manager.ts` runs on `EngineLedger` as of 2026-08-15.
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
- **Face MATCHING is a separate subsystem from liveness — keep its three gates
  in agreement.** "Is this the same human?" is decided in three places, all on
  **RAW** descriptors at `MATCH_THRESHOLD` 0.45: `compareFaces` (recovery),
  `findMatchingFace` in `relay/server.ts` (Sybil), and
  `dag-ledger.countMatchingFaceAccounts`. **Never quantize before comparing.**
  `quantizeDescriptor` (QUANT_BIN 0.1) exists only so *key derivation* from the
  stored canonical reproduces its bins; on a unit-norm 128-D descriptor those
  bins are a large fraction of the per-component RMS (~0.088), so quantizing
  amplifies distance by roughly a square root (raw 0.35 → 0.55). Recovery did
  this, which enforced ~0.21 raw — half the intended gate — and made an account
  enrolled in dim light unrecoverable in daylight *by its own owner*, while the
  relay simultaneously refused them a second account for being the same face.
  Pinned by `src/core/face-match.test.ts`, which is also the only place the
  realistic 0.25–0.45 "same person, different session" band is tested; the older
  face tests only ever compare a descriptor to itself or to an obvious stranger.
  Note the live scan does **not** feed key derivation for `pinVersion` ≥ 1 (the
  canonical comes out of the blob), so it is purely a gate — and **nothing else
  may key off a live scan either**, because a fresh camera frame cannot
  reproduce a 128-D bin vector. (`pinAttemptState` did exactly that and its
  counter never decrypted once; fixed 2026-08-15 — read per-branch under the
  key each blob version was written with.)
- **Key custody (pinVersion=3, 2026-08-15) — the blob alone must never be
  enough.** v2 sealed `encryptedCanonical` under the PIN key alone, so the PIN
  unlocked the face descriptor and the descriptor was the other half of the
  "combined" key: anyone holding the public blob was one 4-digit offline
  brute-force (~50 min of PBKDF2) away from the account keys AND the biometric.
  Proven by running the attack (`face-match.test.ts` keeps it as the v2 control).
  The general lesson: **N factors sealed inside one public object are worth
  exactly the weakest factor** — a second encryption layer in the same blob
  changes nothing. v3 splits custody instead: keys under
  `XOR(faceBytes, pinBytes, shareBytes)`, canonical under `XOR(pin, share)`,
  where the 32-byte **recovery share** lives ONLY on the relays
  (`.relay-recovery-shares.json`, nid-bound), released by
  `POST /recovery-share/release` to a live face the relay itself matches, under
  server-side exponential backoff — the one rate limit a client wipe cannot
  reset. Devices cache the share after proving themselves (pin-crypto IDB), so
  relays are needed for *fresh-device recovery only*, not daily use. The keyblobs
  gossip topic is REMOVED (it broadcast every blob to every node — O(N) and a
  harvesting surface); blobs move via `POST/GET /keyblob` only. Never put the
  biometric in the public account record under any single factor, and never
  create new v2 blobs.
- **The share is Shamir 2-of-n across the attesters** (`src/core/shamir.ts`), so
  no single relay holds the third factor at all — a rogue/compromised/subpoenaed
  relay learns nothing from its own disk, and an attacker must pass TWO
  face-gated, backoff-limited releases. Any 2 of n reconstruct, so one-relay-down
  recovery still works (dev has 3 attesters: 2 cloud + the auto-spawned local
  dev relay — which is also why account creation logs 3 attestations). The
  x-coordinate is inside the signed store payload; shares from different splits
  combine into silent garbage, hence the same-`ts` guard client-side. A single
  reachable relay falls back to a legacy full-secret record.
- **Release requires a trajectory proof, not a descriptor** (`recovery-challenge.ts`,
  pure + vitest-pinned because relay/server.ts is covered by nothing). The relay
  draws an ordered 3-of-5 action sequence per attempt; the client submits its
  detector's own peak ratios, timestamps and a per-action descriptor, and the
  relay checks order, ratio floor, human pacing, and that EVERY descriptor
  matches the account's nid. This kills the still-photo attack and stolen-session
  replay. **Documented ceiling:** the numbers are client-computed, so custom
  tooling around a photo-derived descriptor can still fabricate them — closing
  that needs the verifier to see trusted sensor data (heavy). Do not describe
  this gate as liveness-proof; it raises cost, it does not prove personhood.
- **Neither descriptor spread nor luma separates good lighting from bad — the
  cross-session distance is the only number that decides recoverability.**
  Measured 2026-08-15, same face and camera: a dim room lit by a phone flashlight
  gave `spread max=0.150, luma=147`; decent natural light gave `max=0.154,
  luma=172`. The *worse* light scored the *lower* spread (steady flashlight →
  three near-identical samples; diffuse daylight → shading shifts between them),
  so spread measures capture **stability**, not fidelity. And luma read 147 in a
  room lit only by a phone, which is the auto-gain effect that rules out a
  luminance floor, measured rather than argued. `ENROLL_SPREAD_LIMIT`
  (= `MATCH_THRESHOLD`) is therefore a backstop against captures that cannot work
  at all — three shots of one face further apart than two different people may
  be — **not** a lighting gate, and tightening it toward `ENROLL_SPREAD_WARN`
  would reject the good enrollment before the bad one. `DARK_LUMA` remains
  wording-only. The number to reason from is `matchOrLog`'s
  `[face] recovery match distance=… margin=… PASS/FAIL`, logged on passes too —
  a threshold cannot be judged without the distribution of real successes.
- **Consensus.** Fraud-proof safety + ECVRF committee finality. Don't weaken the
  challenge window, slashing, or equivocation freezing.
- **Cross-account replay order.** Persisted blocks are replayed sorted
  accountId-then-index, so a recipient's chain may load before the sender's.
  Anything that validates against another account's block must tolerate arriving
  first (see the NFT mint/receive guards in `engine-ledger.ts`), or a reload
  silently drops state and truncates the chain behind it. Two rules follow, both
  learned from live failures — do not regress them:
  - **Never derive cross-account state last-write-wins.** Replay order is not
    causal order. NFT ownership is derived from per-token *custody* (for each
    account, the index of the latest block in ITS OWN chain touching the token,
    and whether that left it holding). A round trip broke the naive rule: the
    previous owner's older receive replayed last and took the token back.
  - **Anything a proof claim registers must be persisted.** `registerVerified*`
    puts foreign blocks in `allBlocks`, but a proof claim holds none of the
    counterparty's chain, so nothing else rebuilds them. They are saved and
    re-seated on start via `restoreVerifiedBlock` (which re-checks hash +
    signature; `addBlock` rejects them for want of chain context). Lose the
    `nft-mint` and the token renders as nothing; lose the `nft-send` and the
    sender looks like they still hold it.
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
  ⚠ `relay/` is covered by **neither** `npm run typecheck` (engine + storage) nor any
  test — an undefined variable in a 60 s timer once crash-looped both cloud boxes
  47 times before anyone noticed. Re-read relay edits carefully, and after
  deploying check `pm2 jlist` restart counts **after** the interval has fired
  (>60 s), not immediately.
