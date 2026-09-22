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

### 2b. BUILT 2026-09-22 — `engine/content/read-receipts.ts`

Lucian's decision: **do not remove payment; improve it.** So the receipt design
above is now implemented, and the heartbeat keeps its other job.

**The change in one line: the heartbeat stops being the payment meter and stays
the lease.** Two jobs were conflated. "Is this provider still holding the
bytes?" is custody, and the heartbeat still answers it. "Did it actually serve
anyone?" is service, and only readers can answer that. Separating them is the
minimum change that removes the circular verification, and it costs the custody
model nothing.

What is metered now:

| | Old | New |
|---|---|---|
| Who reports volume | the provider being paid | the readers it served |
| Verification | claim checked against terms derived from the same claim | claim not made by the payee at all |
| State per provider | grows with the clock | `O(distinct counterparties)` |
| Chain writes | 2,555 blocks/year, idle or busy | one settlement, **zero when quiet** |

Measured in `read-receipts.test.ts`: 100,000 reads across 200 readers are held
as **200 records** and settle as **one** on-chain event — two collapses, 500×
then 200×. An idle provider writes nothing at all, which is the property no
heartbeat cadence can have.

Four defences, and the fourth is the honest one:

1. **Self-attestation is refused outright** — `reader === provider` is rejected
   before anything else.
2. **A per-reader cap.** One counterparty is worth at most `PER_READER_EPOCH_CAP_BYTES`
   however much it claims, so a friendly reader cannot mint a fortune.
3. **A distinct-reader floor** (3, matching `MIN_DISTINCT_PROBERS`). A provider
   whose whole income comes from one reader has a testimonial, not an
   observation, and is paid nothing.
4. **Collusion is priced, not prevented.** `collusionCeilingBytes` states it as
   a function: earnings scale linearly with the number of identities an attacker
   controls, and each identity costs a nullifier — a human. That is the only
   shape this project has ever been able to defend, and pretending otherwise
   would be the overstatement the black-hat skill warns about.

Monotonicity does the anti-replay work with no history stored: the counter must
advance, and neither cumulative total may shrink — otherwise a reader could
attest a large figure, let it settle, then rebuild the same bytes for a second
payment. Settlement moves each pair's baseline to its current total, so the same
bytes can never be claimed twice.

**`lastLatencyMs` is carried and never paid on.** Lucian asked for retrieval
time to be signalled and it is useful — for routing and local reputation, where
gaming it buys more traffic and therefore costs bandwidth. It is reader-reported
and unverifiable, so it must not meter a payout, and a test asserts that a
provider claiming 1 ms and one claiming 99,999 ms earn identically.

**Still open, and it is the part no code can settle:** who funds the payment. If
the network mints per read, a reader and provider collude for free money and no
receipt scheme can fix it, because every receipt in that fraud is honestly
signed. If the **publisher pays** for distribution of their own content,
collusion becomes self-dealing. This module meters what is OWED and never mints,
so the funding decision is still Lucian's to make.

### 2c. Black-hat pass on "remove the heartbeat, pay per read" (2026-09-22)

Lucian's proposal: drop the heartbeat entirely, prove custody by successful
reads, set earnings by read/write volume and size, penalise failures inside
declared capacity, and let users claim manually (>=24 h apart) or automatically
every 30 days, minted on chain.

Attacked before implementing, per the black-hat skill. **Three of the five
parts survive; two must change.**

#### B1 - CORRECTED: this attacked a rule Lucian did not propose.

The first pass modelled earnings from reads and **nothing for holding**. The
proposal is a **"replicas + reads" score**, which already contains the replica
term, and that is the hybrid row below scoring 100%. The objection does not
apply to the design.

Two things it got wrong, worth keeping so they are not repeated:

- It was framed as a black-hat finding and it is not one. **Nobody is
  cheating.** Content is hash-addressed, so a provider cannot fake a response:
  wrong bytes fail the CID check and right bytes require having them. Lucian's
  reasoning there is correct and is the foundation of everything below.
- Filed under "attack", an incentive result reads as an accusation. It is a
  statement about what rational honest providers keep when space is finite.

What survives is a **guardrail**, not a criticism: the numbers below show why
the replica term must stay in the score. Drop it and the tail dies — not to
fraud, but to arithmetic.

#### B1a - Why the replica term cannot be dropped later (the guardrail)

