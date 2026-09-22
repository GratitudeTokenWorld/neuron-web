# Screening and stress-testing

What to check every change against, and what to deliberately attack.

Every entry here comes from a bug this project actually shipped. Nothing is
included because it is good general advice; if it is listed, it cost us
something. New entries should meet the same bar — add one when a defect
escapes, not when one is imagined.

---

## The order of screening: security → performance → decentralisation

Set by Lucian, 2026-09-21. Every idea, change and piece of research is judged
against all three, **in this order**, and the order is what makes it a decision
procedure rather than three opinions:

1. **Security first.** A faster or more decentralised design that weakens the
   security model is not a trade to be weighed — it is rejected, and the
   alternative is found. "Secure improvements" is the standing instruction.
2. **Performance second.** Among designs that are equally safe, prefer the one
   that costs less per node. The scale invariant lives here.
3. **Decentralisation third** — *not because it matters least*, but because it
   is the constraint most often reached for as an excuse to compromise the
   first two. A design that is more decentralised AND less safe loses at step
   1. Where safety and cost are equal, take the one with no required party.

Where the three conflict, say so out loud in the commit or the doc rather than
resolving it silently. A conflict is information about the design.

---

## Screen for these (static review)

### 1. Unbounded state — and who controls the growth

The question is never "does this grow?" but **"who decides how fast, and does
it ever shrink?"** State whose size is chosen by an outsider is a security
finding, not a performance one.

- Every `Map`/`Set`/array that outlives a request: what is the key, who
  supplies it, and what removes an entry?
- **Rate limiters are the trap.** Their bookkeeping is state an attacker grows
  by definition, because it is keyed by something the attacker picks. Found
  twice: `BackfillLimiter` kept every key nothing ever answered, and the
  relay's three per-IP maps were never pruned at all — with IPv6, a single /64
  gives 2^64 keys.
- **A per-key ALLOWANCE is the same shape as per-key state.** A free
  allowance granted *per stranger* is a subsidy keyed by something the attacker
  chooses, so spreading requests across peers makes it unlimited. Measured in
  `sim/reciprocity.ts`: the per-stranger floor erases the difference between a
  contributor and a free-rider entirely. A floor must be a budget the SERVER
  has, shared among strangers.
- Bounded at an instant ≠ bounded over time. `O(own + followed)` describes a
  moment; a map that only ever grows satisfies it at every instant and still
  exhausts the box. See ARCHITECTURE.md → *The invariant has two dimensions*.

### 1b. Self-asserted identifiers used as security controls

`deviceId` is `crypto.randomUUID()` stored in localStorage, and it was deciding
whether two replicas sat on different machines — a question the holder answers
about itself, for free. Ask of any identifier that gates something: **who
assigns it, and what does a lie cost?** The replacement is the rule reciprocity
arrived at independently — *observation replaces testimony*: judge independence
on observed co-failure, which cannot be asserted into existence
(`engine/content/failure-domain.ts`).

### 1c. Fan-out that grows with every peer ever seen

`SmokeStore.peerFallbacks` is a `Set` with an `add` and no remover, seeded from
every peer that ever connected — and `retrieve()` races `Promise.any` across
**all** of it. Three defects in one field: unbounded state keyed by an outsider,
a per-read fan-out that grows for the life of the process, and an amplification
vector where one cheap read causes work at every peer. Found 2026-09-22 while
confirming that reader-caches scale popular content for free — they do, and this
is the path that finds them, so it must be **bounded rather than removed**.
**Open.**

### 1d. Independence assumed from topology that was never measured

Measured 2026-09-22, TCP connect time: relay-1 to itself **0.16 ms**, relay-1 to
relay-2 across the private network **~1.1 ms**, laptop to either **~17 ms**.
Same-host VM-to-VM sits near loopback, so at 1.1 ms the two relays are probably
different physical hosts — and they are unambiguously the same rack, datacentre,
power feed, network and hosting provider.

That matters past storage. The identity design leans on **2-of-2 attesters** and
a **Shamir 2-of-n** recovery share held across relays, and both are described as
removing a single point of failure. Against an attacker who compromises,
subpoenas or simply outlasts *cloudify.ro*, they do not: two shares in one
datacentre is one share. The design is sound; the **deployment** does not yet
instantiate it, and nothing in the code says so.

The general rule: **independence is a measurement, not an assumption baked into
a deployment diagram.** Any k-of-n claim should name what it is independent
*of*.

**Attempted fix, 2026-09-22: the laptop as a third node.** Measured what it can
actually do. All three relays agree (generation 19), so the laptop's relay
federates fine — libp2p dials *outbound* and the gossip meshes merge. But
inbound is blocked: from relay-1, `http://<laptop>:9090` and `:9092` both
return `000`, connection refused. So:

