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

## State as of HEAD `15a3f29` (verified, not assumed)

- **551 tests / 73 files green**, `npm run typecheck` clean, `npm run build`
  clean.
- App-layer `tsc -p tsconfig.json` = **121 errors — this is the baseline, never
  add to it.** Take a **per-file** count before and after; the total falling
  does not prove your file did not gain errors.
- Live probes, both **ALL CHECKS PASSED**:
  `npx tsx scripts/g1-resolve-smoke.mts` (55 checks) and
  `npx tsx scripts/backfill-smoke.mts` (the archive heal: chains, and the record stores — ⚠ it stops and
  starts a relay over ssh). Run after every relay deploy — and wait for the relays to finish
  restarting first, or you get phantom failures.
- **Relays**: both cloud boxes (`80.97.27.224`, `80.97.27.112`) run **`890e047`**
  (deployed 2026-09-21). They carry the archive backfill, **verified healing in
  production** by `scripts/backfill-smoke.mts`. Restart counters were reset to 0
  when the processes were recreated, so compare against 0, not the old 19. Anything relay-side committed after that needs a deploy before it
  does anything at all.
- **E2E**: `npm run e2e`. T8, T9 and T10 all pass unattended. Run the stack as
  `LOCAL_ONLY=1 TEST_FACE=1 STORAGE_TIMING=fast npm run dev` — see the skill for
  why `LOCAL_ONLY` is not optional for repeated runs.

## What shipped this session

- **Core principles** written down (PRINCIPLES.md) and wired into CLAUDE.md,
  ARCHITECTURE.md and README as the filter every change is judged against.
- **A synthetic face** (`src/core/test-face.ts`, ⚠ dev-only, on the
  remove-before-production list) so E2E creates accounts in ~4 s with no human.
  Only the camera is replaced; attestation, the v3 blob and the Shamir split all
  run for real.
- **T8, T9, T10 automated and passing** — the whole storage verification debt.
- **Four product defects fixed**: the publisher never released its copy after
  handoff; an account record could regress to a stale, *unsigned* balance; a
  file's first announcement could be lost behind a 5-minute re-announce; and the
  lapse message read `0h ago` on a compressed clock.
- **Phase 4 started**: archive backfill between relays, demand-driven on a miss
  and rate-limited, deployed and verified live.

## Open security finding — read before touching rewards

**Storage rewards are self-metered.** The payout is
`BASE_RATE × min(storedGB, capacityAtStart) × uptime` and both volume terms
come from the provider itself, validated against the same self-report. A
provider that stores nothing out-earns an honest 4 GB one by 2500×, so the
rational strategy is to store nothing. Demonstrated as an adversarial control
in `provider-ledger.test.ts`; when custody-proven payouts land, that test
should FAIL and be rewritten as the guarantee. ARCHITECTURE.md → *Open
security finding*. **Not fixed — it is an economic design decision.**

## Your next task, in this order

1. **Phase 4 — the rest of scale hardening.** Backfill for the OTHER archive
   stores (account directory, pending sends, file index, provider records — each
   has its own store and no peer-query mechanism yet; same demand-driven rule,
   never a sync). Then custody-proven incentive payouts, adaptive limits,
   security bounds, and the sustained load test.
2. **Multi-device custody** (decided, unbuilt): per-device chains with an
   account-signed delegation. Settle the pseudonymous device-group tag first.
3. **The migration seam**, per caller — 121 app-layer type errors.

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
2. **The operator vote and the code-sync/upgrade path** (PRINCIPLES.md → 3e).
   Both are stated commitments with no design at all, and every
   consensus-visible change quietly accrues debt against them.
3. **Moderation.** Principle 1 is about access to the technology, so it does not
   settle what the network does about abusive content. Unmade decision, and a
   protocol question as much as a policy one.
4. **`blob.pinAttemptState` is vestigial** (~40 lines). Carried, unactioned.
5. **The gossiped `LockoutNotice` penalizes only honest users.** Recommendation:
   delete the two `publishLockout` calls. It changes consensus voting behaviour,
   so it is his call.