The attacker here is not even malicious: it is a **rational provider**. Reads
for an object are split among its replicas, so marginal earnings equalise at
`replicas proportional to read rate`. Over a Zipf catalogue that is
catastrophic (`sim/incentive-coverage.ts`, same fleet and workload, only the
payment rule changed):

| Payment rule | Objects at full durability | Median replicas | Hottest object |
|---|---|---|---|
| Service only (pay per read) | **12.4%** | 2.5 | 124,068 replicas |
| Custody + service | **100%** | 10.8 | 41,366 replicas |

At merely-adequate capacity, service-only pay puts **17% of the catalogue below
a single replica** - not under-replicated, deleted. Meanwhile the hottest object
attracts six figures of voluntary copies, because nothing bounds what providers
*chase* even though `replicaTarget` bounds what the network *assigns*.

"Custody is proven by reads" is true only for content someone reads. For the
rest there is no signal at all, and a provider can delete every cold byte while
looking perfectly healthy on the hot ones.

#### B2 - CORRECTED and SOLVED: sampling, not exhaustive checking.

The 833x figure assumed "proof by read" meant reading **every** object. It does
not. Reading a random **few** per provider per round gives the same assurance at
`O(providers)` — `engine/content/custody-sampling.ts`.

A provider claiming `n` objects is challenged on `k` of them, chosen from a seed
it cannot pick (the consensus VRF, which is publicly verifiable so the selection
is auditable). Holding only fraction `f`, it survives with probability `f^k`.

| Actually holds | k=5, one round | k=5 over 6 rounds | k=5 over 24 rounds |
|---|---|---|---|
| 50% | 96.9% caught | ~100% | ~100% |
| 90% | 41.0% | **95.8%** | ~100% |
| 99% | 4.9% | 26.0% | **70.1%** |

One round is deliberately weak; **detection compounds**, because the provider
must survive every round for the life of the lease. Cost at 10,000 providers
holding 5,000 objects each: **50,000 challenges against 50,000,000** — 1,000x
cheaper, and identical whether a provider holds 100 objects or 100,000.

And these challenges *are* successful reads, exactly as Lucian specified. The
only addition is that some of them are issued by auditors rather than users, so
that content nobody reads still has a signal.

**The honest framing: this is priced, not proven.** Cryptography cannot stop a
provider deleting bytes. `cheatingExpectedValue` makes the trade explicit — with
a penalty worth more than the storage saved, cheating is negative-value at every
level tested; make the penalty small enough and it flips. The penalty size is
the real security parameter.

#### B2-old - The superseded figure

If nobody reads it, somebody must issue synthetic reads. That is per **object**;
a heartbeat is per **provider**. At 10,000 providers holding 5,000 objects each:
60,000 beacons per window against 50,000,000 spot checks. Removing the heartbeat
makes proving custody *more* expensive, not less.

#### B3 - The fix: un-chain the heartbeat, do not delete it.

The measured objection was never liveness. It was that a heartbeat is a
**BLOCK** - 2,555 per provider per year, accruing with the clock and nothing
else. That is a property of putting it on the chain. **An off-chain gossiped
beacon gives identical liveness at identical message cost and zero chain
growth**, which satisfies the invariant's sustained dimension and keeps the
cold-content signal Lucian's version loses.

So: heartbeat stays as an off-chain **lease**, receipts meter **service**, and
earnings carry a custody component so the tail survives.

#### B4 - Penalising failures hands every reader a weapon. Do not build it.

The asymmetry is fatal. A false *success* costs the attacker its per-reader cap.
A false *failure* costs the **victim** its entire income, for free. A single
malicious reader could delete any provider's earnings by reporting failures
nobody can check, and "the read failed" is unverifiable by construction - it is
the absence of an event.

Worse, honest declaration becomes a liability: flood a provider to the capacity
it truthfully declared, and genuine reads fail inside it. The better it measures
itself (`calibration.ts`), the cheaper it is to grief.

**Penalise by NON-PAYMENT only.** A provider that fails reads earns less
automatically, because fewer successes get attested. That is self-limiting,
needs no failure attestation, and cannot be aimed at anyone.

#### B5 - Minting is the hole, and the fix already exists in the tree.

`economy/rewards.ts` already caps emission at `inflationPpm` of supply and
**splits it proportionally by contribution weight**. The storage path ignores
it: `rewardTerms` mints an absolute `BASE_STORAGE_RATE_MILLI x GB x uptime`.