| Role | Works? | Why |
|---|---|---|
| Third gossip participant / archive | **yes** | outbound dial, mesh merges |
| Third calibration prober | **yes** | probing is outbound fetches |
| Storage provider | **yes** | smoke/WebRTC traverses NAT via STUN |
| Third attester for clients ON the laptop | **yes** | localhost, and this is why dev logs 3 attestations |
| **Third attester for anyone else** | **no** | clients cannot reach it |

So the laptop closes the prober half (`MIN_DISTINCT_PROBERS`) and adds a genuine
third failure domain for its own client. It does **not** close the k-of-n
independence gap for other users, because an attester nobody can reach is not an
attester. That needs either inbound port-forwarding on Lucian's router, or a
third relay on a **different hosting provider** — the latter being billable and
therefore Lucian's call. **Still open for the attester half.**

### 1e. The reviewer writes the same defect while documenting it

Self-review of 2026-09-22 found **four** instances of items 1 and 9 in code
added that same day, by the same author, alongside the text warning about them:

- `CalibrationRun.samples` grew forever — every spot check pushed one and
  nothing removed any. Measured: 100k samples cost 17.9 ms per `analyze()`, and
  `analyze()` runs per holder per target computation. Now capped per rung.
- `inferDomains` ran a quadratic sweep **per CID per repair cycle**. Measured
  41 ms a call at 240 holders with failure history; a thousand tracked CIDs
  would have spent 41 seconds per cycle. Now capped and cached node-wide.
- `providerDomain`/`holderCapacity` did `getStorageProviders().find()` — a
  linear scan past an existing `Map` — once per holder inside a loop over every
  tracked CID.
- `calibrations`/`calibratedAt` were keyed by provider public key with no
  remover, and anyone may register as a provider.

The general lesson is not "be careful". It is that **new state and new loops
need the checklist run against them explicitly, by someone reading the diff for
that purpose** — knowing the rule does not apply it. A useful trigger: any new
`Map`/`Set`/array field, and any call inside a loop over tracked content.

One more, worth its own line: **the first fix was insufficient and the test
written for it flattered the fix.** Skipping holders with no failure history
made a *healthy* fleet cheap, and the test used a healthy fleet — so it passed
while the realistic case (every holder has some failures) stayed quadratic. Ask
what workload the test is using, and whether it is the easy one.

### 2. Silent returns

A `return` with no log is indistinguishable from "the message never arrived",
and telling those two apart has cost this project multiple days.
**Every rejection says why.** Found in `repairOnReadFailure` (three silent
exits) and `issueRewardsIfEligible` (whose comment said "log and continue"
while logging nothing, ~100 times an epoch).

### 3. A signer and a verifier in different files

Every storage gossip message was unverifiable for weeks because one side signed
a JWK and the other read an engine hex id. Payloads must be **rebuilt from the
record** by the verifier, never trusted from the message. If two places must
agree about bytes, they live in one module.

### 4. Assertions that cannot fail

The most dangerous test is a green one that never could have been red.

- A **truncated identifier that still parses** — a CID scraped from a log line
  that prints `slice(0, 20)` matched nothing, for weeks, across two test rows.
- `includes('')` **matches every row** — an empty prefix made a discovery test
  pass against someone else's data.
- A substring **satisfied by the wrong column** — "the rate is 0" is true of
  "5.0 GB".
- The UI **elides identifiers** (`bafkrei…tail`, pubs to 7 chars), so a
  negative assertion written against the full value passes for that reason.

Before trusting an assertion, ask what value would make it fail.

### 5. The unmeasured rendered as fact

`0` and "we did not measure" are different claims. A balance for an account
whose chain we do not hold, a network file count before any archive answered,
an uptime for a provider whose chain we lack — all must read `—`. Aggregates
carry their sample size.

### 6. Counts that mix "live" with "ever"

Custody, replicas, holders, providers: a count that includes lapsed members is
a guess, and the first honest failure takes it below the threshold the guess
claimed. The content library showed `confirmedProviders.size` — holders
*confirmed ever* — as if they were replicas.

### 7. Fire-and-forget messages

One gossip message is never enough. Deletes, registrations, file announcements
and backfill requests have each failed this way. The shape that works:
**publish, then ASK whether it landed, then publish again** — bounded.
Publishing to a topic nobody has subscribed to is the silent version.

### 8. Fixed units against a configurable clock

`LAST REWARD -59066340h ago`, `lease lapsed 0h ago (max 0h)`. If a duration is
derived from a profile, so is its unit.

### 9. Reintroducing `O(N)`

Global topics, whole-chain pulls, sync-on-rejoin, unbounded list endpoints,
"everyone should hold this so nobody depends on anyone". Four `O(N)` paths have
been removed; each was re-proposed later as a convenience. The invariant binds
what a node must **answer**, not only what it holds.

### 10. Implicitly inherited configuration

`pm2 delete` + `pm2 start` over ssh dropped `PEER_RELAYS` and silently
de-federated both relays: healthy-looking, 200s, and no peer contact. Config
that arrives from the environment needs an explicit check that it arrived.

