Continue work on `neuron-web`.

## First, orient yourself

Read in this order — do NOT re-derive what they already record:

1. **[PRINCIPLES.md](PRINCIPLES.md)** — what the project is FOR, and the filter
   every change is judged against, including the screening order:
   **security → performance → decentralisation**, in that order.
   **[SCREENING.md](SCREENING.md)** is the checklist it produces — what to
   review for and what to attack, every entry a defect that actually shipped. New and canonical; `CLAUDE.md` leads with the
   short form. It also sets the testing cadence: run the tests that cover what
   changed, full suite only at a commit boundary or before a deploy.
2. `CLAUDE.md` (auto-loads). Trust *Core principles*, *Where to pick up*,
   *Remove before production* and the storage-custody rules over anything older.
3. `docs/ARCHITECTURE.md` → *Where this stands* (phase table + the T8/T9/T10
   results), *Subsystem 4*, *Multi-device custody*, and the **principle
   self-review** entries.
4. `docs/TESTPLAN.md` — T1–T10 are now all recorded passes; the Findings section
   records what running them surfaced.
5. `.claude/skills/e2e-browser-test/SKILL.md` — E2E creates its own accounts
   now. There is no fixture to capture.

## State as of HEAD `4fac0af` (verified, not assumed)

- **803 tests / 93 files green**, `npm run typecheck` clean, `npm run build`
  clean.
- App-layer `tsc -p tsconfig.json` = **121 errors — this is the baseline, never
  add to it.** Take a **per-file** count before and after; the total falling
  does not prove your file did not gain errors.
- ⚠ **The chain format changed four times this session** — `storage-reward` and
  `storage-heartbeat` removed, `storage-settle` added, the storage payload
  reshaped. **Wipe before running against any existing chain**, client and
  relay. Nothing will migrate and nothing should try to.
- **Relays** still run `890e047` (2026-09-21). Everything below is committed and
  **NOT deployed**; `relay/server.ts` changed (the `/providers` scan), so a
  deploy is needed before any of it is live. Relays are covered by neither
  typecheck nor tests — re-read edits, and check `pm2 jlist` restart counts
  **after** 60 s, not immediately.
- Live probes to run after that deploy, both previously **ALL CHECKS PASSED**:
  `npx tsx scripts/g1-resolve-smoke.mts` (55 checks) and
  `npx tsx scripts/backfill-smoke.mts` (⚠ stops and starts a relay over ssh).
- **E2E**: `npm run e2e` as
  `LOCAL_ONLY=1 TEST_FACE=1 STORAGE_TIMING=fast npm run dev`. **Not re-run since
  the storage economy changed** — T8/T9/T10 touch provider registration and
  custody, so expect them to need updating rather than to pass.

## What shipped this session — the storage economy was rebuilt

The payment model changed completely. Read CUSTODY-PROOFS.md → sections 2b–2d
before touching any of it; the short version:

- **Heartbeats are GONE** (block type, scheduling, epoch counters, uptime
  scoring and UI). They did three jobs, and all three moved.
- **Payment is metered by readers, not providers.** `content/read-receipts.ts`
  holds one cumulative, reader-signed receipt per counterparty; the receipts
  travel INSIDE a `storage-settle` block so any node re-derives the payout from
  the same bytes. A provider signs its own settlement and still cannot choose
  the number. This closed the self-metered-rewards finding that stood open for
  the previous three sessions.
- **The lease is renewed by observed service** (`content/custody-sampling.ts` →
  `CustodyLiveness`), fed by spot checks and ordinary reads. Custody is proven
  by sampled reads — 1,000× cheaper than checking everything, with detection
  compounding over the lease.
- **Routing moved off-chain** to a signed presence beacon
  (`content/presence.ts`). An address is ephemeral and never belonged on a
  permanent chain.
- **Replication is demand-scaled both ways**: a sliding-window read RATE (not a
  lifetime counter), linear growth to a cap, and surplus released back as
  uncounted spares. Plus saturation-driven placement from measured device
  capacity (`content/device-capacity.ts`, `content/calibration.ts`).
- **A copy means a distinct FAILURE DOMAIN**, inferred from observed
  co-failure (`content/failure-domain.ts`). `deviceId` is a self-assigned UUID
  and is a hint only.
- **Sub-accounts** (`core/sub-accounts.ts`): `lucian.sensor1`, collapsed to one
  human everywhere a cap, floor or weight is counted.
- **The sustained-load test exists** (`sim/sustained-load.ts`) and found three
  real leaks immediately. Run it when adding any keyed structure.

Economics are modelled in `sim/token-economy.ts` and `sim/reward-formula.ts`:
mint per byte served, burn per byte stored at `COST_RATIO` 10 (which is
`REDUNDANCY_TARGET`, so the economics and the space conservation agree by
construction). Emission must be tied to ACTIVITY, never to a percentage of
supply — that pairing has an unstable equilibrium, measured.

## Your next task, in this order

1. **Deploy and re-verify.** Relays are four commits behind and the chain
   format changed: wipe `.relay-data/` (keep the peer-id and attester keys) and
   client storage, deploy, then run both live probes. Nothing below is
   trustworthy until this is done.
2. **Re-run and repair the E2E suite.** T8/T9/T10 exercise registration and
   custody, both of which changed shape. Expect edits, not passes.
3. **Finish the economy's open ends**: the settle path has no UI at all, the
   publish/service roots are computed but nothing reads them back, and the
   free-tier allowance (`freeBytes` in `settlementOutcome`) is a parameter
   nobody sets.
4. **Backfill for the OTHER archive stores** — account directory, pending
   sends, file index, provider records. Same demand-driven rule, never a sync.
