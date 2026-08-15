# Super-node / relay operations (neuronweb.org)

> **Dev-relay variant (2026-08):** for the two bare-IP dev boxes on cloudify.ro
> (no domain / no nginx / no TLS), provisioning is scripted —
> [`scripts/setup-relay-box.sh`](../scripts/setup-relay-box.sh) — with ports
> 9090–9092 exposed directly and clients connecting via `/ip4/<ip>/tcp/9090/ws`
> multiaddrs + `http://<ip>:9092` for `/relay-info` + `/face-verify`. That works
> only from `http://localhost` dev pages (mixed content blocks it from https).
> Everything below (nginx/TLS/domain) is the *production* deployment shape.
> Manual test matrix for the dev pair: [TESTPLAN.md](TESTPLAN.md).

The same process (`relay/server.ts`) plays three roles. From Phase 1 it is also the
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
| `9092` (`PORT+2`) | HTTP API (below) + the `/smoke-hub` WS | behind nginx |

Keep 9090/9092 **localhost-only** (firewalled); only nginx (443) is public.

---

## HTTP API (port 9092)

Everything a client needs that gossip cannot give it on demand. **All of it is
untrusted**: every response is self-certifying (account-signed records,
account-signed blocks, Merkle inclusion proofs) and re-verified client-side, so
a relay can *serve* or *withhold*, never forge. That is what lets the archive
tier answer queries without becoming an authority.

| Route | Answers | Verified by the client with |
|---|---|---|
| `GET /relay-info` | peerId, multiaddrs, `signingPub`, `operators`, `generation` | — (bootstrap/discovery; the reset epoch is cross-checked against the other relays, see *Resets*) |
| `GET /resolve?username=\|pub=&network=` | one account record (**G1** directory tier) | record self-signs `account:{pub}:{username}:{createdAt}:{faceMapHash}` with the account's engine key |
| `GET /pending-sends?pub=&network=` | `{ headIndex, sends[] }` — transfers addressed to `pub`, plus the archive's head index for `pub`'s own chain | a hint only: each send is then pulled/proven; `headIndex` gates claiming (see below) |
| `GET /head-proof?pub=&send=&network=` | counterparty proof packet (**G2**): sender's open + head + send blocks with two RFC-6962 audit paths | `verifyPacket` — verified-human genesis, signed head, send inclusion |
| `GET /token?id=&network=` | an NFT's mint proof (**G2**): the MINTER's open + head + `nft-mint` blocks with audit paths | `verifyMintProof` — token id match, mint inclusion on a verified-human chain |
| `GET /block?hash=&network=` | one archived block, for explorer search | content hash + account signature; display-only, never applied to the ledger |
| `POST /face-verify/challenge` \| `/verify` | personhood attestation (attester role) | attestation signature + quorum on the open block |
| `POST /keyblob` \| `GET /keyblob?username=\|pub=&network=` | targeted key-blob store/fetch (replaced the global `keyblobs` gossip topic 2026-08-15 — an O(N) broadcast and harvesting surface) | blob opens only with face+PIN+share (v3); `linkedAnchor` re-checked against the on-chain record at recovery. Per-IP limited |
| `POST /recovery-share` | store this relay's **Shamir 2-of-n share** of the account's v3 secret, bound to the owner's `nid` | signed `recovery-share:{accountId}:{network}:{x}:{share}:{ts}` by the account's engine key (the x-coordinate is inside the signature so it cannot be stripped/renumbered); newest signed `ts` wins |
| `POST /recovery-share/challenge` | draw this relay's ordered action sequence (3 distinct of 5) for one release attempt | single-use session; a stolen performance matches a fresh draw ~1-in-60, under the release backoff |
| `POST /recovery-share/release` | **the recovery gate**: release this relay's share after verifying the trajectory proof + `nid` match | `verifyTrajectory` (ordered actions, ratio floor, human pacing, one-person descriptors — pure module, vitest-pinned) then every descriptor matched to the account's `nid`; per-account exponential backoff (3 free, then 30s·4ⁿ up to 24h) + per-IP cap; response ECDH-wrapped to the client's ephemeral key |

