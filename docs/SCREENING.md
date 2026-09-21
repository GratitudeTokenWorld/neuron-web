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
- Bounded at an instant ≠ bounded over time. `O(own + followed)` describes a
  moment; a map that only ever grows satisfies it at every instant and still
  exhausts the box. See ARCHITECTURE.md → *The invariant has two dimensions*.

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

Every estimate, calculation and projection carries its method (PRINCIPLES.md
→ 5): hypothesis first, inputs labelled MEASURED / ASSUMED / DERIVED,
sensitivity shown, reproducible in `src/engine/sim/` rather than asserted in
prose. A projection presented as a measurement is the analysis-side version of
rendering the unmeasured as fact — and is committed just as easily:
`storage-accounting.test.ts` hardcoded a block size and called it measured, in
the file written to expose exactly that.

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

- Screen at the points PRINCIPLES.md → 4a lists (after a batch, when
  other-node-visible behaviour changes, before a new phase).
- A finding that fails **security** stops the change. One that fails
  performance or decentralisation gets written down and weighed.
- When something escapes anyway, add it here with what it cost. That is the
  only entry criterion.
