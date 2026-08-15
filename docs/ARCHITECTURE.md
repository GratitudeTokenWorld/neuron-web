# Scaling NeuronChain to 10B Users — Reference Architecture Roadmap

> **Target raised 1B → 10B (decided 2026-08-09).** The design was written
> against 1B; the *Measured baseline* below projects it at 10B and it holds,
> because nothing in the architecture depends on N — every role's cost is
> bounded by its declared capacity, and demand growth is met by fleet growth.
> The keyword is **decentralized**: no role — archival super-nodes included —
> is *required* to hold everything (full mirrors stay allowed as an opt-in
> durability bonus). Where "1B" appears in historical prose below, read it as
> the era the text was written in, not the ceiling.

## Context

NeuronChain today is a **full-replication, browser-as-full-node** P2P blockchain:
every node stores all blocks/accounts/file-index in RAM + IndexedDB and receives
every write via gossip. A code-grounded audit (this session) put its realistic
ceiling in the **low thousands of concurrent users** — ~5–6 orders of magnitude
short of 1B. The current feature set is otherwise strong: an optimistic
conflict-only DAG ledger with payments, libp2p networking, a content-addressed
distributed media store, and a cryptographically sound face+PIN+post-quantum
identity/recovery layer.

**Goal of this document:** a *reference architecture* showing how the **current
features** can be re-expressed so the core scales to 10B users. Success = a
credible, benchmarkable architecture where **per-node cost is bounded by the data
a node actually cares about, not by total network size.**

The single acceptance criterion everything below serves:

> **Scale invariant:** for any node, memory, storage, bandwidth, and CPU must be
> `O(own data + followed/subscribed data)` — never `O(total network)`. If any
> subsystem is `O(N)` in users, posts, files, or votes, it fails at 10B.

