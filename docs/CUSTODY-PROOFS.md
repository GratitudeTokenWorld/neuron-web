# Paying for custody that was actually proven

Design options for the open finding in ARCHITECTURE.md → *Open security
finding: storage rewards are self-metered*. Nothing here is decided; this is
the option space, screened and then attacked.

## Reframe (Lucian, 2026-09-21) — read this before the option table

The first pass asked "how do we prove custody on-chain?". That was the wrong
question, and the option table below inherits the error. Three corrections:

### 1. The latency budget is a hard constraint, and it is not the same as the chain's

A blockchain can grow, and 1–2 s of additional finality at billions of users is
tolerable for a transaction — nobody is watching. **Content retrieval is not
like that.** People abandon an image at three seconds. So for the storage
subsystem, security cannot be bought with latency: any mechanism that puts work
on the read path is disqualified before its security is even discussed.

This is not "performance outranks security here". Security still gates
(PRINCIPLES.md → 4). It is that **the security must be achieved INSIDE a
latency budget the chain cannot meet** — which is what makes it, in Lucian's
words, a problem needing "a very new approach" rather than a smaller version of
the consensus one.

### 2. Ask what to REMOVE, not what to add

When stuck, the move is to delete the problematic thing and replace it with
something better suited to decentralisation and scale. Applied here, the
problematic thing is not the absence of a proof — it is the **presence of
storage accounting on the ledger**.

Measured (`sim/storage-accounting.ts`, run in the unit suite):

| | Blocks per provider |
|---|---|
| Storage accounting, per YEAR (6 heartbeats + 1 reward per daily epoch) | **2,555** |
| Over a decade | **25,550** |
| What `projection.ts` budgets for an account's ENTIRE LIFE | **200** |

A provider exceeds the 10B projection's whole-life assumption in **29 days**,
and overshoots it **128×** over a decade. Worse than the size is the shape:
these blocks accrue with the **clock**, not with anything a user did. An idle
provider — nothing stored, nothing served, nobody reading — writes exactly as
many as a busy one. That is the sustained half of the invariant
(ARCHITECTURE.md → *The invariant has two dimensions*) failing inside the
ledger, and no cadence change fixes it: halving the heartbeat rate halves a
number that is still unbounded in time.

**So: remove storage blocks from the chain.** Liveness and payment do not
belong in consensus. Settlement does, and settlement is exactly what a chain is
good at — batched, infrequent, and nobody waiting on it. Measured at a monthly
settlement cadence: 120 blocks per provider per decade, inside the projection's
budget, and **zero when the network is quiet**.

### 3. What the decentralisation leg actually optimises for here

Not "no required party" in the abstract — **flexibility, and the speed at which
the network adapts** to a storage substrate that is always growing and always
volatile, so that redundancy is restored in real time. Cleaning up cache and
content is **secondary**.

That has a sharp, immediate consequence for something already built: a
returning node currently **discards every foreign byte** once its lease lapsed
(`custody.ts` → `planRejoin`). Under this priority that is backwards — it
destroys redundancy the network spent bandwidth creating, in order to tidy up.
Over-replication is cheap and safe; under-replication is the risk. The rejoin
rule should keep the bytes and let them serve, discarding only under real space
pressure. **Open decision** — it reverses a rule that shipped, so it is
Lucian's call, but the current behaviour contradicts the stated priority.

### The design this points at: let the DATA PATH be the proof

Combining the three corrections gives something the option table below never
considered, because it was still thinking in proofs:

- **Hot content proves itself, for free.** A provider that answers reads is
  demonstrably holding and serving; one that does not, is not. The bytes are
  content-addressed, so the reader verifies them anyway — *a successful
  retrieval is already a proof of custody*, costing zero extra latency, zero
  crypto and zero chain. This is the same "verify on USE, not by watching"
  rule that already drives repair.
- **Cold content is the only case needing a constructed proof** — and cold
  content is, by definition, **not latency-sensitive**. So the expensive
  mechanism runs exactly where its cost does not matter. That asymmetry is the
  whole trick: the fast path never pays for the slow path's guarantees.
- **Payment is a side effect of the data path**, not a separate accounting
  system: readers sign micro-receipts for bytes actually served, aggregated
  off-chain and settled on-chain rarely.

Hypotheses this design makes, and how to falsify each (PRINCIPLES.md → 5):