**Two relays must release before an account recovers.** The secret is Shamir
2-of-n across the attesters, so this box's `.relay-recovery-shares.json` is
information-theoretically independent of it: reading the file yields nothing,
and a single rogue relay cannot reconstruct. Any 2 of n suffice, so one relay
being down does not block recovery.

> ⚠ **KNOWN GAP — share sets do not self-heal (found 2026-08-15).** `n` is fixed
> at account creation: an account created while only two attesters were
> reachable is **2-of-2 and has no redundancy at all** — losing either custodian
> makes it permanently unrecoverable — and a relay that comes back later never
> receives a share for it. Verified in dev: an account created with relay-2
> stopped still holds shares on only two relays after relay-2 returned.
> The fix is a **share refresh**: whenever the client legitimately holds the
> secret (right after creation or a successful recovery), re-split across all
> currently-reachable attesters and re-store with a newer `ts` — the
> newest-signed-`ts`-wins rule already makes that a rotation rather than a new
> mechanism. Until that ships, treat "how many relays were up at creation" as
> the account's durability, and prefer creating accounts with all attesters
> online. Same principle as Phase 3 content durability: repair must outpace
> churn, and a set fixed at creation degrades monotonically.
| `POST /log-reload` | dev telemetry sink | — |

**`/recovery-share/release` is the exception to "a relay can serve or withhold,
never forge".** The share is not client-verifiable content — it is a secret the
relay custodies, and the face match that gates it runs ON the relay (against its
own face DB, read-only). That makes this the one endpoint where the relay is an
*authority*, which is deliberate: the whole point is rate limiting that an
attacker cannot reset, and only a party the attacker must talk to can provide
that. The blast radius of a rogue relay stays bounded — share + blob still
needs the PIN (600k-iteration PBKDF2 per guess), i.e. exactly the pre-v3 bar.

Two subtleties worth knowing before changing any of this:

- **`headIndex` is a safety interlock, not a convenience.** A client whose own
  chain trails the archive must finish syncing before it claims anything: a
  receive built on a stale head forks the claimant's *own* chain, which is
  cryptographically indistinguishable from a deliberate double-spend and gets
  the account frozen network-wide. (That is exactly what a wiped-device
  recovery did on 2026-08-09 — claimed at +1.5 s, forked itself, and every
  reload minted another sibling.)
- **`/head-proof` refuses a gappy or forked archive** (it requires the
  contiguous chain `0..head`, since the accumulator commits every leaf). The
  client then falls back to the delta chain-pull, where a conflict surfaces as
  evidence instead of a bad proof.

---

## Runtime files (in `.relay-data/` under the repo root)