5. **Multi-device custody** (decided, unbuilt): per-device chains with an
   account-signed delegation. `core/sub-accounts.ts` is the delegation half;
   the device-group tag is still unsettled.
6. **The migration seam**, per caller — 121 app-layer type errors. The legacy
   `core/dag-ledger.ts` still carries its own heartbeat and provider code; it
   is slated for wholesale removal, so do not clean it piecemeal.

## Traps that each cost a debugging cycle — do not repeat

- **A test that cannot fail is worse than no test.** This session produced four
  in one file. A CID scraped from a log line that truncates to 20 characters
  (still parses as a CID, matches nothing). A provider lookup with an empty
  prefix, where `includes('')` matches every row. "The rate is 0" asserted
  against a whole row, satisfied by the 0 in "5.0 GB". A negative assertion
  passing because the UI *elides* the identifier it was matching. Before
  trusting a green assertion, ask what value would make it fail.
- **Every rejection must say why.** Two investigations this session ended in one
  line each, after being made to speak: `repairOnReadFailure` ("not repairing:
  this node tracks no such CID") and `issueRewardsIfEligible` (whose comment
  said "log and continue" while logging nothing, ~100 times an epoch).
- **Two log streams do not overlap.** `console.*` carries `[StorageManager]`;
  `addLog()` carries the in-app panel and never reaches console. Some actions
  report only through a **toast**, which removes itself after 4 s.
- **PowerShell is primary, and `VAR=x cmd` is bash-only** — it silently sets
  nothing. Same for `os.ps1` vs `os.sh`. If an openstack command prints no
  table, it did not run.
- **One fire-and-forget gossip message is never enough.** The fix shape is
  always: publish, then ASK whether it landed, then publish again — bounded.
- **Never let a signer and a verifier live in different files.**
- **`relay/` is typechecked by nothing and tested by nothing.** Put releasable
  logic in pure engine modules; verify on isolated ports
  (`PORT=9190 RELAY_DATA_DIR=.relay-verify npx tsx relay/server.ts`) before
  deploying, and check `pm2 jlist` restart counts **after** the 60 s timer. The
  backfill's first version threw `pubsub is not defined` on the first miss —
  caught exactly this way.
- **Verify infrastructure from OUTSIDE.** `systemctl is-active` proved nothing
  about TURN; a raw STUN probe did.
- **`pm2 delete` + `pm2 start` de-federates a relay, silently.** The ecosystem
  file inherits `PEER_RELAYS` from the shell and a non-interactive ssh has
  none, so the relay comes up healthy, answers 200, and never speaks to its
  peer again. Use `pm2 restart`, or source `~/.relay-env` first. Details and
  the check in SUPERNODE.md.
- **Do not guess twice.** Get the log line, the archive query, or the probe
  first.

## Working agreements

- **Dev mode**: chain/relay data is disposable, and Lucian has restated that
  wiping the testnet is *cheap and expected* — do not engineer around stale
  data. Keep the relay peer-id and attester keys.
- **Cloud**: read-only OpenStack commands are fine unprompted; **confirm before
  creating, resizing or deleting**, and before deploying to the relays.
- Deploy = push, then per box `ssh -i ~/.ssh/neuron-ops ubuntu@<ip>`,
  `cd ~/neuron-web && git pull && pm2 restart neuron-relay`; then restart counts
  after 60 s, then the smoke probe. `npm install` only if a dependency changed —
  it also drags `@playwright/test` onto the relays.
- **Face flows that need a REAL face stay manual** — T1's live capture and T5
  recovery (the synthetic path produces no trajectory proof, by design). Say
  exactly what to check and which log lines to expect.
- Comments explain *why*; match the existing density. A rule worth a comment is
  worth a test.
- When you finish, grep `README.md`, `CLAUDE.md` and `docs/*.md` for claims you
  invalidated — test counts, error counts, probe counts, phase status, the
  deployed relay commit. Reading your own diff misses stale headers every time.

## Open items awaiting Lucian's decision (do not action unprompted)

1. **The pseudonymous device-group tag.** Per-device chains need SOME linkage
   for the replica rule, and unlinkability fights bounded minting.
   ARCHITECTURE.md → *Multi-device custody*.
2. **The operator vote and the code-sync/upgrade path** (PRINCIPLES.md → 3; ARCHITECTURE.md → Hard problems).
   Both are stated commitments with no design at all, and every
   consensus-visible change quietly accrues debt against them.
3. **Moderation.** Principle 1 is about access to the technology, so it does not
   settle what the network does about abusive content. Unmade decision, and a
   protocol question as much as a policy one.
4. **`blob.pinAttemptState` is vestigial** (~40 lines). Carried, unactioned.
5. **The gossiped `LockoutNotice` penalizes only honest users.** Recommendation:
   delete the two `publishLockout` calls. It changes consensus voting behaviour,
   so it is his call.

6. **Supply / denomination.** The only economically real parameter left in the
   storage economy: a reference node's SHARE is fixed by the formula, and the
   supply decides whether that share reads as 1 unit or 1000
   (CUSTODY-PROOFS.md → C5).
7. **Free-tier size**, coupled to the per-reader attestation cap — the cap must
   stay below what the free tier gives away, or wash-reading out-earns signing
   up honestly. Raise one and re-derive the other.
8. **A third attester on unrelated infrastructure.** Measured 2026-09-22: the
   two cloud relays are ~1.1 ms apart and share a datacentre, so 2-of-2
   attesters and the Shamir 2-of-n are one failure domain against anyone who
   compromises or subpoenas the host. Lucian's laptop closes the prober half
   but is unreachable inbound, so it cannot serve as the third attester.
   Billable, so it is his call.
