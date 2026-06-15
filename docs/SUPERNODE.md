# Super-node / relay operations (neuronweb.org)

The same process (`relay-server.ts`) plays three roles. From Phase 1 it is also the
network's first **archival super-node**.

| Role | What it does |
|------|--------------|
| **Relay** | libp2p circuit-relay v2 + GossipSub routing so browsers behind NAT reach each other. Mirrors every `neuronchain/<ver>/*` topic peers use, so it forwards the dynamic per-shard + inbox topics. |
| **Attester** | Signs engine personhood attestations over `deriveCommitment(nullifier, accountId)` (face-verify HTTP endpoints). One-human-one-account via nullifier dedup. |
| **Archival super-node** | Persists every engine block it sees (`ARCHIVE`), and serves account-chain **delta requests** from that archive — the durable shard holder that makes recovery-after-wipe work. |

> **This is the canonical archival super-node.** As the network grows, add more
> (sharded, K-redundant, DHT-discovered — see *Scaling* below). This is node #1.

---

## Ports

| Port | Purpose | Exposure |
|------|---------|----------|
| `9090` (`PORT`) | libp2p WebSocket relay | behind nginx (`wss .../relay-ws` → `:9090`) |
| `9092` (`PORT+2`) | HTTP: `/relay-info`, `/face-verify/*`, `/log-reload`, and the `/smoke-hub` WS | behind nginx |

Keep 9090/9092 **localhost-only** (firewalled); only nginx (443) is public.

---

## Runtime files (in the relay's working directory)

All are **gitignored — never commit them**, and **back them up** (losing the peer-id
or attester key changes the node's identity and breaks the baked bootstrap address).

| File | Contents | If lost |
|------|----------|---------|
| `.relay-peer-id.json` | libp2p identity → peerId `12D3KooWDqCw…` | bootstrap addr in `vite.config.ts` stops resolving for clients |
| `.relay-attester-key.json` | attester signing key | existing attestations no longer verify against this attester |
| `.relay-signing-key.json` | relay signing key | re-announce needed |
| `.relay-face-db.json` | enrolled face descriptors + per-face account counts | face Sybil limit resets |
| `.relay-engine-blocks.json` | archived engine blocks (the archive) | re-fills from gossip, but recovery durability is degraded until it does |
| `.relay-keyblobs.json` | archived face+PIN-encrypted key-blobs (for peer-independent recovery) | recovery needs a live peer holding the blob until it re-fills |
| `.relay-usernames.json` | username→accountId registry (uniqueness; first-attested wins) | username uniqueness resets — duplicates could be attested |
| `.relay-operators.json` | the first 3 accountIds attested — the only accounts allowed to wipe this relay | anyone could re-claim an operator slot; **kept across wipes** |

---

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `PORT` | `9090` | WS relay; HTTP is `PORT+2` |
| `ARCHIVE` | on | `ARCHIVE=0` → pure relay, no engine-block archival |
| `ENGINE_BLOCKS_FILE` | `.relay-engine-blocks.json` | archive path |
| `PEER_RELAYS` | empty | comma-separated multiaddrs of *other* super-nodes/relays to federate with |
| `FACE_DB_FILE` / `SIGNING_KEY_FILE` / `ATTESTER_KEY_FILE` / `PEER_ID_FILE` | `.relay-*.json` | identity/state paths |

`LOCAL_ONLY` is a **dev-only** flag (it gates the Vite dev plugin + client build); the
standalone `npm run relay` ignores it. **Do not set it on the server.**

---

## First-time setup / cutover (replacing an old relay)

The pre-engine deployment ran a self-contained `node relay-server.js` (often as root).
The current relay is **`relay-server.ts`, run via `tsx`**, and needs `src/engine/` +
`node_modules`.

```bash

# 1. (server) make the domain folder track the repo, preserving identity/state
cd /home/admin/domains/neuronweb.org
mkdir -p ~/relay-keys-backup && cp .relay-*.json ~/relay-keys-backup/ 2>/dev/null
git init
git remote add origin https://github.com/GratitudeTokenWorld/neuron-web.git
git fetch origin
git checkout -b main origin/main      # .relay-*.json are gitignored → untouched
rm -f relay-server.js                 # old runtime; replaced by relay-server.ts
npm install                           # tsx + engine deps


# 2. start the new relay as a NON-ROOT user under pm2
pm2 start npm --name neuron-relay -- run relay
pm2 save
pm2 logs neuron-relay                 # expect: "Loaded N engine block(s)", "listening on port 9092"
```

Updates thereafter: `git pull && npm install && pm2 restart neuron-relay`.

> **Security:** run as a normal user (not root). Ports 9090/9092 are >1024 so no root is
> needed; nginx (root) owns 443.

---

## nginx (TLS termination + reverse proxy)

You likely already have the `/relay-ws` block (the old relay served over wss). Ensure all
four routes exist:

```nginx
server {
  listen 443 ssl;
  server_name neuronweb.org;
  # ... ssl_certificate / ssl_certificate_key ...

  # libp2p WebSocket relay  (matches /tcp/443/wss/http-path/relay-ws in the bootstrap addr)
  location /relay-ws {
    proxy_pass http://127.0.0.1:9090/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;   # don't kill idle libp2p streams
  }

  # smoke content-CDN hub (WebSocket)
  location /smoke-hub {
    proxy_pass http://127.0.0.1:9092;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 86400s;
  }

  # attester + relay info (HTTP)
  location /face-verify { proxy_pass http://127.0.0.1:9092; }
  location /relay-info  { proxy_pass http://127.0.0.1:9092; }

  # the web app (static dist) — if served from here
  location / { root /home/admin/domains/neuronweb.org/dist; try_files $uri /index.html; }
}
```

If neuronweb.org also serves the **web app**, rebuild it from the new code so users get
Phase 1 — and build **without** `LOCAL_ONLY` so the bootstrap addr stays baked:
`npm run build` (output in `dist/`).

---

## Monitoring

`pm2 logs neuron-relay` — useful lines:
- `[Archive] Loaded N engine block(s)` — on boot.
- `[Archive] Stored <type> acct=… idx=… shard=…` — a block was archived.
- `[Archive] Delta req acct=… shard=… have=… → served N/total` — a peer pulled a chain.
- `[Attester] personhood attestation acct=… face=k/MAX` — an account was attested.

These are verbose (one line per block/request); fine for the first node, quiet them
behind a `DEBUG`-style flag once traffic grows.

---

## Backups

Cron a copy of the identity + archive off-box:
```bash
tar czf relay-backup-$(date +%F).tgz .relay-peer-id.json .relay-attester-key.json \
  .relay-signing-key.json .relay-face-db.json .relay-engine-blocks.json \
  .relay-keyblobs.json .relay-usernames.json
```
The first two are the ones you cannot regenerate.

---

## Resets & operators

A network reset is honored **only** when **signed by an operator** — the first
`OPERATOR_COUNT` (3) accounts this relay ever attests, recorded in
`.relay-operators.json` and served (with the current `generation`) in `/relay-info`.
An operator reset wipes **everything, everywhere**: the relay's stores (engine
blocks, key-blobs, usernames) **and** every connected client's local data (clients
verify the operator signature before wiping; late/offline clients converge via the
`generation` in `/relay-info` on next start/refresh). Any **non-operator** "Reset
Testnet" is **ignored** by the relay and by all other clients — it only clears
that one user's own device (which then re-syncs). This stops a stray browser from
nuking the shared network while letting a founder reset it.