All relay runtime state lives in the gitignored **`.relay-data/`** directory
(override with `RELAY_DATA_DIR`; per-file `*_FILE` env overrides still win).
**Never commit these; back them up** (losing the peer-id or attester key changes
the node's identity and breaks the baked bootstrap address).

| File | Contents | If lost |
|------|----------|---------|
| `.relay-peer-id.json` | libp2p identity → peerId `12D3KooWDqCw…` | bootstrap addr in `vite.config.ts` stops resolving for clients |
| `.relay-attester-key.json` | attester signing key | existing attestations no longer verify against this attester |
| `.relay-signing-key.json` | relay signing key | re-announce needed |
| `.relay-face-db.json` | enrolled face descriptors + per-face account counts | face Sybil limit resets |
| `.relay-engine-blocks.json` | archived engine blocks (the archive) | re-fills from gossip, but recovery durability is degraded until it does |
| `.relay-keyblobs.json` | archived encrypted key-blobs (for peer-independent recovery; arrive via `POST /keyblob`) | recovery impossible until the owner's next blob update re-stores it (no gossip re-fill any more) — the OTHER relay's copy is the redundancy |
| `.relay-recovery-shares.json` | **v3 recovery shares** — this relay's Shamir 2-of-n share of each account's third key factor, nid-bound, with server-side backoff state. Written `0600`; **never** logged or served except via the face-gated release. One share alone reveals nothing about the secret | affected accounts can never complete a fresh-device recovery again once fewer than 2 relays hold a share (devices with the secret cached still work). Check the OTHER relays' copies before wiping this file |
| `.relay-usernames.json` | username→accountId registry (uniqueness; first-attested wins) | username uniqueness resets — duplicates could be attested |
| `.relay-accounts.json` | account-record archive (G1 directory tier): engine-verified records served via `/resolve` | re-fills from owners' 20 s publish ticks; until then clients can't resolve usernames this relay alone knew |
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
The current relay is **`relay/server.ts`, run via `tsx`** (`npm run relay`), and needs
`src/engine/` + `node_modules`.

```bash

# 1. (server) make the domain folder track the repo, preserving identity/state
cd /home/admin/domains/neuronweb.org
git init
git remote add origin https://github.com/GratitudeTokenWorld/neuron-web.git
git fetch origin
git checkout -b main origin/main      # .relay-*.json are gitignored → untouched
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

  # attester + relay info + the archive query API (see "HTTP API" above)
  location /face-verify   { proxy_pass http://127.0.0.1:9092; }
  location /relay-info    { proxy_pass http://127.0.0.1:9092; }
  location /resolve       { proxy_pass http://127.0.0.1:9092; }
  location /pending-sends { proxy_pass http://127.0.0.1:9092; }
  location /head-proof    { proxy_pass http://127.0.0.1:9092; }
  location /token         { proxy_pass http://127.0.0.1:9092; }
  location /block         { proxy_pass http://127.0.0.1:9092; }

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
tar czf relay-backup-$(date +%F).tgz .relay-data/
```
The peer-id and attester-key files are the ones you cannot regenerate.

---

## Data integrity & permissions

The relay is a **cache, not the source of truth** — engine blocks are
account-signed + accumulator-committed, key-blobs open only with face+PIN+share
(v3), and any loss re-derives from clients + gossip + the other super-node. So
tampering with a store file is mostly *detectable denial*, not theft. The one
exception is `.relay-recovery-shares.json`: it is custody, not cache — a secret
per account, replicated only on the attester relays, and reading it is the
"rogue relay" case in the threat model (still PIN-gated, but treat the file
like the identity keys). On top of that, the relay
hardens its own persistence (Tier 1):

- **Atomic writes.** Every store file is written via temp → `fsync` → `.bak`
  snapshot → atomic `rename`, so a crash/power-loss mid-write can't truncate or
  corrupt it, and a reader never sees a half-written file. The `.tmp`/`.bak`
  sidecars are gitignored.
- **Verify-on-load.** The engine-block archive re-decodes + hash/signature-checks
  every entry on boot; tampered/corrupt blocks are dropped (and counted in the
  `Loaded N engine block(s) (dropped X invalid)` log line), never served.
- **Key files are written `0o600`** (owner-only). Files created *before* this
  landed must be tightened once, by hand:
  ```bash
  chmod 600 .relay-attester-key.json .relay-signing-key.json .relay-peer-id.json
  ```
  The attester key is consensus-critical (it signs personhood) — guard it, and let
  **attester #2 / 2-of-2** be the structural defense so one stolen key isn't enough.

**Recommended (optional, not required):** run the relay as a **dedicated non-root
user**. It contains the blast radius if the process is ever remotely exploited
(an RCE gets that user's files, not root on the box). It is *not* necessary on a
dedicated single-purpose box (there's little else to contain, and it doesn't
protect the attester key either way), and it does **not** require regenerating the
node — just `adduser`, `chown` the existing relay folder (identity preserved), and
re-register pm2 under that user. Do it if you ever co-locate other services or want
defense-in-depth.

**Deferred hardening:** HMAC-tag the non-self-authenticating bookkeeping files
(`operators`/`usernames`/`generation`) so external/accidental edits are detected
(Tier 2); migrate the JSON stores to a checksummed, crash-safe LSM store
(LevelDB/RocksDB or SQLite-WAL) — robustness + TB-scale in one (Tier 3, see
*Scaling*).

---

## Operational hardening (logs, memory, limits)

These keep the box healthy under load **without** capping how large the network
can grow — every limit below is either a *safety backstop* (triggers only on a
leak/crash) or *per-IP* (stops one abuser; more users = more IPs, so it never
throttles legitimate growth). The relay is also designed to scale **horizontally**
(add more relays), not by uncapping a single box.

**1. Log rotation** (pm2 logs grow unbounded otherwise — eventual disk-fill = outage):
```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 10
pm2 set pm2-logrotate:compress true
```
(Per-block/per-request archive logging is already quiet unless `DEBUG_ARCHIVE=1`.)

**2. Memory backstop via the ecosystem file** (`relay/ecosystem.config.cjs`, committed).
`max_memory_restart` is a runaway/leak backstop, **not** a throughput cap — it
never throttles requests/connections. Migrate from the bare `pm2 start npm …` to it:
```bash
export PEER_RELAYS="/dns4/<other-relay>/tcp/443/wss/http-path/relay-ws/p2p/<id>"
export RELAY_MAX_MEMORY=1G        # tune to ≈70–80% of box RAM
pm2 delete neuron-relay
pm2 start relay/ecosystem.config.cjs && pm2 save
```
The real fix for memory-at-scale is the on-disk LSM store (Tier 3 / *Scaling*), not
a tighter cap.

**3. Raise the file-descriptor limit** (this *helps* scaling — libp2p opens many
fds; the default 1024 is exhausted as connections grow):
```bash
# add to /etc/security/limits.conf (or the relay user's systemd unit):
#   <user>  soft  nofile  65535
#   <user>  hard  nofile  65535
ulimit -n        # verify in the relay's shell after re-login
```

**4. Per-IP request limiting at nginx (optional, scaling-safe).** Caps a single
abusive IP, not total throughput. Keep the rates generous:
```nginx
# http{} block:
limit_req_zone  $binary_remote_addr zone=relay:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=relayconn:10m;
# inside the 443 server{}:
limit_req  zone=relay  burst=40 nodelay;
limit_conn relayconn 50;
```
Tune up if legitimate clients ever hit it. Do **not** add a global (non-per-IP)
cap — that *would* limit network growth.

**5. Health + disk monitoring.** A simple external check on `/relay-info`
(uptime) plus a disk-space alert catches the two most common silent failures.
`certbot renew --dry-run` once to confirm TLS auto-renewal is armed.

**Knobs to raise as you grow (not now):** `maxReservations` (1024 browser
circuits/relay) and the per-circuit data limit — raise these, or better, add more
relays, when a single box approaches saturation.

---

## Resets & operators

A network reset is honored **only** when **signed by an operator** — the first
`OPERATOR_COUNT` (3) accounts this relay ever attests, recorded in
`.relay-operators.json` and served (with the current `generation`) in `/relay-info`.
An operator reset wipes **everything, everywhere**: the relay's stores (engine
blocks, key-blobs, usernames, account records) **and** every connected client's
local data (clients verify the operator signature before wiping; late/offline
clients converge via the `generation` in `/relay-info` on next start/refresh).
Face **slot counts** are zeroed too — they count accounts, and the wipe just
destroyed every account — while each face's descriptor + `nid` are **kept**, so
one human still maps to one nullifier across a reset (otherwise
one-human-one-account would reset with the chain, making reset a Sybil tool).
Any **non-operator** "Reset Testnet" is **ignored** by the relay and by all other
clients — it only clears that one user's own device (which then re-syncs). This
stops a stray browser from nuking the shared network while letting a founder
reset it.

### Convergence — a reset must reach every relay and every browser

Two independent split-brains bit on 2026-08-09; both are now closed, and both
are worth understanding before touching this code:

- **Clients aggregate across relays, not just the same-origin one.**
  `fetchNetworkStatus()` takes the **max `generation`** and the **union of
  `operators`** over the same-origin relay *and* the baked cloud relays. Reading
  only the same-origin relay meant (a) a reset applied on the cloud boxes left
  every browser on the old epoch — still holding, and resolving from, records of
  accounts the reset had destroyed, which misrouted a payment to a dead account;
  and (b) when that relay's operator list re-elected, the client-side gate
  decided "not an operator" and silently downgraded a network reset to a
  device-only wipe, which is why face limits appeared to survive resets. The
  union is only a **UX gate** — every relay still verifies the reset signature
  against **its own** operator list.
- **Relays follow their peers.** Each relay polls `PEER_RELAYS`' `/relay-info`
  every 60 s; a peer reporting a **higher** generation is proof of a reset this
  relay missed (it was restarting, had no operators yet, or joined later), so it
  performs the same full wipe. Content is client-verified, so following a peer's
  epoch *number* trusts it with cache lifetime only, never with content.

Net effect: a reset landing on any one relay propagates to all of them within
~60 s, and browsers converge on their next start or 2-minute poll.

- **Establishing operators:** the first 3 accounts created after the relay starts
  (with an empty operators file) become the operators. Back up `.relay-operators.json`.
- **Authorized reset:** an operator clicks Reset Testnet from a browser whose
  *first* local account is that operator account; the client signs the reset and
  the relay wipes (`[Archive] WIPED by operator …`). The operators list is
  **cleared too**, so the next 3 accounts attested after the wipe become the new
  operators. (It used to be kept — but a wipe destroys every account chain *and*
  every key-blob, so the old operator accounts are unrecoverable by anyone;
  keeping them made the first reset a one-way door with no live account able to
  authorize the next one.)
- **A non-operator reset clears only that browser** — the relays and other
  clients ignore it, and the device keeps the network's current generation so it
  simply re-syncs. (Before 2026-08-09 it also bumped its own generation, which
  silently made the device deaf to all inbound gossip; see `clearAll`.)
- **Bootstrap / manual wipe** (no operators yet, or you want to force one). Bump
  the generation and zero the face counts as well, or clients will not converge
  and the face limit will bar accounts that no longer exist:
  ```bash
  pm2 stop neuron-relay
  cd .relay-data
  rm -f .relay-engine-blocks.json .relay-keyblobs.json .relay-usernames.json \
        .relay-accounts.json .relay-operators.json \
        .relay-recovery-shares.json                         # operators re-elect
  # ^ shares go with the accounts they unlock: a wipe destroys the chains, so
  #   keeping orphaned third factors around would only be attack surface.
  node -e 'const f=require("fs");
    f.writeFileSync(".relay-generation.json", String(<NEW_GEN>));
    const db=JSON.parse(f.readFileSync(".relay-face-db.json","utf8"));
    for (const e of db) e.count = 0;            // keep descriptor + nid
    f.writeFileSync(".relay-face-db.json", JSON.stringify(db));'
  cd .. && pm2 start neuron-relay
  ```
  Do it on **one** relay and the generation follower carries it to the others
  within 60 s; do it on the local dev relay too if you run one, since browsers
  take the max epoch across all of them.

---

## Scaling (how this stays fast + safe at 10B accounts)

The principle: **shard so nothing is whole, index by accountId so nothing is scanned,
verify so nothing is trusted.**

- **Shard the archive across many super-nodes.** No node is *required* to hold all
  4096 shards (opt-in full mirrors stay welcome as a durability bonus — the two dev
  relays are exactly that). At 10B accounts one shard ≈ 2.44M accounts, so whole-shard
  assignment puts an O(N/4096) floor under every holder; the measured target shape
  (`src/engine/sim/archival.ts`) assigns **per-account** via rendezvous (HRW) instead —
  K holders per account out of an open fleet, each node bounded by its declared
  capacity, largest node's share of the archive → 0 as the fleet grows.
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
scp <source-relay>:<repo>/.relay-data/.relay-engine-blocks.json  .relay-data/
scp <source-relay>:<repo>/.relay-data/.relay-keyblobs.json       .relay-data/
scp <source-relay>:<repo>/.relay-data/.relay-usernames.json      .relay-data/
# recovery shares (0600, secret!) — without them fresh-device recovery is dead
# for every account whose share only this box held:
scp <source-relay>:<repo>/.relay-data/.relay-recovery-shares.json .relay-data/
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