| Hypothesis | Disproved by |
|---|---|
| H1. Most bytes are served often enough that reads alone keep custody evidence fresh | A read-frequency distribution where a large share of stored bytes go unread for longer than the redundancy-repair window |
| H2. Removing accounting blocks leaves chain growth proportional to settlements, not time | A design where settlement frequency itself scales with time or provider count |
| H3. Proof-on-cold costs less than proof-on-everything by the hot/cold ratio | Measuring the ratio and finding cold content dominates |
| H4. Keeping bytes on rejoin improves durability more than the space it wastes | A churn simulation where retained stale replicas crowd out live ones under capacity pressure |

**H4 has now been run** (`sim/repair.ts`, 2026-09-21) and the answer is
conditional, which is more useful than a yes. Keeping bytes is durability-
neutral-to-positive **only because spares are evictable**: the first attempt
kept them without modelling eviction and the churn scenarios failed outright —
retained spares filled the fleet and repair had nowhere to place. With
`planEviction` sacrificing spares before leased copies, the same fleet under
the same churn holds exactly `REDUNDANCY_TARGET` and loses nothing.

Two things that falls out of it:

- **Keeping is safe *because* spares are evictable, not because storage is
  free.** Remove the eviction and the sim fails again. That is the honest
  statement of the trade.
- **Retained spares do not inflate the counted redundancy**, which was the
  original worry behind discarding. The lease already stopped counting them at
  the moment it lapsed, so the mean lands exactly on target while the bytes
  survive and keep serving.

H1 and H3 are measurable in `sim/` today with a read-distribution model; H4 is
a variant of the existing `sim/repair.ts` churn harness. **None have been run.**
Stating them unrun is the point — the design is a hypothesis, not a result.

---

## Paying per read and per write — and then not paying at all (2026-09-21)

Lucian's proposal: **remove heartbeat payment entirely and pay for successful
reads and writes instead, especially reads.** Keep a balance for those two
statistics the way a coin balance is kept; on each successful retrieval, signal
size, time taken and anything else relevant; compress the values; and store them
somewhere the update **replaces** the value rather than appending a block.

The instinct is right, and the "replace, don't append" requirement is the load-
bearing part of it. Worked through, it splits into three findings.

### 1. "Replace, don't append" has a name: a monotone counter per pair

The mechanism that makes an update a real update is a **monotone counter
receipt per (reader, provider) pair**. Receipt *N* supersedes *N−1*, so a
thousand reads between the same two parties collapse to **one** stored receipt:
the newest. State becomes `O(distinct counterparties)` instead of
`O(interactions)`, and settlement collapses it again — many receipts into one
on-chain transfer. That is why it can beat an ordinary token transaction: it is
an aggregation layer, and its compression ratio is reads ÷ settlements. Nothing
appends; the newest signed counter simply overwrites the previous one, and an
old receipt is not evidence of anything because a higher one exists.

`sim/storage-accounting.ts` already measured the settlement half: 120 blocks per
provider per decade at a monthly cadence, versus 25,550 for the heartbeat
design, and **zero when the network is quiet**.

### 2. Who pays decides whether it is attackable — and one field must never meter payment

Black-hat pass on the receipt design:

- **If the network MINTS per read**, a reader and a provider collude to
  fabricate reads and it is free money. This is unfixable by any receipt
  scheme, because every receipt in the fraud is honestly signed by a real
  identity over a real counter. The signature is not the weak part; the
  *funding* is.
- **If the PUBLISHER pays** for distribution of their own content — the way a
  site pays for bandwidth — collusion becomes self-dealing: you pay yourself
  and lose the fee. Readers still read for free, so Principle 1's access
  commitment is untouched.
- **"Time it took to retrieve" is self-reported and unverifiable.** It may
  inform routing and local reputation, where gaming it buys you more traffic
  and therefore costs you bandwidth. It must never meter a payout
  (SCREENING.md → 11 is the same defect, already open).

### 3. The stronger move is to remove the payment as well — measured

Applying "what can be REMOVED" one step further: delete the money, and throttle
reads and writes against a **pairwise, locally-metered reciprocity budget** that
rises with demonstrated good behaviour. Serving a peer earns credit *with that
peer and nobody else*; spending credit is how you get served.

Screened security-first (PRINCIPLES.md → 4), this is not a cheaper payment, it
is a smaller attack surface:

- **Nothing mintable, so nothing to steal.** SCREENING.md → 11 (rewards metered
  by self-report) *disappears* rather than being patched: a lie about bytes held
  buys credit only in the liar's own books.