- **Establishing operators:** the first 3 accounts created after the relay starts
  (with an empty operators file) become the operators. Back up `.relay-operators.json`.
- **Authorized reset:** an operator clicks Reset Testnet from a browser whose
  *first* local account is that operator account; the client signs the reset and
  the relay wipes (`[Archive] WIPED by operator …`). The operators list itself is
  kept across the wipe (so founders stay founders; they recover via their keys).
- **Bootstrap / manual wipe** (no operators yet, or you want to force one):
  ```bash
  pm2 stop neuron-relay
  rm -f .relay-engine-blocks.json .relay-keyblobs.json .relay-usernames.json
  # also rm .relay-operators.json to re-elect operators from the next 3 accounts
  pm2 start neuron-relay
  ```

---

## Scaling (how this stays fast + safe at 1B accounts)

The principle: **shard so nothing is whole, index by accountId so nothing is scanned,
verify so nothing is trusted.**

- **Shard the archive across many super-nodes.** No node holds all 4096 shards — each
  holds a few (~244K accounts/shard at 1B), K-redundant (3–5 holders/shard). One node
  holding 16 shards ≈ tens of GB, not TB.
- **Storage engine:** the JSON archive here is fine for the first node / testing. At
  scale, swap `.relay-engine-blocks.json` for a **per-shard LSM store (RocksDB/LevelDB)
  keyed by accountId** — point lookups stay single-digit-ms at TB scale. Queries are
  always per-account key lookups, **never global scans** (global/analytics views belong
  in a separate indexer off the hot path).
- **Hot/cold tiering:** keep heads + recent hot; move cold history to content-addressed
  storage (CID), still provable via the Merkle accumulator (engine `ArchivingStore`).