### 11. Self-reported numbers that meter a payout

Ask of every payout term: **who computes this, and what does a lie buy them?**

Storage rewards are `BASE_RATE × min(storedGB, capacityAtStart) × uptime`, and
both volume terms come from the provider: `storedBytes` rides in its own
heartbeat, `capacityAtStart` is whatever it declared. `validate` checks the
claim against `rewardTerms`, which is computed from the same self-report — the
verification is circular. The on-chain evidence ceiling bounds UPTIME, which is
cheap to produce honestly, and bounds nothing about volume.

Found by the first black-hat pass (2026-09-21) and kept as an adversarial
control in `provider-ledger.test.ts`. **Open** — the fix is Phase 4's
custody-proven payouts, which is an economic design decision, not a patch.

### 12. Numbers without provenance

The procedure PRINCIPLES.md → 5 requires. Every estimate, calculation and
projection must:

- **State the hypothesis first, and what result would DISPROVE it.** An
  analysis that cannot fail is the same defect as a test that cannot fail
  (§4 above), and it hides just as well.
- **Label every input MEASURED, ASSUMED or DERIVED**, and say where a measured
  one came from. `sim/projection.ts` does this properly: it takes the canonical
  byte counts of real signed objects, and says so.
- **Never present a projection as a measurement.** "Measured baseline" and "10B
  projection" are different kinds of knowledge, and the second is only ever as
  good as its assumptions.
- **Show the sensitivity.** If the conclusion flips when an assumption moves by
  2×, the conclusion is about the assumption, not about the system.
- **Be reproducible.** A number that lives only in a chat message is an opinion;
  the same number as a runnable module is evidence. It goes in
  `src/engine/sim/`, where it re-runs with the suite and its inputs are visible.
- **Re-measure when the system changes.** A stale constant is an assumption
  wearing a measurement's clothes.

A projection presented as a measurement is the analysis-side version of
rendering the unmeasured as fact — and is committed just as easily:
`storage-accounting.test.ts` hardcoded a block size and called it measured, in
the very file written to expose that failure.

### 13. Trusting a claim as proof

A receipt says a provider *cached* something. Deleting the last local copy on
that basis trusts a message. Ask the holder to produce the bytes.

---

## Stress-test for these

Ordered by what would hurt most, not by ease.

0. **Attack it deliberately.** `.claude/skills/black-hat-review/SKILL.md` —
   pick a target worth attacking, write the attacker's goal in one sentence,
   and BUILD the attack rather than arguing about it. Dev mode is the window:
   data is disposable and there is no real money yet.
1. **Sustained write load over time** — the one still unbuilt. Not "is per-node
   cost bounded now?" but "does any per-node structure grow monotonically over
   hours at target write rates?". This is the test that would have found both
   limiter leaks by construction.
2. **Scan traffic from many distinct source addresses.** An IPv6 /64 against
   every keyed endpoint: `/resolve`, `/files`, `/pending-sends`, `/head-proof`,
   `/face-verify/*`. Watch relay RSS, not just response codes.
3. **Relay outage and rejoin.** Covered by `scripts/backfill-smoke.mts`. Assert
   the heal, never the ask — the ask passed while nothing was listening.
4. **Churn above the repair rate.** Judge the replica STOCK, never the
   churn/repair ratio: a collapsed network loses little per tick, so the ratio
   reads healthy at the bottom of a death spiral.
5. **Clock-profile mismatch between nodes.** `STORAGE_TIMING` is a consensus
   input: a node on a different profile rejects correctly-signed blocks
   mid-chain and strands everything after them.
6. **Two writers on one account chain.** A fork is not flaky, it is a
   permanently frozen account.
7. **Forged and inflated records at every archive endpoint.** Partly covered by
   `g1-resolve-smoke.mts` (inflated size, wrong-CID signature, higher
   `_version` forgery). Extend it whenever an endpoint is added.
8. **A long soak with no traffic.** Timers, not requests: re-announce loops,
   reward polls, spot checks and sweeps all run on their own and each is a
   chance to leak or to log a hundred times an epoch.

---

## Using this

**When the self-review is due** (PRINCIPLES.md → 4 says it is required; this is
when). Any one of these is a trigger:

- a batch of meaningful changes has landed — roughly, enough that you would
  write a handoff note about it;
- a subsystem's behaviour changed in a way another node can observe;
- a shortcut was taken that needs an entry on CLAUDE.md's *Remove before
  production* list; or
- a new phase of work is about to start.

Re-read the work against the principles rather than against the tests: the
question is not "does it pass?" but "does this still build the thing the
principles describe?". Write the result where the decision lives — usually
ARCHITECTURE.md or the relevant section of CLAUDE.md — and raise anything that
fails the filter with Lucian instead of fixing it silently.

- A finding that fails **security** stops the change. One that fails
  performance or decentralisation gets written down and weighed.
- When something escapes anyway, add it here with what it cost. That is the
  only entry criterion.