- **Credit is local and non-transferable, so collusion buys nothing.** Two nodes
  inflating each other change no third node's budget. The attack that defeats
  every receipt design is structurally absent instead of defended against — and
  the mirror image holds too: nobody can *lower* a competitor's standing with
  anyone else, so there is no reputation-poisoning attack either.
- **Observation replaces testimony.** A budget rises because of transfers the
  node performed itself, verified by content-address before credit is granted.
  No claim to forge, because no claim is made.

Measured in `sim/reciprocity.ts` (H-P2, falsifier: free-riders obtaining what
contributors get, or a newcomer starving). Contributors are served **~8× better
than free-riders**, an honest newcomer joining with no history overtakes a
free-rider within the run, and the floor holds. Three failure modes were found
by *running* it, and each is kept as a control:

| Variant | Contributor | Free-rider | Why it fails |
|---|---|---|---|
| **Design** (mutual, sticky, per-server floor) | 0.42 | 0.05 | — |
| Free floor granted **per stranger** | 0.65 | 0.54 | A subsidy keyed by something the attacker picks: spread requests thin and free-riding is free |
| **Uniform** partner selection | 0.21 | 0.01 | Credit never accumulates if you never meet the same peer twice — the *ratio* looks superb while everyone starves |
| Relationships **one-directional** | 0.19 | 0.03 | Earning credit where you never spend it |

Two design requirements fall out, and neither was obvious beforehand:

- **Partner selection must be sticky.** The uniform case is the one that looks
  healthiest by ratio and is second-worst by service — the identical trap as
  repair-vs-churn, where a collapsed network reads as a fine ratio. Judge the
  stock, never the ratio.
- **Custody assignments should be PAIRED.** Reciprocity needs demand in both
  directions; a provider serving readers who have nothing it wants is exactly
  why storage markets normally reach for money. Pairing makes storage payable in
  storage. This is a concrete, testable change to how holders are assigned.

**The conflict, stated out loud as Principle 4 requires:** reciprocity is
exclusionary by nature and Principle 1 is about ACCESS. A sensor or a phone has
little to give back. The `newPeerPrior` floor — an unconditional per-server
allowance every peer gets before it has done anything — is where the principle
lives, and `freeridersKeepTheFloor` is the test that the mechanism has not eaten
it. The floor must be a **per-server budget shared among strangers**, never a
per-stranger grant; the table above is what the per-stranger form costs.

**Residual attacks, honestly ranked:**

1. **Whitewashing.** A free-rider whose credit decays simply makes a new
   identity and resets to the floor. The defence is the nullifier: a new
   identity costs a human. This is one-human-one-account doing load-bearing
   economic work, not just consensus work.
2. **Sybil floor-farming.** The floor is a subsidy, so `identities × servers ×
   newPeerPrior` is free service per round. It must stay small enough that a
   Sybil fleet's aggregate is affordable — the floor is a security parameter,
   not a generosity setting.
3. **Eclipse via the working set.** Sticky partners are what make credit work
   and also what an attacker wants to fill. Working sets must stay diverse and
   partly refreshed; no peer may become a sole source.

**Recommendation: remove payment for now**, as Lucian suggested, and build the
throttle. It is strictly less attack surface than any payment design, it removes
2,555 blocks/provider/year, and it can be replaced by the receipt design later
if reciprocity proves insufficient — whereas a minted currency is very hard to
take back. What is NOT yet measured: whether reciprocity holds when demand is
genuinely one-sided at scale (H-P3, unrun) and the read-frequency distribution
behind H1/H3 above.

---

## The problem, precisely (as originally framed)

> Superseded by the reframe above, which rejects the premise that this belongs
> on-chain at all. Kept because the option table is still the honest map of
> what was considered, and because the attacks below apply to any design.

Pay a provider for **bytes held, over an epoch**, where:

- the provider chooses what to tell us (`storedBytes` rides in its own
  heartbeat, `capacityAtStart` is self-declared), and
- the verification is currently circular — `validate` checks the claim against
  `rewardTerms`, derived from the same self-report.

A solution must produce evidence that is **cheap to generate on a weak device**
(Principle 1c: IoT, single-board computers), **cheap to verify**, **bounded per
node** (the scale invariant, both dimensions), and **not forgeable by
collusion** between a provider and any single other party.

## What we already have, for free

These change which options are expensive:

| Primitive | Where | Why it matters here |
|---|---|---|
| Content addressing | `content/cid.ts` | A challenger can check a returned chunk against its CID **while holding none of the data**. Verification needs no trusted reference copy. |
| Per-chunk manifests | `content/chunking.ts` | Content is already split into chunks, each with its own CID in a signed manifest. "Produce chunk *i*" is already a well-defined, verifiable question. |
| Unpredictable beacon | `consensus/seed.ts` → `deriveNextSeed` | A per-epoch value nobody can predict in advance. Challenges can be *derived* rather than *issued*. |
| ECVRF + sortition | `consensus/vrf.ts`, `sortition.ts` | Unpredictable, verifiable selection of who does a job. |
| Slashing + fraud proofs | `consensus/slashing.ts`, `fraud.ts` | Equivocation already freezes an account permanently. Punishment machinery exists. |
| Spot checks + receipts | `network/storage-manager.ts` | Providers are already challenged and uploaders already confirm — but **none of it reaches the reward path**. |

The first three together are the important discovery: **we can ask an
unforgeable question and check the answer without anyone holding a reference
copy**. That removes the need for the expensive machinery other networks use.

---

## The options

### A. Evidence-based

**A1 — Uploader receipts as the meter.** Pay only for CIDs whose uploader
signed a receipt. *Mostly exists* (`confirmedProviders`).

**A2 — Interactive peer spot-checks, made consensus-visible.** Peers challenge
providers (already happening); the results become on-chain evidence.

**A3 — VRF-selected challengers.** Each epoch, sortition picks who audits whom;
the auditor publishes a signed verdict.

**A4 — Beacon-derived self-proofs ("prove you still have it").** Each epoch,
the provider derives challenge offsets from `deriveNextSeed` + its own id + the
CID, reads those chunks, and publishes a proof: the chunk hashes plus their
manifest paths. Anyone can verify against the manifest. No challenger exists to
collude with, because nobody issues the challenge.

**A5 — PoRep/PoSt with sealing (Filecoin-style).** Cryptographically binds a
*physical* replica; defeats deduplication and outsourcing.

**A6 — Proofs of retrievability over erasure-coded data.** Sampling guarantees
recoverability with high probability.

### B. Economic realignment

**B1 — The uploader pays, the network does not mint.** Storage becomes a
market: the party who wants the data safe pays for it.

**B2 — Bonded capacity.** Declaring capacity requires a stake, slashed on a
failed proof.

**B3 — Pay for bandwidth served, not bytes held.** Readers sign receipts.

### C. Optimistic

**C1 — Pay optimistically, slash on a proven failure.** Keep the cheap path;
anyone may challenge, and a failed challenge claws back and slashes.

### D. Null

**D1 — Do not pay for storage at all.** Remove the incentive and the attack
surface with it.

---

## Trinity screen (security → performance → decentralisation)

| | Security | Performance | Decentralisation | Verdict |
|---|---|---|---|---|
| **A1** receipts | ✗ Collusion: an uploader and provider attest each other; nothing is transferred | ✓ free | ✓ | **Rejected at step 1** — it is self-reporting with two signatures instead of one |
| **A2** peer checks on-chain | ~ Depends entirely on *who* checks; self-selected checkers collude | ~ O(checks) gossip | ✓ | Only viable with A3's selection |
| **A3** VRF challengers | ✓ Challenger unpredictable | ~ Interactive: both parties must be online in the window | ~ Penalises intermittent nodes — a phone or an IoT sensor is offline when its audit lands | Viable, but fights Principle 1c |
| **A4** beacon self-proofs | ✓ Nobody issues the challenge, so nobody can be bribed; unpredictable until the epoch opens | ✓ Read k chunks + hash; verify is O(k·log n) with no reference copy | ✓ Works offline-ish: the provider proves on its own schedule within the epoch | **Strongest candidate** |
| **A5** sealing/SNARKs | ✓✓ Also defeats dedup and outsourcing | ✗ Sealing costs hours of CPU and GBs of RAM | ✗ Excludes phones, browsers, SBCs — kills Principle 1c and 3c outright | **Rejected at step 3**, and would have failed step 2 |
| **A6** PoR + erasure coding | ✓ Strong recoverability | ~ Encoding cost on upload; more bytes stored | ~ Fine | Complementary to A4, not a substitute |
| **B1** uploader pays | ✓✓ Collusion becomes **economically null** — a self-dealer pays themselves and loses the fee | ✓ No new proofs needed for the anti-theft property | ~ Unfunds public-good and long-tail content; introduces "who pays for the commons?" | **Strong, and orthogonal** — combine, don't choose |
| **B2** bonded capacity | ✓ Real cost to lying | ✓ | ✗ A bond is a wealth gate on participation — Principle 1a | Rejected unless the bond is nominal |
| **B3** pay for bandwidth | ~ Collusion via fake reads | ✓ | ✗ Cold content earns nothing, so unread data is unfunded — breaks durability-as-flow | Rejected as the primary meter |
| **C1** optimistic + slash | ✓ *if* a challenge is cheap and a punishment exists | ✓✓ Cheapest common path | ✓ | **Strong, and orthogonal** — the enforcement layer for A4 |
| **D1** pay nothing | ✓✓ No incentive to fake | ✓✓ | ~ Durability rests on altruism | The honest baseline. If no option beats it on security *and* keeps supply, take it |

