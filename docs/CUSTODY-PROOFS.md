# Paying for custody that was actually proven

Design options for the open finding in ARCHITECTURE.md → *Open security
finding: storage rewards are self-metered*. Nothing here is decided; this is
the option space, screened and then attacked.

## The problem, precisely

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