Routing storage pay through the capped pool changes the attack's character
completely: wash-reading stops **minting** value and starts **diluting** honest
providers' share. Unbounded theft becomes a share contest, and a share contest
is winnable by making shares expensive to fake. This is the single highest-value
change available and it is mostly deletion.

Claim mechanics are otherwise sound: cumulative baselines make double-claiming
impossible, and a 24 h floor is a bounded per-account rate limit. One fix - a
30-day automatic claim for everyone is a synchronised herd and a predictable
settlement spike. Jitter it, as `pollIntervalMs` does elsewhere.

#### B1b - The custody term is BYTES HELD, not replica count (Lucian, 2026-09-22)

Refinement, and it is the right one. A replica count is a **network** property:
how many copies of an object exist. A provider neither knows nor controls it.
What a provider has is **bytes**, and what it did is **reads served**. So:

```
weight = custodyRate x verifiedBytesHeld  +  serviceRate x bytesServed
```

Three consequences:

- **Per-byte is the fair measure.** Paying per *object* would reward holding
  many tiny files; per byte, a small file earns proportionally less and costs
  proportionally less space, so the provider is indifferent to file size and
  simply fills its disk. (Small residual: per-object overheads — manifest,
  tracking, challenge participation — are not per-byte, so very small files are
  marginally unattractive. Worth watching, not worth a rule yet.)
- **The coverage result is unchanged.** `sim/incentive-coverage.ts` models a
  custody term per unit of space held; whether that unit is an object or a byte
  does not move the conclusion, because the term is constant per unit either
  way. Cold content still earns, so it is still kept.
- **This is the shape the current system already has** — `BASE_RATE x storedGB`.
  The formula was never the defect. *Who reports `storedGB`* was. Sampled
  challenges (B2) turn that same term from self-reported into attested, which
  is the whole repair.

**One distinction that decides whether this is safe:** pay on **verified bytes
held**, never on **declared capacity**. Declared capacity is a promise, and
paying for a promise is precisely the defect being removed. Capacity keeps its
two real jobs — gating how much a provider may be assigned, and (as measured
concurrency, `calibration.ts`) deciding how much traffic to route at it — and
touches the money nowhere.

#### B5a - Two updateable per-account objects (Lucian, 2026-09-22)

Replace per-file minting with **two records per account, each replaced rather
than appended**:

- a **publish record** — the account's own file index, as an uploader;
- a **service record** — replicas held, bytes served, reads served, as a
  provider.

Two rather than one because the roles have different attestors and different
lifetimes: a publish record is authored by its owner, a service record is only
credible when signed by *other* people. Merging them would let one signature
cover both, which is the self-attestation defect again.

**Where they live so an update is really an update.** The record itself is
content-addressed and off-chain; what goes on the chain is its **root**, a
single field replaced at settlement — the same shape as a balance, and the
engine already keeps a per-account Merkle accumulator for exactly this. So the
chain grows by one settlement per claim, not per file and not per read. At a
24 h manual floor and a 30-day automatic claim, that is at most ~15 blocks per
account per year against the heartbeat design's 2,555.

This also answers "where should the values live" from the original proposal:
concatenated and compressed in the off-chain record, committed by one root
on-chain.

#### B6 - CORRECTED: screened under one human = one account.

The previous pass screened against the *current dev build*, where
`/face-verify/verify` accepts a client-supplied descriptor. That is the
synthetic-face bypass on CLAUDE.md's **Remove before production** list — a
temporary testing feature, not the design. Screening a permanent economic
mechanism against a temporary bypass was the wrong baseline, and the conclusion
it produced was wrong with it.

**Under one-human-one-account, the defences hold:**

- Each fake reader costs **a human**. That is the strongest Sybil price any
  system of this kind has.
- The per-reader cap bounds what one human can attest per epoch.
- The distinct-reader floor requires at least three.
- Capped proportional emission means a colluding set **dilutes** honest
  providers rather than minting new value.

Together: collusion earnings scale linearly with humans recruited, each
contributing at most the cap, out of a fixed pool. That is bounded, priced, and
the same residual every proof-of-personhood economy carries.

**The residual attack, named honestly: a paid read farm.** Bribe real humans to
read your content. It works, it is legal-looking, and it is limited only by
whether the share of emission earned exceeds what the humans cost. Nothing in
the receipt design changes that; the defence is that the pool is capped, so the
farm competes against every honest provider for a fixed prize and the marginal
return falls as the farm grows.