**Shortlist: A4 + C1, with B1 as the economic frame.** They are not
alternatives: A4 is the evidence, C1 is the enforcement, B1 removes the motive.

---

## Black-hat pass on the shortlist

Attacker's goal throughout: **be paid for bytes I do not hold.**

### Attack 1 — Outsourcing (the "generation" attack)

Do not store. When the epoch's challenge lands, fetch the needed chunks from a
real holder, answer, discard. **This defeats A4 as stated.**

Mitigations, none complete: sample enough chunks that fetching approaches
fetching the whole object; require the proof early in the epoch with a tight
deadline; make the beacon unpredictable so nothing can be prefetched. The
honest ceiling: **A4 proves retrievability, not physical storage.** Only sealing
(A5) proves the latter, and A5 is rejected on Principle 1c. So the system pays
for *the ability to produce the bytes on demand*, which is arguably the property
users actually want — but it must be **documented as that**, not described as
proof of storage.

### Attack 2 — Deduplication across identities

Hold one physical copy; register N provider identities claiming it; collect N
rewards. Each identity passes every challenge honestly. Partially blunted by
one-human-one-account and the existing device binding, but a determined
attacker has N humans or N devices. **Open.** The honest framing: the network
pays for *replica count as claimed by distinct identities*, and distinct
identities are exactly what the identity layer is for — so this reduces to the
Sybil problem, where it belongs, rather than being a storage problem.

### Attack 3 — Collusion with an uploader

Upload junk, store it "for" a friend, both earn. A4 does not care — the bytes
are real and really held. **B1 is the answer, and the only one**: if the
uploader pays rather than the network minting, the colluding pair pays itself
and loses the transaction fee. Under minting, this attack is unpatchable by any
proof system, because every proof is *passing honestly*.

### Attack 4 — Beacon grinding

Influence `deriveNextSeed` so the challenge falls on chunks you kept. Requires
influence over the VRF betas that feed the seed — i.e. it is the existing
consensus-grinding question, not a new one. Mitigation belongs in `seed.ts`,
and the exposure scales with how much of the committee an attacker controls.

### Attack 5 — Challenge-response as an amplifier

If anyone may challenge a provider and the provider must answer, a stranger can
make a node do unbounded work. **This is the mistake already made twice in this
codebase** (both limiter leaks). Any A4/C1 design must rate-limit challenges
per challenger and per target, and the proof must be *published*, not served
on demand — publication is O(1) per epoch, answering is O(challengers).

### Attack 6 — Slashing as a weapon (C1)

If a failed challenge slashes, make an honest provider "fail": eclipse it,
withhold the beacon, or spam it offline during its proof window. Equivocation
freezing is already permanent and already noted as a weapon if you can induce a
fork. Any slashing here needs a wide proof window, tolerance for a missed
epoch, and punishment proportional to a *pattern*, never one miss.

---

## Where that leaves it

A defensible design is **A4 + C1 under B1**:

- **A4** gives unforgeable, offline-friendly evidence with no challenger to
  bribe, reusing the beacon and manifests that already exist.
- **C1** keeps the common path cheap and punishes patterns of failure.
- **B1** makes the one attack no proof can stop (collusion) economically
  pointless.

It is not free of holes, and the honest statement of what it buys is: *paid for
demonstrated retrievability by a distinct identity, not for physical storage.*

**Questions for Lucian, in the order they block work:**

1. **Minting or market?** If the network keeps minting for storage, collusion
   is unfixable by any proof. Is B1 (uploader pays) acceptable, and if so what
   funds long-tail content nobody is paying to keep?
2. **What does a missed proof cost?** Nothing, a lost epoch, or a slash? The
   answer sets how weaponisable it is.
3. **Is "retrievability, not storage" good enough?** Accepting it keeps IoT and
   phones as providers. Rejecting it means A5, which excludes them.