- **Edge absorbs most reads:** browsers hold own+followed and act as caches; super-nodes
  are hit only for bootstrap, followed-misses, and durability.
- **Safety = verification, not trust:** every block is account-signed and accumulator-
  committed, so light clients verify what a super-node serves (`light-verify`). A bad
  holder can only *withhold* (covered by K-redundancy), never forge.

### Deferred to the sharded-storage phase (Bucket B)
Super-node #2 (akashicrecords.dev) is live, but both relays are still **full
replicas**, so these two only pay off once storage is actually **partitioned across
many holders** — they are deferred to the Bucket B networking refactor:
- **DHT discovery (Slice 4b):** `kadDHT` server-mode + `contentRouting.provide/findProviders`
  to map `shard → holders` in O(log N). With full-replica relays, `findProviders` just
  returns the relays already in the baked bootstrap list — no new information yet.
- **Per-shard snapshot bootstrap (Slice 4c):** `createShardSnapshot`/`applyShardSnapshot`
  over the content CDN. Needs an `EngineLedger → AccountStore` head-proof bridge
  (accumulator inclusion proofs) — itself B-shaped. A browser only holds own+followed
  (tiny), so account-scoped **delta pull** already bootstraps it instantly; snapshots
  matter for *super-node* backfill (see below), not light clients.

---

## Running two super-nodes: redundancy + the two-node test

Two relays give **redundant reachability** (the app bootstraps to both — baked into
`vite.config.ts` `__BOOTSTRAP_ADDRS__`) and **redundant durability** (each archives
the network). To make them a true federation:

**1. Reciprocal `PEER_RELAYS`.** Each relay must list the *other* so their GossipSub
meshes merge (otherwise browsers on relay A can't see relay B's traffic):

```bash
# on neuronweb.org
PEER_RELAYS=/dns4/akashicrecords.dev/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWAgfdTJ9v9eJbQXYZ5Uo6wxPWodZJxzFn3vqiCWAhyXJi
# on akashicrecords.dev
PEER_RELAYS=/dns4/neuronweb.org/tcp/443/wss/http-path/relay-ws/p2p/12D3KooWDqCwT9M8VFAZJ2qGDPuxYqdFpa5nAXJcyp7eXAQJYsf7
```

Set in the pm2 env and restart (`pm2 restart neuron-relay --update-env`). After this,
both relays archive **new** gossip from each other.

**2. One-time history backfill (only if the new relay missed past data).** A fresh
relay (akashicrecords.dev reports `generation: 0`) only archives gossip seen *after* it
joined — it does not pull pre-existing history. Until automated relay-to-relay backfill
lands (Bucket B), copy the archive once:

```bash
# from neuronweb.org → akashicrecords.dev (relay stopped on the target)
pm2 stop neuron-relay   # on akashicrecords.dev
scp neuronweb.org:/home/admin/domains/neuronweb.org/.relay-engine-blocks.json  ./
scp neuronweb.org:/home/admin/domains/neuronweb.org/.relay-keyblobs.json       ./
scp neuronweb.org:/home/admin/domains/neuronweb.org/.relay-usernames.json      ./
pm2 start neuron-relay  # archives merge on load
```
(If the network is still early/empty, skip this — there's nothing to backfill.)

**3. Two-node browser validation.** Confirms cross-relay sync end-to-end:
- Build + deploy the app with both relays in the bootstrap list (already baked).
- **Browser A** (e.g. via neuronweb.org): create account *alice*, note balance.
- **Browser B**, different profile/incognito (e.g. via akashicrecords.dev): create *bob*.
- A sends UNIT → bob. **Expect:** bob's balance updates in Browser B (cross-relay
  delivery), and on reload both persist. Recover bob on a third wiped browser → balance
  restored from either relay (redundant durability).
- *Committee finality* shows `final` only with a real per-shard validator population; a
  1–2 account testnet stays optimistic `confirmed` (the fraud-proof challenge window is
  the backstop) — that's expected, not a bug.

### Attester #2 (multi-attester personhood)
The engine enforces a **k-of-N distinct-attester** quorum on account open
(`checkQuorum`; tested in `src/ledger/multi-attester.test.ts`). akashicrecords.dev
already issues personhood attestations (it has a `signingPub`). To require **2-of-2**,
the *client* must collect an attestation from **both** relays during account creation
and include both in the open block, and the ledger's `identityPolicy` is set to
`{ min: 2, requiredTypes: ['personhood'] }`. The client-side collection lands with the
UI/API refactor (Bucket B); until then the policy stays `min: 1` and a single attester
is the (known) SPOF.