> **Implementation status (this repo IS the reference implementation).** This
> document is the design; `neuron-web/src` is its realization. Phases 0–4 plus the
> end-to-end capstone are built and tested (`npm test` — 270 passing, typechecked),
> and **all 7 verification invariants below are demonstrated by tests** (including
> #7, archival, and #4/#6 by dedicated adversarial tests). What remains is purely
> transport/integration that a simulation cannot prove — live libp2p+Kademlia, a
> randomness beacon + per-validator VRF proofs, the smoke-HTTP CDN, the biometric
> attestation provider, and load tests — each behind an interface already built
> here. See [`../README.md`](../README.md) for the per-module map and measured
> results. (This doc was originally written as a roadmap for a separate build; the
> design holds verbatim, but it is now implemented in this very repo.)

---

## Target topology: tiered hybrid

Pure browser-P2P at 10B is an unsolved problem; the realistic, benchmarkable path
is three cooperating tiers. The current code already implies this split (browser
clients + relay servers) — we formalize and scale it.

| Tier | Who | Holds | Role |
|------|-----|-------|------|
| **Light clients** | Browsers / mobile | Own account chain + followed accounts + subscribed shards | Create blocks, verify via proofs, serve own media |
| **Super / indexer nodes** | Volunteer/incentivized servers | One or more full shards, DHT server-mode, snapshots, archival history | Sharded consensus, state-sync source, content index, history durability |
| **Federated relay / attestation tier** | Community operators | No global state; NAT-traversal circuits + identity attestation | Connectivity + pluggable Sybil attestations |

Decentralization is preserved by making every tier **open-membership and
redundant** (anyone can run a super-node for a shard; many relays per region),
not by forcing every participant to hold everything.

---

## Participation model & lifecycle (DECIDED — 2026-06)

This supersedes the earlier "runs entirely in the browser" framing. That goal is
**explicitly dropped**: a browser physically cannot accept inbound connections
(NAT), stay online past tab-close, or escape its storage quota, so a durable,
reachable network *always* needs some always-on component (the relay was already
that). The real goal is **decentralization, achieved through diversity of
hardware/software**, not browser-purity.

> **Decision:** Decentralization = **open membership + redundancy + no required
> party in any single role** — *not* the absence of servers. A dedicated VPS, a
> Raspberry Pi, and a browser tab are all first-class as long as (a) anyone may
> run that role, (b) several do, and (c) none is load-bearing alone.

### Security keystone — trust the math, not the machine

The invariant that makes arbitrary hardware safe to mix: **clients verify
everything cryptographically** (signatures, Merkle proofs, fraud-proof safety +
VRF committee finality). A fast server may *serve* data and a Pi may *store* it,
but neither is an *authority*: a node can be slow or withhold, it can **never
forge or override**. "Fast/reliable server tier" therefore buys *performance and
durability only* — never trust. Every new node type must preserve this.

### Capability-based roles (one machine may wear several hats)

| Role | Typical host | Holds / does | Bound by |
|------|--------------|--------------|----------|
| **Light client** | browser / mobile | own + followed data; signs/verifies; serves + caches its own content | nothing (every user) |
| **Relay** | VPS / home w/ public addr | NAT traversal + connectivity brokering; **no global state** | reachability |
| **Validator / shard node** | mini-PC / VPS / Pi | ledger shard(s); bonded; runs committee finality | RAM working-set, reliability |
| **Storage node** | Pi+SSD / server | CID blob replicas + serving, held under a liveness **lease** (not owned — see Subsystem 4); earns rewards for *proven current* custody | **declared** disk capacity, I/O |
| **Archival / super-node** | VPS / server + on-disk DB | many shards' history + snapshots + state-sync | DB, bandwidth |
| **Gateway** | VPS / serverless | HTTP rendering of content for plain-URL/open-web access | bandwidth, cache |

Capacity is **heterogeneous and self-advertised**: a node declares how many
shards/replicas it can serve *hot* (RAM-bound) vs. *archive cold* (disk-bound).
The 2 TB-SD Pi reality means **storage capacity is cheap and abundant; the binding
constraints are RAM working-set and SD random-I/O** — which forces an **on-disk
LSM store (LevelDB/RocksDB), never in-RAM JSON**, a small hot index, and
append-structured writes (USB-SSD for write-heavy roles).

### NFTs = native ownership keys (no general VM)

An NFT is a **small native object** on the block-lattice: `{ tokenId, owner,
contentRef (CID), metadata }`. Mint / transfer / burn are signed block types,
verified exactly like a payment; the actual content (a post, a page, media) is
**loaded/rendered from the storage network on demand**, not stored on-chain.
"Content-as-NFT" and "page-as-NFT" need only these native operations + an
ownership index — **not** a Turing-complete contract VM (every node executing
untrusted code is the scaling enemy and a security minefield). A constrained,
sandboxed rules layer (royalties/allowlists/editions) MAY be added later if a
concrete need forces it; a general VM is explicitly out of scope until then.

### Shareability — the gateway tier uses open web standards

Social content reachable *only* inside the P2P dApp can't be shared as a normal
link, previewed, or indexed. The **open, redundant gateway tier** renders content
(profiles, posts, page-NFTs) as standard HTML so any plain URL works on the open
web, via established standards — **not** a bespoke format:

- **Open Graph (OG)** meta tags → rich link previews on every platform.
- **oEmbed** → inline embeds in other sites/apps.
- **Schema.org / JSON-LD** → SEO + structured data.
- standard **HTTP caching** + content-addressing → CDN-friendly, immutable URLs.
- (optional, later) **ActivityPub / RSS** for fediverse + feed interop.

Gateways are accelerators, not authorities (same keystone: they serve verifiable,
content-addressed data anyone else can re-serve). Plural + open-membership so no
gateway is a chokepoint.

### Lifecycle — the "right mix" from early adoption to maturity

Every chain bootstraps centralized and decentralizes; state it honestly:

1. **Genesis:** the team runs a few super-nodes + relays (neuronweb.org today) to
   guarantee reachability + durability while load is tiny. Centralized *by
   necessity*, openly so.
2. **Growth:** per-role incentives pull in volunteer storage/relay/validator nodes;
   the team's share shrinks; redundancy targets rise.
3. **Maturity:** thousands of heterogeneous nodes; the team's are non-special and
   can vanish without impact.

To keep this honest rather than aspirational: publish **decentralization metrics**
(replicas per CID, distinct reachable relays, committee size + operator diversity
per shard) and run a **per-role incentive ramp** — an under-incentivized role is
where redundancy silently fails first.

---

## Design principles (apply everywhere)

1. **Partition, don't replicate.** Shard global state by a partition key; a node
   holds only the shards it subscribes to.
2. **Interest-based propagation.** You receive a write only if you follow the
   author or subscribe to its shard — never a global firehose.
3. **Verify without holding.** Light clients verify others' state via Merkle
   commitments / proofs instead of replicating it.
4. **DHT for discovery, gossip for your neighborhood.** Find content/peers via
   the (already-present) Kademlia DHT; gossip only inside a shard.
5. **Bounded, archival history.** Never silently destroy data (today's prune
   does); move cold history to content-addressed archival held by super-nodes,
   committed by Merkle root.

---

## Subsystem 1 — State & replication (the ledger)

**Current limits** *(as surveyed at the start of this work; counterparty
replication is now fixed — see G2 under* Scale-invariant gaps *below)***:**
`allBlocks`/`accountChains`/`accounts` are global in-RAM Maps
([dag-ledger.ts:75-77](src/core/dag-ledger.ts#L75)); `MAX_CHAIN_MEMORY=5000`
**destructively deletes** old blocks ([dag-ledger.ts:662-666](src/core/dag-ledger.ts#L662));
startup replays the whole chain.

**Target design**
- **Partition key = synapse**, generalized from 4 → a large fixed space (e.g.
  4096) via the existing `getSynapseIndex(accountPub)`
  ([libp2p-network.ts:111-126](src/network/libp2p-network.ts#L111)). A node holds
  only: its own accounts' shards + shards of accounts it follows + (super-nodes)
  assigned shards.
- **Per-account chains are the unit of sharding.** They're already independent
  append-only chains with a `byAccount` IDB index and `loadAccountChain()`
  ([libp2p-network.ts:1270](src/network/libp2p-network.ts#L1270)) — sync one
  account without touching others.
- **Light-client verification:** add a per-account **Merkle accumulator** (root
  in each block header, or a running root) so a client can verify a followed
  account's head with an `O(log n)` proof from a super-node instead of replaying
  the chain. Reuse existing block hash-chaining
  ([dag-block.ts:167-191](src/core/dag-block.ts#L167)) as the leaf basis.
- **History without data loss:** replace destructive `pruneAccountChain` with
  **archival tiering** — cold blocks move to content-addressed storage
  (Subsystem 4) held by super-nodes; the account header retains the Merkle root
  so history stays provable. Hot RAM stays bounded.
- **Bootstrap via sharded snapshots:** reuse the snapshot pipeline
  ([core/snapshot.ts](src/core/snapshot.ts) `createSnapshot/parseSnapshot`,
  `topicSnapshots`, `applySnapshot` in node.ts) but make snapshots **per-shard**,
  so a node fetches only the shards it needs.
- **Incremental, account-scoped sync:** reuse `byBlockVersion`/`byVersion`
  indexes, `loadBlocksSince`/`loadChangedAccounts`, and the version watermarks in
  `resyncFromNet` ([node.ts:568-617]); add `loadAccountChainSince(pub, ver)`
  (combine `byAccount` + version filter) so a client pulls only deltas for
  accounts it follows.

**Reused:** synapse routing, per-account chains, snapshot pipeline, incremental
sync indexes, version counters. **New:** large synapse space + selective hold,
Merkle accumulators, archival tiering, account-scoped delta sync.

---

## Subsystem 2 — Consensus & finality

**Current model (keep it — it's good):** optimistic confirmation + **conflict-only**
stake-weighted voting; voting fires only on a same-parent fork
([vote.ts:4-13,67-101](src/core/vote.ts#L4)). This is already high-throughput.

**Current limit:** conflict votes go to a **global** `topicVotes`
([libp2p-network.ts:222,1088](src/network/libp2p-network.ts#L222)) and weighing
them needs global balances. Forks, however, are strictly per-account.

**Target design**
- **Shard-local conflict resolution.** A fork on `accountPub:previousHash` only
  concerns nodes holding that account's shard. Move votes from one global topic
  to **per-shard vote topics** (`votes/{synapse}`). Only shard members vote and
  tally. This is a localization of the existing `VoteManager`, not a rewrite.
- **Shard-scoped stake.** Verify voter stake from the shard's replicated state
  (`chainHeadHash` already lets a receiver check balance —
  [vote.ts:23,220-234](src/core/vote.ts#L23)); super-nodes assigned to a shard
  form its quorum, with light clients able to submit/observe.
- **Fraud proofs for cross-shard trust.** A light client trusts a followed
  account's head because a super-node's Merkle proof + the shard quorum's
  signatures attest it; mismatches are challengeable.
- **Finality stays local & fast:** the 2/3 threshold / 10s timeout
  ([vote.ts:45-46](src/core/vote.ts#L45)) now resolves within a small shard
  committee instead of waiting on a 10B-node broadcast.

**Reused:** entire `VoteManager`, optimistic path, abstain logic, `chainHeadHash`
balance proof. **New:** per-shard vote topics, shard committee membership, Merkle
fraud proofs for cross-shard reads.

### Threat model (must be addressed before this is safe)

This is Nano-style block-lattice Open Representative Voting, but **without** Nano's
PoW anti-spam, delegated online representatives, or scarce/acquired voting weight.
Concrete weaknesses found in the current code:

- **Free-mint stake amplification.** Voting weight = balance
  ([node.ts:354,357](src/network/node.ts#L354)); every account is minted 1,000,000
  UNIT free on open ([dag-block.ts:26](src/core/dag-block.ts#L26)). N Sybil accounts
  = N×1M free voting power, so the per-relay-face-DB Sybil weakness converts directly
  into unbounded consensus weight. **Consensus security ≤ Sybil resistance, and they
  multiply.**
- **Participating-stake threshold + apathy.** 2/3 is over stake *cast in the tally*
  ([vote.ts:181-182](src/core/vote.ts#L181)), not online/total. Honest nodes have no
  reward and nothing at stake; attacker is motivated ⇒ low turnout is cheaply captured.
- **Timeout single-voter win.** On 10s timeout the highest approve-stake wins below
  2/3 ([vote.ts:185](src/core/vote.ts#L185)); suppressing honest votes for 10s
  (eclipse/partition) finalizes a fork with one vote.
- **Nothing-at-stake.** Stake is liquid, never bonded, no slashing; the same balance
  votes on many conflicts then gets spent.
- **Single-shard takeover** — sharding lets you attack one shard, not the network.
- **Grindable shard placement** — `hash(accountPub) % N` is attacker-chosen; placement
  must come from an unbiasable beacon/VRF.
- **Cross-shard accountability gap** — sender-shard resolution lets a captured shard
  defraud recipients in other shards who get no vote.

### Hardening — committed design (age-weighted personhood)

**Model: one verified human ↔ one age-weighted vote.** Capital cannot buy
dominance; consensus weight comes from *being a unique, long-committed, active
human*, not from holding more units. This is uniquely possible here because the
identity layer (one human, one account) makes per-human weighting Sybil-safe.

Voting weight per account:

> **weight = saturating_activity_age × bonded(≤ CAP)**, with **CAP = 1M = the free
> mint**. Because the cap equals the mint, the stake term is ≈ flat for committed
> validators (everyone bonds up to 1M), so **age is the real differentiator** and
> the √-concave term is largely redundant (keep it only if CAP is ever raised
> above the mint). Net effect: a capped, roughly-equal stake per human, scaled by
> seniority.

1. **Bondable free mint, capped, locked.** The 1M open mint
   ([dag-block.ts:26](src/core/dag-block.ts#L26)) **is** bondable for voting, but
   bonding is **capped at 1M/account** and **locked** while bonded — a human secures
   the network *or* spends their mint in the app economy, not both (skin in the game).
   Bonding is opt-in: non-bonders are zero-overhead light clients; bonders become the
   shard validator/rep set.
2. **Saturating, activity-based age.** The age multiplier accrues from *sustained
   participation* (validated blocks, uptime, contribution) — not wall-clock — and
   **saturates** after a bounded period. This rewards commitment, defeats sleeper /
   aged-account farming, and prevents permanent early-cohort oligarchy. Newly created
   accounts carry little weight, so onboarding bursts (honest or hostile) can't
   suddenly swing consensus.
3. **Slashing for equivocation.** Signing two conflicting votes, or voting a
   fork later proven invalid, burns the bond. Replaces "weight = liquid balance" in
   `castVote` / `voteIfConflict` ([dag-ledger.ts:784-800](src/core/dag-ledger.ts#L784),
   [node.ts:318-360](src/network/node.ts#L318)); `VoteManager` tally math is reused,
   only the weight source + slashing hooks are new.
4. **Stake-bonded rate limit (cost to fork).** Per-account write/fork budget ∝ bonded
   stake + activity; generalizes the per-peer token bucket
   ([libp2p-network.ts:395-398](src/network/libp2p-network.ts#L395)). No PoW, no
   per-post fees.
5. **Unbiasable committees + per-shard seniority floor.** Account→shard and
   shard→committee come from an epoch randomness beacon / VRF — not the grindable
   `hash(accountPub) % N` ([libp2p-network.ts:121-126](src/network/libp2p-network.ts#L121)).
   Minimum committee size **and** a minimum aggregate-seniority floor per shard so a
   shard can't be filled with only young (low-weight) validators.
6. **Recipient-witnessed cross-shard finality.** Value-transfer finality anchors on the
   recipient's receive block + recipient-shard witnessing, with an optimistic challenge
   window + fraud proofs so a victim in any shard can contest. Fits the open/send/receive
   model and closes the cross-shard accountability gap.

**Attack bar:** control a majority of age-weighted, verified-human validators *within a
shard* — i.e. many real, aged, continuously-active humans (Sybil-blocked,
farming-resistant). Capital cannot substitute (1M cap). **Corollary / critical
dependency:** consensus security now reduces *entirely* to the integrity of the
proof-of-personhood + global-dedup layer — break that and you break consensus. The
identity layer is therefore consensus-critical, not just account-gating (see Subsystem 5).
This dependency is mitigated, not just accepted — see *Defense-in-depth* below.

### Defense-in-depth: surviving the honest-human-majority dependency

Every consensus rests on an honest-majority-of-the-Sybil-resource assumption (PoW:
hashpower; PoS: stake; here: humans). The assumption cannot be *removed* — only made
hard to violate and **non-catastrophic if violated**. Three layers do that:

**Layer 1 — Strengthen the resource (humans × time).** Activity-based saturating age
means the real assumption is "honest majority of **long-term, continuously-active**
verified humans **per shard**," not merely "humans." Time + sustained activity is a
second Sybil dimension that, unlike capital, can't be bought in bulk and doesn't
reintroduce plutocracy. VRF-random committees mean capturing one shard requires ≈ a
**global** majority of that aged-active set (random-sampling argument), not a cheap
local one.

**Layer 2 — A second independent moat.**
- **Capital as an eligibility gate (not weight).** Being sampled into a committee
  requires **earned** stake (accrued from activity/rewards), not just the free mint —
  so fielding a validator needs a verified human **and** accumulated earned stake, two
  independent dimensions, while weight stays age-capped (no plutocracy). This refines
  the "free mint is bondable" choice: the free mint grants a *basic* vote, but
  committee/principal validators must also hold earned stake. *(Alternative if you want
  capital to add concave **weight** rather than gate eligibility: raise the bond cap
  above the mint and weight the surplus by √ — reintroduces a small, sub-linear wealth
  advantage.)*
- **Multi-provider attestations.** Personhood requires k-of-N **independent**
  attestation types (Subsystem 5); defeating global dedup then means defeating several
  independent systems, not one.

**Layer 3 — Containment + recoverability (a breach is bounded, not terminal).**
- **Blast-radius containment:** sharding + recipient-witnessed finality + cross-shard
  fraud proofs ⇒ a captured shard **cannot** drain other shards (recipient's shard must
  co-sign).
- **Reversibility:** long challenge windows + fraud proofs let any honest node /
  watchtower revert a fraudulent finalization after the fact.
- **Cost & evidence:** slashing burns the attacker's bonds and leaves public
  cryptographic proof — attacks are neither free nor silent.
- **Weak-subjectivity checkpoints:** honest clients accept periodic out-of-band
  checkpoints, so deep history can't be rewritten even under a temporary majority
  (neutralizes long-range attacks; a small, bounded dose of social trust).
- **Honest-minority fork (ultimate backstop):** a *provably* byzantine majority (signed
  conflicting blocks) ⇒ the honest minority forks away and the social layer follows the
  valid fork. No Sybil-resource majority can force acceptance of provably-invalid history.

**Framing:** humans × time is plausibly the **strongest** Sybil resource (hardest to
fake at scale), so the assumption is strong, not weak. Its only real liability is being
*singular* — neutralized by Layer 2's second dimension and Layer 3's graceful failure.

---

## Subsystem 3 — Networking & relays

**Current limits** *(as surveyed at the start of this work — the `accounts`
topic is now fixed, see G1 under* Scale-invariant gaps *below; the rest still stand)*
**:** every node subscribes to all block synapses + global
`votes`/`accounts`/`files` topics ([libp2p-network.ts:604-618](src/network/libp2p-network.ts#L604));
relay `maxReservations=1024` ([relay-server.js:487]); per-peer rate cap 10 msg/s
([libp2p-network.ts:397]); kadDHT present but **client-mode only and unused for
content** ([libp2p-network.ts:567]).

**Target design**
- **Interest-based subscription.** Subscribe only to: your synapses, the inbox
  topics of accounts you follow (`inbox/{pubShort}` already exists and is
  pub-sharded — [libp2p-network.ts:224]), and your assigned shards (super-nodes).
  No node ingests the global write stream.
- **Turn on the DHT.** Run super-nodes in **DHT server mode** and use
  `contentRouting.provide/findProviders` for peer, shard, and content discovery
  (currently unused) — replaces global gossip indexes with `O(log N)` lookups.
- **Relay tier that scales past 1024.** Deterministic relay assignment
  (hash(peer) → relay set) + DHT-published relay directory + many regional
  relays; the existing `PEER_RELAYS` mesh ([relay-server.js:529-550]) becomes a
  registered, discoverable federation rather than an env-var list. Reservation
  cap becomes per-relay horizontal scaling, not a global ceiling.
- **Adaptive rate limits & compression.** Raise/adapt the token bucket
  ([libp2p-network.ts:397]) by peer reputation; add gossip payload compression.
- **Bandwidth becomes follow-bounded:** a user receives `O(following)` writes,
  not `O(network)` — the core fix that makes social-scale feeds viable.

**Reused:** synapse topics, inbox sharding, peer-addr gossip, circuit relay v2,
token-bucket limiter, `PEER_RELAYS` mesh. **New:** selective subscription, DHT
server-mode + content routing, deterministic relay federation/directory.

---

## Subsystem 4 — Content & media storage

**Current limits:** global gossiped file index replicated to every node
([libp2p-network.ts:236,1479](src/network/libp2p-network.ts#L236)); 100MB uploads
crash on IDB quota ([smoke-store.ts store/cache paths]); `REDUNDANCY_TARGET=10`
push model; DHT unused for content. The provider **economy** is no longer a
limit — see *What of this is implemented* below.

**Target design**
- **DHT provider records replace the global index.** On store, call
  `contentRouting.provide(cid)`; on fetch, `findProviders(cid)` then pull. The
  `files` gossip topic becomes shard/interest-scoped (announce only to followers
  / shard), not global.
- **Keep the content-addressed CDN.** CIDs, 8MB chunking, OPFS/IDB tiering,
  manifests, Range requests, and HTTP-over-WebRTC
  ([smoke-store.ts](src/network/smoke-store.ts)) are a solid decentralized CDN —
  reuse wholesale; add cache headers + latency-ranked provider selection
  (provider `avgLatencyMs` already tracked).
- **Quota-aware, crash-proof large files.** Pre-check `navigator.storage.estimate()`
  before writes; force chunked OPFS path for large media; never write a monolithic
  >quota block to IDB (the current 100MB failure path).
- **Durable replication via super-nodes.** Keep `REDUNDANCY_TARGET`, spot-checks,
  receipts, and exponential-backoff repair
  ([storage-manager.ts:1198-1290,676-732](src/network/storage-manager.ts#L1198));
  pin durable copies on storage super-nodes, with light clients caching
  opportunistically — a cache is never counted toward `REDUNDANCY_TARGET`
  unless that node is assigned and proving possession.
- **Lifecycle/GC.** TTL + reference-count GC so per-node storage stays bounded.
- **Leased foreign replicas + rejoin cleanup (DECIDED — 2026-08-10).** See the
  next block; this is the rule that makes the storage tier *dynamic* rather
  than an ever-growing pile of stale copies.

### Durability is a FLOW property, not a stock (decided 2026-08-10)

The thing that keeps content alive is **not** a high number of copies sitting
somewhere. It is the network's ability to re-distribute the minimum replica
count, in real time, as holders disappear. Stated as the invariant to design
against:

> Content survives iff the network can restore `REDUNDANCY_TARGET` live
> replicas of any CID **faster than holders are lost**. Repair throughput ≥
> churn rate × object size. A replica count that includes offline or unproven
> holders is not a durability measurement — it is a guess.

Three consequences that the sync logic must implement, none of which fall out
of the existing push-replication code:

1. **A node holds foreign content under a LEASE, not a deed.** The lease is
   tied to liveness: miss heartbeats / spot-checks for longer than
   `MAX_OFFLINE`, and the network treats those replicas as gone and repairs
   them onto live nodes. `MAX_OFFLINE` is chosen relative to repair time — long
   enough that a brief restart is not punished, short enough that the repair
   completes before durability is actually at risk.
2. **On rejoin past `MAX_OFFLINE`, discard the held content and start fresh
   from declared capacity.** Those bytes were re-homed while the node was away;
   keeping them means holding copies of things the node is no longer assigned,
   which (a) consumes the capacity it just advertised for *current*
   assignments, (b) inflates apparent redundancy with copies nobody is counting
   on, and (c) grows without bound as a node accumulates everything it ever
   touched — the storage-tier version of the `O(N)` violation this whole
   document exists to remove. Below `MAX_OFFLINE`, a returning node keeps
   whatever it is *still assigned* (re-verified by CID) and drops the rest, so
   a quick restart costs no re-transfer.

   **Authorship is not custody, and buys no exemption.** Content a node
   publishes is *handed to the network* to distribute; the publisher does not
   retain it locally by default and is not automatically one of its replicas.
   So the lease rule applies uniformly to every byte of network content on a
   node, including bytes it authored. What a node keeps unconditionally is its
   own *ledger* state (account chain, keys, the ownership record naming the
   CID) — ownership lives on-chain, custody is a network assignment, and the
   two are deliberately decoupled. A user may still *pin* something for offline
   use, but a pin is a local convenience: it counts as a replica only while the
   node is assigned and proving possession like any other holder.

   The correctness consequence to design for: **a publish is not complete until
   the network confirms the minimum replicas.** Until then the uploader's copy
   is the only one, so it must be retained as staging and retried — otherwise
   closing the tab right after upload destroys the content. After that
   handoff the author's device may vanish permanently with no loss, which is
   the entire point of the arrangement.
3. **Only verified-live replicas count toward the target.** Repair triggers on
   the number of holders that have recently *proven* possession (the existing
   spot-check / receipt machinery), never on the number that once announced it.
   Otherwise a stale or parked copy silently substitutes for a real one, and
   the first honest failure takes the object below the threshold.

The rewards layer must follow the same rule: pay for *proven, current*
custody, so an offline node earns nothing for bytes the network has already
re-homed, and cannot park stale copies to farm storage rewards.

#### What of this is implemented (2026-08-15)

The **on-chain half** — the lease and the evidence that prices it. Four engine
block types on the provider's own account chain (`storage-register`,
`-deregister`, `-heartbeat`, `-reward`; payload in `block.storage`), with the
registry, lease liveness and reward arithmetic in the pure
`src/engine/content/provider-ledger.ts`. The **repair half** (consequences 1's
rejoin-discard, 2's publish handoff, 3's verified-live replica counting) is not
built yet — see CLAUDE.md → *Where to pick up*.

- **The heartbeat IS the lease renewal.** `MAX_OFFLINE_MS` = 3 heartbeat
  intervals = 12h: two missed renewals of slack, so a reboot or a flaky hour
  costs nothing, while a departed node stops counting within half a day. Before
  the first heartbeat the lease runs from registration. `isLive()` /
  `liveProviders()` answer every custody question; the unfiltered
  `getStorageProviders()` answers routing ones (an address worth trying is not
  the same claim as a holder worth counting).
- **Reward = f(on-chain evidence), one function.** `rewardTerms()` is used both
  to issue a reward and to validate someone else's, so the two cannot drift —
  the legacy code kept two copies in sync by comment. Capacity is priced as
  declared at **epoch start** (a bump minutes before claiming pays nothing),
  metered on bytes actually reported held, capped by that declaration, scaled by
  counted heartbeats / 6. **Holding nothing earns nothing** — declared capacity
  is self-asserted, so paying for it pays for a claim rather than for custody.
  (This originally fell back to declared capacity when no bytes were reported, a
  backward-compatibility rule inherited from the legacy ledger whose premise —
  heartbeats predating the `storedBytes` field — does not exist for a block type
  that has always carried it. Since the field is optional, the fallback paid a
  full-capacity reward to anyone who simply omitted it. Reported by Lucian,
  2026-08-15.) The projected `earningRate` shown in the UI is computed by the
  same rule, so the displayed rate cannot promise what the reward will refuse.
- **A reward bills the day before its own block, and only that day**
  (`claimableEpochDay`, enforced in `validate`). Two problems collapse into one
  rule. Pricing the *running* day paid whatever fraction had elapsed, and since
  a claim closes the epoch permanently, a provider polling every 30 min locked
  in 1/6 of what it earned. And a claim for an *old* day would find its
  heartbeat evidence pruned past `RETAIN_EPOCHS` — so the same block was valid
  on a node still holding the history and rejected by one that had pruned it,
  mid-chain, stranding everything after it. Pinning the claim to the block's own
  timestamp keeps the evidence exactly one day old, so the retention window can
  never be reached and no second constant has to be kept below it. The rule is
  decidable from the block alone: a violating block is *malformed*, not merely
  unverifiable, so every node agrees without holding any state. (Issuance must
  therefore read the clock **once** for both the claim and the timestamp — twice
  across midnight builds a block that fails its own validation.)
- **An early heartbeat is accepted and not counted; only a flood is rejected.**
  Rejecting a validly-signed, correctly-linked block mid-chain truncates it, and
  every later block then fails as non-sequential (the failure that made NFTs
  vanish on reload) — so honest jitter must never be refused. But
  accept-and-ignore alone left chain growth unbounded, free to the spammer and
  paid for by every peer holding that shard. `MAX_HEARTBEATS_PER_DAY_HARD`
  (24/epoch, 4× the honest rate) is the one mid-chain rejection in the storage
  path, set far enough above any real provider that only a padding chain reaches
  it. Uptime credit still comes only from counted renewals.
- **Two independent guards on the mint.** A `storage-reward` is the only block
  type that creates UNIT, and its chain stays single and valid — so neither
  fraud proofs nor committees ever look at it. `addBlock` enforces balance
  conservation (`balance == head.balance + amount`) *and* the evidence ceiling;
  either alone is bypassable, and both are tested adversarially.
- **Leaving releases the LEASE; it does not launder the account's history.**
  The heartbeat interval is the whole reason 6 heartbeats prove 24 hours, and it
  was held on the live provider profile — which `storage-deregister` deletes. So
  `register → heartbeat → deregister → register → …` reset the clock every
  cycle, and a provider could bank a full day's uptime in **under a minute** and
  claim the entire reward for capacity it never held (measured before the fix:
  6/6 counted heartbeats in 60 s, paying exactly what an honest day pays). Found
  by Lucian, 2026-08-15. The interval clock and the first-registration time are
  now durable per account, so deregistering costs the lease and gains nothing.
  The general shape to watch for: **any anti-abuse clock an account can reset by
  destroying its own record is not a clock.**

### Fan-IN: the invariant read from the other direction (decided 2026-08-15)

The scale invariant is usually stated as a bound on what one node must *hold*.
Lucian's point is that it is equally a bound on what one node must *answer*: a
popular provider — or a CID with ten million subscribers — must not do work
proportional to its audience. Everything below follows from that, and one of
the recommendations above did not survive it.

**The failed recommendation, kept as the worked example.** The natural way to
learn a provider's uptime is to subscribe to its shard and watch its heartbeats
arrive. It looks interest-scoped: you follow only the `k` providers holding your
content, and gossip fans out over a mesh, so the provider still publishes once.
But a **shard is a partition of accounts, not a unit of interest.** Subscribing
to one to watch a single account means ingesting every message for every account
in it — `O(N / numShards)`, which is ~2.4M accounts at the 10B target. Following
`k` providers is bounded; following `k` *shards* is not. Interest must be
addressed per-object, never per-partition.

**What replaces it.** Split the question in two, because the halves have very
different costs:

- **Liveness** (safety-critical: is this holder still there?) is already
  answered by the lease. `GET /providers` carries each provider's latest signed
  heartbeat, so freshness is directly checkable, and the answer is **identical
  for every asker** — see the caching rule below.
- **Uptime history** (a quality signal: how reliable has it been?) is the
  expensive half, and it is the one to give up on network-wide. A node scores
  the providers it actually uses from its **own** spot-checks and receipts —
  measurements that are naturally bounded by its own usage, and the only ones a
  relay cannot bias. Providers it has not used are scored on a neutral prior
  (`UNKNOWN_SCORE`), not on a number fetched from someone else.

**Principles, in the order they bite:**

1. **Identical answers absorb fan-in; per-asker work does not.** A signed,
   self-verifying response to a popular query can be cached and re-served by any
   archive, any relay, or any peer that already has it — the origin serves it
   once. This is why every archive query returns the *subject's own signature*
   rather than the responder's opinion: it makes the answer safe to copy, which
   is what makes it safe to be popular.
2. **Popularity must add serving capacity, not just load.** Anyone who fetched a
   CID can serve it. Assigned holders guarantee *durability* (they are leased and
   spot-checked); opportunistic caches provide *bandwidth* and are never counted
   toward `REDUNDANCY_TARGET`. The two roles are already separated above — this
   is the reason the separation matters. The replica target for hot content
   should rise with demand, sub-linearly.
3. **Verify lazily, on use, rather than continuously.** Continuous monitoring
   costs `O(watchers × watched)`. Discovering a dead holder when a fetch fails,
   and repairing then, costs `O(actual use)` — and content nobody reads is
   exactly the content whose holder liveness matters least to a reader (its
   durability is still the repair loop's job, driven by the lease, not by
   watchers).
4. **Aggregate at the tier that is allowed to be big, and require none of it.**
   Archives absorb fan-in by design. Because their answers are verifiable, no
   particular archive is load-bearing: any of them, or a peer holding a cached
   copy, is an equally good source. "No role is required to hold everything"
   applies to answering as much as to storing.
5. **Poll intervals must scale with population, and jitter.** A million clients
   on a fixed 10-minute timer synchronise into a thundering herd. Cadence should
   fall as observed population rises, with jitter — the same reasoning as the
   heartbeat's `±5 min` jitter, applied to queries.

**Not yet implemented.** Points 2, 3 and 5 are design constraints on the repair
loop and the publish handoff, which is where they should land — see CLAUDE.md →
*Where to pick up*. The current 10-minute provider poll is fine for a two-relay
dev network and is exactly the kind of fixed cadence point 5 says must not
survive contact with scale.

### Storage backends are pluggable and OPERATOR-CONFIGURED (decided 2026-08-10)

A storage node's disk is an implementation detail behind one small CID-native
interface (`has` / `getBlock` / `putBlock` / `used` / `available` + a possession
proof). Content is immutable and keyed by its own hash, so the interface is
deliberately *narrower* than an object-store API — none of S3's mutable-key,
versioning, ACL or multipart semantics apply, and adopting them would mean
building a more complex API to do a simpler job.

| Adapter | Who uses it | Status |
|---|---|---|
| **Filesystem** | default for any server node; the CI target | zero dependencies — the honest bottom layer |
| **OPFS / IndexedDB** | browsers | exists (`smoke-store.ts`) |
| **S3-compatible client** | an operator who wants elastic capacity (Ceph RGW, MinIO, Garage, …) | **opt-in** |
| **Read-only S3 gateway** | existing tooling reading network content by CID | later, interop only (fits the gateway tier) |

> **Constraint (Lucian, 2026-08-10): any S3 adapter or gateway is MANUALLY
> CONFIGURED by the node operator — never a default, never auto-discovered,
> never assumed to exist.** The protocol must run with every node on plain
> local disk. This is the same "no required party" rule the participation model
> states, applied to storage backends: borrowing a provider's elastic disk is
> one operator's private choice, so no provider can become load-bearing for the
> network, and an operator who attaches one is still bound by the lease rules
> above (declared capacity, proven custody, repaired around when offline).
>
> Corollary for reviewers: nothing in the core may *require* an object store to
> be present, and no default config may point at one. We do **not** implement
> an S3 server — that is commodity work with mature free implementations, and
> it competes with the lease/repair logic that is the actual novelty here.

**Reused:** content addressing, chunking, smoke HTTP CDN, provider selection,
spot-check/receipt/repair machinery, storage-reward economics. **New:** DHT
content routing, interest-scoped announcements, quota guard, archival pinning,
GC, replica leases + rejoin cleanup, pluggable operator-configured backends.

---

## Subsystem 5 — Identity & Sybil resistance (pluggable attestations)

**Current limits:** per-relay plaintext face DB with **no global dedup**
([relay-server.js:134,157-169]) — more relays = weaker Sybil resistance; O(n)
linear face matching; ledger Sybil check is hash-only & effectively dead
([dag-ledger.ts:181-210]); biometric uniqueness is statistically + legally
untenable at 10B.

**Target design**
- **Key custody is the v3 split (2026-08-15), not the old combined key.** The
  v2 "face+PIN combined key" this section once called sound was NOT: the blob
  sealed the face descriptor under the PIN alone, so the public blob + a
  ~50-minute offline brute-force of 4 digits yielded the account keys and the
  biometric (proven by running the attack; kept as the v2-control test in
  `src/core/face-match.test.ts`). v3 seals keys under
  `XOR(faceBytes, pinBytes, shareBytes)` with the 32-byte share held ONLY by
  the attester relays, nid-bound, released to a live relay-matched face under
  server-side exponential backoff (`/recovery-share/release` —
  docs/SUPERNODE.md). Design rule that must survive any future rework: **no
  combination of factors stored inside one public object can exceed the
  strength of its weakest factor** — at least one factor must live with a
  party that can refuse to release it.
- **Generalize `RelayCredential` → typed attestations.** It already signs only a
  `claimHash` ([dag-block.ts:61-68], verified at
  [dag-ledger.ts:477-494](src/core/dag-ledger.ts#L477)). Extend to
  `{ attesterPub, sig, type, claimHash }` so an open block can require a **quorum
  of heterogeneous attestations** (e.g. ≥1 personhood + ≥1 stake) — block format
  and quorum logic stay.
- **Global dedup via an on-chain identity-commitment registry.** Replace per-relay
  face DBs with a single **commitment/nullifier set** (one identity → one
  nullifier), optionally zero-knowledge so the raw biometric never leaves the
  device. Uniqueness becomes global and privacy-preserving, killing both the
  cross-relay Sybil bypass and the plaintext-biometric legal exposure.
- **Biometric becomes one optional provider** behind the attestation interface,
  alongside proof-of-personhood services, stake, and social vouching. Liveness
  challenges (blink/smile/head-move) and IP limits
  ([face-verify.ts:155-310], [relay-server.js IP limits]) remain as reusable
  anti-bot signals for the biometric provider.
- **Relay tier → attestation-provider tier:** discoverable, redundant, no global
  state, sharded by commitment range if a shared ANN index is used.

**Reused:** account/key model, face+PIN+PQ recovery, liveness, IP limiting,
credential-quorum verification. **Replace:** per-relay face DB + hash-only ledger
count → global commitment registry + pluggable attestation quorum.

### Implementation status & the single-attester SPOF (current build)

**What "nullifier" means here.** A nullifier is a per-human tag — the same human
always maps to the same nullifier — so the engine can enforce one-human-one-account
*without* storing the biometric. The attester assigns a random `nid` to a face the
first time it sees it; the per-account nullifier is `nid#index` (`FACE_MAX`=1 on
mainnet → only `nid#0`, =3 on testnet for dev). The engine derives
`commitment = hash("identity {nullifier} {accountPub}")` and keeps an append-only
**used-nullifier registry** that rejects any reuse
([`src/engine/core/identity.ts`](../src/engine/core/identity.ts),
wired in [`src/ledger/engine-ledger.ts`](../src/ledger/engine-ledger.ts) `openAccount`).
So "1 face → 1 account" = attester issues one nullifier per face **and** the engine
dedups it globally and permanently.

**This is currently a single point of failure — by design, deferred, not solved.**
The testnet runs a **single attester** (the relay). Two failure modes:
1. *Availability* — attester down ⇒ no new accounts can be created (existing accounts
   and payments are unaffected; only onboarding stalls).
2. *Trust* — the attester decides who is a unique human. A compromised/malicious
   attester can sign attestations for fake humans ⇒ mint unlimited nullifiers ⇒ break
   one-human-one-account. Because consensus is age-weighted **personhood**, breaking
   identity breaks consensus. This is the "identity is consensus-critical" risk above.

Also note `.relay-face-db.json` is a **per-relay, local** dev/operational artifact
(face → count), with **no cross-relay dedup**: run N independent relays and the same
human gets N distinct `nid`s ⇒ N nullifiers ⇒ N accounts that all pass engine dedup.
The engine only dedups a *given* nullifier.

**Planned remediation (Subsystem 5 + Subsystem 2 defense-in-depth):**
- **k-of-N quorum of independent attesters/methods.** The engine already verifies an
  attestation *quorum* (`checkQuorum` against an `identityPolicy`); raising the policy
  from 1 to k-of-N is a policy change, not a redesign — one compromised attester then
  isn't enough.
- **Federated, redundant attester tier** (discoverable, many relays) ⇒ no single
  attester required for liveness.
- **Global commitment/nullifier registry** replacing per-relay face DBs ⇒ closes the
  cross-attester gap; ideally a ZK-derived nullifier so no attester is trusted to
  assign `nid`.
- **Containment if breached anyway** (Layer 3): sharding + recipient-witnessed finality
  + slashing + fraud proofs + weak-subjectivity checkpoints bound the blast radius.

Acceptable for current single-attester testnet testing; **must** become quorum +
federation before production. This layer warrants the most adversarial testing of any
component in the system.

---

## Cross-cutting

- **Economic incentives & supply:** primary issuance is the **1M free mint per
  verified human**, plus a **small, capped inflation** that funds bonded
  validators/representatives, super-nodes, and storage providers — the existing
  storage-reward/heartbeat minting ([dag-ledger.ts storage-reward], REWARD_EPOCH)
  becomes one such reward stream rather than a contradiction. Supply ≈
  `1M × humans + bounded reward inflation`. Bonding is **capped at 1M/account and
  locked** while bonded, so securing the network has a real opportunity cost
  (locked mint) offset by reward inflation. Inflation rate is a security-budget
  parameter to tune (too high dilutes/gameable; too low under-incentivizes).
- **Observability & load-testing harness:** simulation able to spin up N virtual
  nodes and measure the scale invariant — without it, "scales to 10B" can't be
  confirmed.
- **Security:** shard takeover resistance (min super-nodes/shard), DHT eclipse
  resistance, attestation collusion bounds.

---

## Where this stands (updated 2026-08-15)

Phase status against the plan below, and what a new session should pick up.

| Phase | State | Evidence |
|---|---|---|
| 0 — Foundations | **done** | `src/engine/core` — accumulator, light-verify, identity/nullifier, attestations, partition |
| 1 — Partial replication + discovery | **done** | `src/engine/node` — delta sync, archival tiering, snapshots; live on both cloud relays |
| 2 — Sharded consensus + identity | **done** | `src/engine/consensus` (11 modules / 12 test files); 2-of-2 attester quorum exercised in TESTPLAN T1 |
| 3 — Storage CDN + tiered nodes | **STARTED 2026-08-10, parity done 2026-08-15** | backend seam: `BlockBackend` + `MemoryBackend` (engine) and a filesystem adapter (`src/storage`), `ContentStore` composes a backend with `release()`/`open()` for lease cleanup. Provider economy on-chain: four `storage-*` engine block types, `src/engine/content/provider-ledger.ts` (registry + **lease liveness** + reward evidence, 31 tests), reward minting guarded by balance conservation *and* an on-chain evidence ceiling (`src/ledger/storage-ledger.test.ts`, 16 tests), provider **discovery** by verified archive query (`provider-discovery.ts` + `GET /providers`, 17 tests), `storage-manager.ts` off the legacy `DAGLedger`. Still to do: repair loop, publish handoff, file index → DHT |
| 4 — Scale hardening | **barely started** | relay federation (`engine/net`) and capped inflation (`engine/economy`) only; no incentives, adaptive limits or load test |
| Verification (below) | **RUN 2026-08-09** | full measured baseline + 10B projection — see *Measured baseline* under Verification |
| G1 / G2 (the two live `O(N)` violations) | **CLOSED 2026-08-10** | on-demand `/resolve` + `/pending-sends` + `/block`; proof-packet claims via `/head-proof` + `/token` (payments **and** NFTs); archive-side fork detection. Deployed on both cloud relays, manual matrix green, live probe 41/41 |
| G3 (a third `O(N)` violation, found later) | **CLOSED 2026-08-15** | the global `keyblobs` topic broadcast every account's encrypted-key blob to every node — G1's shape, hidden behind a security rationale. Replaced by targeted `POST`/`GET /keyblob`. See *Scale-invariant gaps* below |
| Key custody (identity, not a numbered phase) | **REWORKED 2026-08-15** | `pinVersion=3`: keys under `XOR(face, PIN, relay-held share)`, share Shamir 2-of-n across attesters, release gated by a relay-verified action sequence under server-side backoff, custody self-heals. Replaced a scheme that was PIN-strength only. Subsystem 5 + SUPERNODE.md |

The simulation baseline has been run and extended (see *Measured baseline*
below): the engine's block layer holds the invariant exactly, and the harness
also measures the **fix designs** for G1 (DHT directory), G2 (counterparty
proof packets) and decentralized archival, plus a 10B projection from the
measured constants — so each fix shipped against a before/after number.

**Both gaps are now implemented, deployed and manually re-tested** (see
*Scale-invariant gaps* below for the per-gap change lists). The manual E2E matrix
(TESTPLAN T1–T6) passed again on 2026-08-10 through the new paths; T7 (operator
reset) is exercised routinely in dev rather than as a matrix row.

What the manual runs surfaced — all fixed, and all instructive, because each
was a *consequence* of removing an O(N) crutch rather than a bug in the new
mechanism:

| Symptom | Cause | Fix |
|---|---|---|
| Offline transfer never claimed | offline discovery had been free-riding on the O(N) accounts firehose (a recovered device learned every account, so the startup refresh pulled every chain) | `GET /pending-sends` — interest-scoped inbound discovery |
| Search returned nothing | interest-scoped views rarely hold a searched block | `GET /block` archive fallback, verified client-side |
| Recovered account froze itself | claimed before its own chain finished syncing → self-fork = double-spend evidence | `ownChainIsCurrent` interlock on every claim path |
| Transfer routed to a destroyed account | stale pre-reset record survived locally and outranked the live one | generation filter at the cache boundary + relay-first username resolution + newest-registration ranking |
| "Reset testnet" did nothing to the network | operator gate read only the same-origin relay | epoch/operator aggregation across relays + relay generation follower |

Next, in order — **Phase 3 continues** (its backend seam and provider-economy
parity have both landed; see the phase table above and CLAUDE.md → *Where to
pick up* for the full ordered list): the repair loop on top of the lease,
publish handoff, file index → DHT, and measuring repair-vs-churn in
`sim/archival.ts`. Then **Phase 4**. The migration seam (~123 app-layer type
errors; see CLAUDE.md) can be paid down alongside, per caller, as each one is
moved off the `DAGLedger` compatibility surface — `storage-manager.ts` was
moved this way and took the count from 182 to 123.

---

## Migration phases (for the new build)

Each phase is independently benchmarkable; do not advance until its invariant holds.

- **Phase 0 — Foundations.** Large synapse space + partition keys; per-account
  Merkle accumulator in block header; light-client verification protocol;
  identity-commitment registry schema; typed-attestation credential format.
  *Validate:* a light client verifies a followed account's head from a proof
  alone.
- **Phase 1 — Partial replication + discovery.** Selective shard/follow
  subscription; DHT server-mode + content routing; account-scoped delta sync;
  per-shard snapshots. *Validate:* per-node memory/bandwidth flat as simulated N
  grows 10×→100×→1000×.
- **Phase 2 — Sharded consensus + identity.** Per-shard vote topics + shard
  committees; pluggable attestation quorum; global dedup via commitments.
  *Validate:* fork resolution stays shard-local; same identity cannot mint a 2nd
  account across many attesters.
- **Phase 3 — Storage CDN + tiered nodes.** DHT provider records; interest-scoped
  file announcements; quota-guarded chunked media; super-node archival pinning +
  GC; **replica leases + rejoin cleanup**. *Validate:* 100MB+ media works; file
  discovery `O(log N)`; index size independent of total files; and the flow
  property — under continuous churn, every CID keeps `REDUNDANCY_TARGET`
  *verified-live* replicas, a node returning after `MAX_OFFLINE` drops its
  foreign bytes and refills to declared capacity, and per-node storage stays
  bounded by that declared capacity rather than by everything it ever held.
- **Phase 4 — Scale hardening.** Relay federation/directory; incentive payouts to
  super-nodes/relays — paid for **proven, current custody only**, so an offline
  node earns nothing for bytes the network has re-homed and stale parked copies
  cannot farm rewards (Subsystem 4); adaptive limits/compression; security
  bounds. *Validate:* sustained load test at target write rates with the
  invariant intact, and a storage node that goes offline stops earning within
  `MAX_OFFLINE`.

---

## Verification — how to confirm "scales to 10B without issues"

Build a **discrete-event / multi-process simulation** (virtual nodes against the
real protocol code) and assert these **scale invariants** as simulated user count
sweeps several orders of magnitude:

1. **Per-node memory** bounded by `own + followed`, flat as N grows (not `O(N)`).
2. **Per-node bandwidth** = `O(following + own write rate)`, independent of N.
3. **Discovery latency** (peer/content) `O(log N)` via DHT, not `O(N)` gossip.
4. **Conflict resolution** traffic confined to the affected shard; global topics
   carry no per-user write firehose.
5. **Storage index** per node independent of total network file count.
6. **Identity dedup** correct and global: one human → one account across all
   attesters; per-verify cost sublinear (ANN/commitment, not O(n) scan).
7. **No destructive history loss**: pruned/archived blocks remain provable via
   Merkle root.

Pass criteria: invariants 1–5 hold flat across the sweep; 6 verified by adversarial
multi-attester test; 7 verified by archival-retrieval test. Any `O(N)` curve =
not ready.

### Measured baseline (run 2026-08-09, `src/engine/sim`)

The harness was run and then **extended to cover what the original scenario was
structurally blind to**: the original `scenario.ts` routes only engine *blocks*
(no account directory → G1 invisible; no receive/counterparty path → G2
invisible). Four modules now measure each mechanism with real crypto at feasible
N, plus a projection to target scale. All are asserted in tests (`npm test`).

**1. Interest-routed blocks (`scenario.ts`) — invariants 1, 2, 4.** Per-node
cost is *exactly* the follow bound, flat across a 256× sweep
(follow=25, blocks/account=5):

| N | recv/node | store/node | KB/node | broadcast baseline | saving |
|---|---|---|---|---|---|
| 50 | 130 | 130 | 82.3 | 250 | 1.9× |
| 800 | 130 | 130 | 82.3 | 4,000 | 30.8× |
| 12,800 | 130 | 130 | 82.3 | 64,000 | 492.3× |

**2. G1 fix measured (`directory.ts`) — username directory as DHT records.**
One signed record = **328 B**; a client pays only for names it resolves (flat
16 KB for 50 names at any N), a server holds ≈ k/M of the directory, lookups
are O(log M) hops. Control: today's global `accounts` topic costs every node
the whole directory — and the *live* record is **4,889 B** (dominated by
`pqPub`/`pqKemPub`, which don't belong in a directory), re-published by every
node for every account it holds on a 20 s tick with an unconditional IDB write
per receipt. G1 is worse than "O(N) once"; it is O(N) per tick.

| N / servers | client KB | gossip baseline KB | server share | hops avg/max |
|---|---|---|---|---|
| 4,000 / 32 | 16.0 | 1,281 | 34.2% | 2.4 / 4 |
| 16,000 / 128 | 16.0 | 5,125 | 12.0% | 3.2 / 6 |
| 64,000 / 512 | 16.0 | 20,500 | 3.6% | 4.3 / 7 |

**3. G2 fix measured (`counterparty.ts`) — verify by proof, drop the chain.**
Real signed chains, real RFC-6962 proofs: the compact packet
`{open, head, open-proof, send, send-proof}` verifies a payment **and** the
sender's verified-human genesis in O(log n); tampering (wrong recipient, altered
amount, foreign block, truncated proof) is rejected.

| sender chain | full-chain pull (today) | proof packet (fix) | saving |
|---|---|---|---|
| 16 | 9.3 KB | 2.66 KB | 3.5× |
| 256 | 143.0 KB | 3.19 KB | 44.8× |
| 1,024 | 571.3 KB | 3.45 KB | 165.5× |

**4. Decentralized archival (`archival.ts`) — no required full replica.**
Each account's history gets exactly **K rendezvous-assigned holders** (HRW, same
math as the relay federation) out of an open fleet S — per-account granularity,
so there is no O(N/4096) per-shard floor. Sweeping N and S together 16×
(K=4): per-node load stays flat (≈ K·N·bytes/S), losing any node costs at most
that one holder, a joiner takes ≈ K/S of slots, and the largest node's share of
the archive shrinks 52% → 14% → 3.6%. **Full replicas remain opt-in** — an
operator may mirror everything (today's two dev relays do exactly that) as a
durability bonus, but the required redundancy is met without them, so they are
never load-bearing.

**5. Projection to 1B/10B (`projection.ts`) — from measured constants.**
Constants measured from real objects (block 569 B canonical, packet 2,993 B,
directory record 328 B), assumptions: chain length 200, follows 200, 2
posts/day, K=4, k=8, 2 TB archive nodes, 50M-record directory servers, 5,000-peer
relays, 5% concurrent:

| | 1B users | 10B users |
|---|---|---|
| Light client | 0.8 MB stored, 0.23 MB/day | **identical** (N-independent) |
| Archive total | 0.11 PB | 1.14 PB |
| Archive fleet (2 TB nodes) | 228 · share 0.44% | 2,276 · share 0.04% |
| Directory fleet | 160 · 16.4 GB each | 1,600 · share 0.06% |
| Relay fleet | 20,000 | 200,000 |
| Committee residual | 5.7 blk/s/shard | 56.5 blk/s/shard |

The decentralization law all of this encodes: **a node's cost is set by its
declared capacity, never by network size; demand growth is met by fleet growth,
so every node's share of any global dataset → 0.** The one honest O(N/shards)
residual is committee validation traffic — at 10B and 4,096 shards still only
~57 blocks/s per shard (one modest machine), but the projection asserts the
ceiling so growth past it forces the shard-count parameter up rather than
silently overloading validators.

---

## What is already sound

- Optimistic + conflict-only DAG voting model ([vote.ts](src/core/vote.ts))
- Independent per-account chains + IDB `byAccount`/version indexes + incremental sync
- Snapshot bootstrap pipeline ([core/snapshot.ts](src/core/snapshot.ts))
- Content-addressed chunked media store + HTTP-over-WebRTC CDN ([smoke-store.ts](src/network/smoke-store.ts))
- Face+PIN combined-key recovery, attempt-state, post-quantum keys ([face-store.ts](src/core/face-store.ts), [account.ts](src/core/account.ts))
- Generalizable signed-credential quorum ([dag-block.ts](src/core/dag-block.ts), [dag-ledger.ts:477-494](src/core/dag-ledger.ts#L477))
- Storage-reward economics + spot-check/receipt repair ([storage-manager.ts](src/network/storage-manager.ts))

## Scale-invariant gaps G1 + G2 — both CLOSED (and G3, found + closed later)

> **Status (2026-08-10): BOTH gaps are fully implemented, deployed and
> manually re-tested green** (TESTPLAN T1–T7 on the two-relay dev network,
> including the NFT round trip through the proof path).
> Payments **and NFTs** now claim via proof packets — no counterparty chain is
> held at all. Automated live probe: `scripts/g1-resolve-smoke.mts` (41 checks
> — run it after every relay deploy).

**G3 — the global `keyblobs` topic (found and closed 2026-08-15, with the v3
custody rework).** Same shape as G1 and missed by the G1 sweep because it hid
behind a security rationale ("gossiped for peer-independent recovery"): every
client subscribed to every account's encrypted-key blob — O(total users) per
node, re-broadcast on every create/recovery/PIN-change/face-change — and, once
the v2 crypto flaw made blobs PIN-strength, it doubled as a passive harvesting
surface for the most sensitive object in the system. Closed exactly like G1:
the topic is gone in both directions (`libp2p-network.ts`, `relay/server.ts`);
owners `POST /keyblob` to the relays they know, recovery `GET`s it on demand,
per-IP limited. Peer-held blob redundancy was not lost — it never really
existed (browsers evict IDB; the relay archive was already the tested recovery
path in T5). The recurring lesson, third time now: **"everyone should hold
this so nobody depends on anyone" always decays into "everyone holds
everything" — redundancy must be a bounded assignment (k named holders), never
a broadcast.** Phase 3's leased replication is the general mechanism; when it
lands, key blobs should become ordinary leased content with a replication
target instead of a relay-only special case.

**G1 — The global `accounts` topic is `O(N)`. CLOSED** (shipped 2026-08-09,
manually verified 2026-08-10). What shipped:
- **Clients no longer subscribe** to the global `accounts` topic
  ([`libp2p-network.ts`](../src/network/libp2p-network.ts) `start()`), and
  `publishLocalData` no longer echoes foreign records (which also kills the
  stale-anchor reversion risk outright). Owners still publish their OWN records
  on the topic (create/update/20 s tick) — O(own), invariant-clean.
- **Relays are the directory tier**: they archive engine-verified records from
  the topic (`.relay-accounts.json`) and serve them via **GET `/resolve`**
  (`?username=` or `?pub=`, plain CORS, no preflight). Forged records are
  dropped at the relay (signature check) and again at the client.
- **On-demand resolution**: `node.resolveAccount(identifier)` → local ledger →
  relay `/resolve` → signature-verify (`network/account-resolver.ts`, records
  self-sign `account:{pub}:{username}:{createdAt}:{faceMapHash}` with the
  engine key) → register + cache. Wired into the send flow, NFT transfer, token
  transfer, explorer search, the API surface (`api.send`, `api.resolveAccount`)
  and the recovery integrity check (which on a wiped device previously skipped
  silently). Create-path records are now engine-signed from the start
  (previously app-JWK-signed until the first 20 s tick re-signed them).
- Per-client directory cost is now O(contacts resolved), measured shape in
  `sim/directory.ts` (328 B record, flat per client). *At scale* the relay
  `/resolve` call is replaced by DHT `findProviders` — the call site
  (`account-resolver.ts`) is the seam; the record format doesn't change.
- **Explorer search follows the same rule.** A node's view is interest-scoped,
  so a searched TX is routinely not held locally and search returned "no
  results". `GET /block?hash=` serves it from the archive; the client verifies
  content hash + signature and renders it display-only (never applied to the
  ledger, which has no chain context for it).
- **Follow-up fix (same day): offline-transfer discovery.** The offline-claim
  path had been free-riding on the removed firehose — a recovered device
  learned every account that existed, and the startup refresh then pulled
  every chain, which is how sends made while the recipient was offline (or
  wiped) were found *by accident*. Interest-scoped replacement: relays answer
  **`GET /pending-sends?pub=`** from the engine-block archive (rows carry
  denormalized `type`+`recipient`); the client asks on startup, on recovery,
  and on a 60 s backstop, then pulls each unknown sender's chain through the
  existing verified delta path. O(own inbound); the relay's answer is a hint,
  never trusted state.

**G2 — Counterparty verification replicates whole chains. CLOSED** (payments
shipped 2026-08-09, NFTs 2026-08-10, both manually verified). What shipped:
- **Proof packets replace chain pulls for payments.** On an inbox signal or a
  `/pending-sends` hint, the recipient fetches **`GET /head-proof`** from a
  relay archive — `{open, head, send}` blocks + two RFC-6962 audit paths —
  verifies everything against the sender's own signatures
  (`engine/core/counterparty-proof.ts`, promoted from the sim harness:
  verified-human genesis, signed head, send inclusion), registers **exactly
  one block** (the send) via `EngineLedger.registerVerifiedSend`, and claims
  through the unchanged receive path. ~3.4 KB flat vs the O(chain) pull —
  the measured `sim/counterparty.ts` curve, now live. Falls back to the old
  chain pull if no relay can serve a packet.
- **The startup foreign-chain refresh burst is gone** — offline sends are
  found by `/pending-sends` (O(own inbound)), so per-node cost no longer
  grows with how many accounts ever paid this node (the merchant case).
- **Fraud safety moved with it, not weakened:** recipients no longer hold
  sender chains, so the ARCHIVE tier now notices same-height forks (height
  index in `relay/server.ts`) and gossips both blocks on the shard's conflict
  topic; every client freezes the equivocator through the existing
  self-verifying evidence path (`fraud.ts`), and the recipient subscribes to
  the sender's shard for the challenge window. Adversarial tests cover
  tampered amounts, mis-addressed claims, foreign-chain sends, truncated
  proofs, double-claims and frozen senders
  (`src/ledger/counterparty-claim.test.ts`).
- **Claim safety interlock (`ownChainIsCurrent`).** Every claim path — the
  pending-inbound check, the unclaimed sweep, the challenge-window claim, and
  the proof path — first confirms our local head is at least as fresh as the
  archive's view of *our own* chain (`headIndex` from `/pending-sends`). A
  receive built on a stale head forks the claimant's own chain, which is
  indistinguishable from a deliberate double-spend: on 2026-08-09 a
  wiped-device recovery claimed at +1.5 s, before its own chain had synced,
  and the new fork detector (correctly) froze it network-wide. When behind, the
  node resyncs and lets the 20 s/60 s backstops claim once current. If no relay
  answers at all it stays permissive — there is no archive view to be behind of,
  and blocking claims forever would deadlock an isolated dev network.
- **NFTs claim from proofs too** (2026-08-10). A transfer packet proves the
  *send* but cannot say what the token **is**: `contentRef` + metadata live in
  the `nft-mint` block on the **minter's** chain — a different account once the
  token has moved — and without it a claimed NFT renders as nothing. So an NFT
  claim verifies **two** independent proofs: the transfer packet, plus a
  **mint proof** (`GET /token?id=`) checked against the minter's own chain
  (`verifyMintProof`). The mint is fetched *before* the transfer is registered,
  so a token the node cannot describe never enters the unclaimed set. Both
  proofs share one `verifyChainInclusion` core, so neither shape can skip the
  head/inclusion check. No sender chain and no minter chain is held.
- **Two follow-ups the first live NFT round trip exposed** (both fixed the same
  day, both consequences of no longer holding counterparty chains):
  *(a)* ownership could not stay last-write-wins — replay is
  accountId-then-index, so on an A→B→A round trip B's older receive replayed
  after A's newer one and took the token back, permanently. Ownership is now
  derived from per-token **custody** (per account: the index of the latest
  block in its OWN chain touching the token, and whether that left it
  holding), which is order-independent because per-account chains are totally
  ordered. *(b)* proof-registered foreign blocks were memory-only, so a reload
  lost both the mint (token renders as nothing) and the sender's `nft-send`
  (the sender looks like the holder again). They are persisted and re-seated
  by `restoreVerifiedBlock`. Also: `nft-send` now signals the recipient's
  inbox like a payment — without it an NFT had no direct wake-up and appeared
  only on the 60 s poll or the next startup.

**Consequence to keep in mind (correct, not a bug):** node views are
*partial by design*. Before G2 a recipient kept the sender's whole chain; now it
keeps only its own chain plus the few foreign blocks a claim actually needed
(the proven send, and an NFT's mint record) — everything else was verification
input and is dropped with the proof. So each node holds a different, much
smaller slice, and the explorer is labelled "Transactions on this node" for
exactly that reason; a searched block outside the slice is fetched from an
archive (`GET /block`) and shown as such. A sender still cannot see whether the
recipient claimed a send without following the recipient's shard; a "claimed ✓"
indicator needs an inbox ack.

## Hard problems / honest open risks

- **10B pure-P2P is unsolved;** the tiered-hybrid topology is what makes it
  tractable — accept the (open-membership, redundant) super-node/relay tiers.
- **Identity is now consensus-critical (mitigated by defense-in-depth).** The capped
  age-weighted model removes the capital dimension, so consensus security reduces to
  honest human-majority — making the proof-of-personhood + global-dedup layer the most
  security-critical component. This is **addressed, not just accepted**, by the
  three-layer defense-in-depth in Subsystem 2 (humans×time resource strengthening; a
  second capital/multi-attestation moat; containment + reversibility + checkpoints +
  honest-minority fork). Residual: the personhood/dedup layer still warrants the most
  adversarial testing of any component, and Layer 3's weak-subjectivity checkpoints
  reintroduce a small, bounded dose of social trust.
- **Biometric uniqueness at 10B** hits statistical false-match limits even with
  ZK dedup — pluggable attestations hedge this; don't rely on face alone.
- **Inflation tuning & activity-age gaming.** The reward-inflation rate is a live
  security-budget knob; and "activity-based age" must be defined so participation
  can't be cheaply simulated by idle/scripted accounts (else age farming returns).
- **Identity-commitment registry** is itself global state — keep it tiny
  (nullifiers only) and shardable, or anchor it externally if it grows.
- **Super-node incentives & shard security** (takeover/eclipse) are the make-or-break
  operational risks; the bonded-stake + slashing + beacon-randomized-committee design
  addresses the economics, but the residual risks now move to: **slashing/fraud-proof
  completeness** (a missed equivocation case = free attack), **randomness-beacon
  liveness/bias** (a stalled or grindable beacon breaks committee assignment), and
  **bonding participation** (too few bonded validators per shard ⇒ small, bribable
  committees). Budget real design + adversarial-testing time for all three.
