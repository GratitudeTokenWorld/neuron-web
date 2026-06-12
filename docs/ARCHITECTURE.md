# Scaling NeuronChain to 1B+ Users — Reference Architecture Roadmap

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
features** can be re-expressed so the core scales to 1B+ users. This is a
**design roadmap only** — it will NOT be implemented in this repo. The user will
build a fresh social dApp using this as the blueprint. Success = a credible,
benchmarkable architecture where **per-node cost is bounded by the data a node
actually cares about, not by total network size.**

The single acceptance criterion everything below serves:

> **Scale invariant:** for any node, memory, storage, bandwidth, and CPU must be
> `O(own data + followed/subscribed data)` — never `O(total network)`. If any
> subsystem is `O(N)` in users, posts, files, or votes, it fails at 1B.

---

## Target topology: tiered hybrid

Pure browser-P2P at 1B is an unsolved problem; the realistic, benchmarkable path
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

**Current limits:** `allBlocks`/`accountChains`/`accounts` are global in-RAM Maps
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
  committee instead of waiting on a 1B-node broadcast.

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

**Current limits:** every node subscribes to all block synapses + global
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
push model; DHT unused for content.

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
  pin durable copies on storage super-nodes, with light clients caching opportunistically.
- **Lifecycle/GC.** TTL + reference-count GC so per-node storage stays bounded.

**Reused:** content addressing, chunking, smoke HTTP CDN, provider selection,
spot-check/receipt/repair machinery, storage-reward economics. **New:** DHT
content routing, interest-scoped announcements, quota guard, archival pinning, GC.

---

## Subsystem 5 — Identity & Sybil resistance (pluggable attestations)

**Current limits:** per-relay plaintext face DB with **no global dedup**
([relay-server.js:134,157-169]) — more relays = weaker Sybil resistance; O(n)
linear face matching; ledger Sybil check is hash-only & effectively dead
([dag-ledger.ts:181-210]); biometric uniqueness is statistically + legally
untenable at 1B.

**Target design**
- **Keep the sound crypto unchanged.** Account model (`pub` + PQ keys +
  `linkedAnchor`) and the face+PIN combined-key recovery with attempt-state
  ([account.ts:3-24](src/core/account.ts#L3),
  [face-store.ts createEncryptedKeyBlob/recoverKeysWithFace]) are excellent —
  preserve as-is.
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
  nodes and measure the scale invariant — without it, "scales to 1B" can't be
  confirmed.
- **Security:** shard takeover resistance (min super-nodes/shard), DHT eclipse
  resistance, attestation collusion bounds.

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
  GC. *Validate:* 100MB+ media works; file discovery `O(log N)`; index size
  independent of total files.
- **Phase 4 — Scale hardening.** Relay federation/directory; incentive payouts to
  super-nodes/relays; adaptive limits/compression; security bounds.
  *Validate:* sustained load test at target write rates with the invariant intact.

---

## Verification — how to confirm "scales to 1B without issues"

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

---

## What is already sound (keep, do not redesign)

- Optimistic + conflict-only DAG voting model ([vote.ts](src/core/vote.ts))
- Independent per-account chains + IDB `byAccount`/version indexes + incremental sync
- Snapshot bootstrap pipeline ([core/snapshot.ts](src/core/snapshot.ts))
- Content-addressed chunked media store + HTTP-over-WebRTC CDN ([smoke-store.ts](src/network/smoke-store.ts))
- Face+PIN combined-key recovery, attempt-state, post-quantum keys ([face-store.ts](src/core/face-store.ts), [account.ts](src/core/account.ts))
- Generalizable signed-credential quorum ([dag-block.ts](src/core/dag-block.ts), [dag-ledger.ts:477-494](src/core/dag-ledger.ts#L477))
- Storage-reward economics + spot-check/receipt repair ([storage-manager.ts](src/network/storage-manager.ts))

## Hard problems / honest open risks

- **1B pure-P2P is unsolved;** the tiered-hybrid topology is what makes it
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
- **Biometric uniqueness at 1B** hits statistical false-match limits even with
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