**Forward-looking finding, because it is already planned.** Lucian intends
sub-accounts and domain-based accounts for IoT. Those would **reintroduce the
Sybil surface through the back door**: if one human can mint many device
accounts and each device account carries its own payable-read budget, the cap
becomes per-account rather than per-human and the entire pricing argument above
collapses. **Device and sub-accounts must draw on their parent's payable-read
budget, never receive their own.** That constraint is cheap to honour now and
very expensive to retrofit after IoT accounts exist.

The IP and device limits keep their place as a secondary priced layer — a farm
needs distinct addresses as well as distinct humans — with the same rule as
before: throttle what counts for **payment**, never what a user may **read**,
so that a family, an office or a CGNAT range never loses access.

#### B6-old - The superseded reasoning

Lucian's reasoning: a bad actor reading their own content with many accounts is
not a real worry, because an account needs a real human.

**It does not, in the current build.** `/face-verify/verify` accepts a
client-supplied 128-float descriptor over HTTP and has never seen a camera -
liveness is enforced entirely client-side, and custom tooling skips it. The
relay's real Sybil defences are the per-IP cap and `FACE_MAX` (3 on testnet, 1
on mainnet). So the price of N fake readers is not N humans; it is defeating a
client-side check and sourcing N addresses.

The two proposed limits are also weak in different ways:

- **deviceId is self-asserted** - `crypto.randomUUID()` in localStorage. An
  attacker changes it by typing. It catches honest duplicates only.
- **IP caps meet IPv6.** A single /64 offers 2^64 addresses, which is already
  stress-test #2 in SCREENING. Useful against casual abuse, not against anyone
  prepared.

They are still worth having - but as **one priced layer among several**, never
as the reason collusion is safe.

#### The resolution that keeps Principle 1 intact

Throttle what **counts for payment**, never what a user may **read**. Reading
stays free and unlimited; only the earning attestation is rate-limited per IP
and device. A shared university or CGNAT address then costs nobody their access
- it costs only the ability to mint extra payable reads from one vantage point,
which is exactly the behaviour being limited.

#### Revised defences, replacing the four in 2b

1. Self-attestation refused (`reader === provider`).
2. Per-reader cap on attested bytes.
3. Distinct-reader floor before anything is payable.
4. **Capped, proportional emission** - collusion dilutes rather than mints.
5. **Payable-read throttling per IP/device**, never read throttling.
6. **No failure attestation anywhere.** Penalty is absence of payment.
7. **Off-chain liveness beacon** retained, so cold content keeps a custody
   signal that does not depend on anyone reading it.

Residual, stated plainly: with the identity gate as weak as it currently is,
(2)+(3)+(4) bound the damage but do not make wash-reading unprofitable. **The
identity gate is the load-bearing defence for the entire payment system**, and
it is the thing to strengthen next if UNITS are to mean anything.

### 2d. Second attack pass on the assembled design (2026-09-22)

Everything above, screened as one system rather than as separate ideas.

#### C1 - Claim cadence: Lucian is right, and the cost is hidden elsewhere

| Policy | Claims/yr/account | Blocks/yr at 100M accounts | Chain growth | Evidence retention |
|---|---|---|---|---|
| 24 h manual floor | 365 | 3.65e10 | 13.3 TB/yr | 2 days |
| **30-day auto only** | **12.2** | **1.22e9** | **0.44 TB/yr** | **60 days** |

30x less chain, confirmed. **The cost moves rather than disappearing**: a claim
must be *validatable*, so the evidence has to outlive the interval. Pruned too
early it does not make a smaller payout, it makes a block every node rejects and
strands the chain behind it — the failure `claimableEpochDay` already documents.
So a 30-day cadence makes ~60 days of receipt retention a **consensus-relevant
constant**, up from two.

Three attacks on the auto-only policy, and two need fixes:

- **Herd day.** A 30-day cycle for everyone puts the whole network's settlement
  on one day in thirty. FIXED by deriving the claim day from the account id
  (`claimDayFor`) — measured uniform to within +-3%, needs no coordination and
  anyone can verify a node claimed on its own day.
- **Claim-day grinding.** If the pool were split among *whoever claims that
  day*, an attacker would grind account ids onto quiet days. **The share must be
  computed over the accrual period, never over who happens to claim.** Stated
  because the naive implementation is the grindable one.
- **Offline at claim time.** If only the provider can submit, intermittent
  nodes — phones, the devices Principle 1 exists for — silently lose earnings.
  FIX: let **anyone** submit a claim on a provider's behalf. The evidence is
  reader-signed and the payout goes to the provider regardless, so there is
  nothing to steal and no reason to withhold. Idempotent, because settlement
  moves the baseline.

Removing the manual claim costs users liquidity — up to 30 days before earnings
are spendable. That is a UX cost, not a security one, and it is Lucian's call.

#### C2 - The reward formula, measured

`weight = custodyRate x bytesHeld + serviceRate x bytesServed`, split from the
capped pool. Projections (`sim/reward-formula.ts`), with supply, fleet and
device mix all ASSUMED:

**Where the weight goes.** At 1:0.1 a laptop earns 1% more for serving 5 GB than
for refusing — so the rational strategy is to hoard and decline, a write-only
archive. At **1:3** serving pays 30% more while custody still carries ~70% of
earnings, which keeps cold bytes worth holding. That is the defensible band.

**The finding that matters most, and it is uncomfortable.** Weight proportional
to bytes means earnings proportional to bytes, and the device range is five
orders of magnitude:

| alpha (concavity) | phone UNIT/yr | datacentre UNIT/yr | inequality | gain from splitting 100 ways |
|---|---|---|---|---|
| 1.0 (linear) | 0.00006 | 1.48 | 25,739x | 1.00x |
| **0.9** | 0.00014 | 1.34 | 9,331x | **1.58x** |
| 0.75 | 0.00052 | 1.06 | 2,036x | 3.16x |
| 0.5 | 0.00323 | 0.52 | 161x | 10.00x |

A concave weight compresses the range but **builds in a Sybil incentive**:
splitting one holding across N identities earns `N^(1-alpha)`. At alpha 0.9,
splitting 100 ways gains 58% and costs 100 recruited humans — not worth it. At
0.5 it pays 10x and becomes worth organising. **alpha ~0.9 is the defensible
point**, and it is safe ONLY because the exponent applies to the per-HUMAN
total: applied per key, with sub-accounts available, splitting would be free.

**The honest conclusion no weighting fixes:** a phone earns a rounding error at
every setting, because the pool is small and the fleet is large. Small devices
participate for **access**, not revenue. The IoT story is "your sensor can use
the network", never "your sensor pays for itself" — and saying otherwise would
be the kind of promise this project has to keep.

#### C3 - Sub-accounts, built (`core/sub-accounts.ts`)

Implemented now so stress testing can include them. Two rules carry the whole
security argument:

- **`rootOf` collapses every key to its human**, and every cap, floor and weight
  counts against the root. `distinctHumans` is the function the distinct-reader
  floor must call — otherwise one person with three devices satisfies a
  three-person threshold alone.
- **Depth is exactly one.** A sub-account cannot issue sub-accounts: a deeper
  tree is unbounded, unenumerable by the human at its root, and mintable by
  whoever compromises any device in it.

Sub-accounts get their own keys, custody, routing reputation and calibration.
They never get personhood, their own attestation budget, or a vote
(`consensusWeightFactor` returns 0). Expiry bites on read rather than waiting
for a sweep, because a delegation that stays effective until a timer runs is a
window.

#### Where this leaves the design

Settled: reader-attested service, sampled custody, no failure attestation,
capped proportional emission, bytes-held rather than replica count, auto-only
claims spread by account id, sub-accounts collapsed to humans.

Open and needing Lucian: the **alpha value** (0.9 recommended), the
**custody:service ratio** (1:3 recommended), whether to accept 60-day evidence
retention, and whether losing manual claims is an acceptable UX cost.

Unchanged and still load-bearing: **the identity gate prices every defence
here**. Sub-accounts make that more true, not less.

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

**Simulated, not measured** — and the distinction is the whole of Principle 5.
`sim/reciprocity.ts` models 65 nodes with assumed request rates, capacities,
decay and topology; not one of those inputs comes from a real network. What it
establishes is a **feasibility result**: there exist parameters under which
locally-metered reciprocity separates contributors from free-riders (~8×), an
honest newcomer with no history overtakes a free-rider, and the access floor
holds. What it does NOT establish is that those parameters resemble reality, or
that the result survives at 10B, under one-sided demand, or against an attacker
who adapts. Read the table below as "here is how this design fails", which is
what it genuinely shows, and not as "here is how it will perform".

Three failure modes were found by *running* it, and each is kept as a control:

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
throttle. Stated at the strength the evidence supports: this is an argument from
attack surface plus a feasibility simulation, not a demonstration that
reciprocity works at scale. It is strictly less attack surface than any payment design, it removes
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
