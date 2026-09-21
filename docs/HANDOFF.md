Continue work on `neuron-web`.

## First, orient yourself

Read in this order — do NOT re-derive what they already record:

1. `CLAUDE.md` (auto-loads). Trust *Where to pick up*, *Remove before
   production* and the storage-custody rules over anything older.
2. `docs/ARCHITECTURE.md` → *Where this stands*, *Subsystem 4* (read **What of
   this is implemented**, **Fan-IN**, and the new *Multi-device custody* block).
3. `docs/TESTPLAN.md` (**T9 and T10 are written and mostly unrun**),
   `docs/SUPERNODE.md` (HTTP API table), `docs/CLOUD.md` (TURN section is new).
4. `.claude/skills/e2e-browser-test/SKILL.md` — **new. You can now drive the app
   in a real browser yourself instead of asking Lucian to click.**

## State as of HEAD `ff9b768` (verified, not assumed)

- **512 tests / 70 files green**, `npm run typecheck` clean, `npm run build`
  clean.
- App-layer `tsc -p tsconfig.json` = **123 errors — this is the baseline, never
  add to it.** Take a **per-file** count before and after; the total falling
  does not prove your file did not gain errors.
- Live probe `npx tsx scripts/g1-resolve-smoke.mts` = **55 checks, ALL CHECKS
  PASSED** (was 41; `/files` coverage added). Run after every relay deploy — and
  wait for the relays to finish restarting first, or you get phantom failures.
- **Relays**: both cloud boxes (`80.97.27.224`, `80.97.27.112`) run **`890e047`**
  (deployed 2026-09-21, restart counts 19→20 — one deliberate restart each, no
  crash loop, verified after the 60 s timer). They now carry the **archive
  backfill**: a `/head-proof` miss makes the relay ask its peers for that
  account's blocks. Verified live — the first miss asks, the second is refused
  as already in flight, and it found three REAL archive gaps within a minute of
  going up. No `npm install` was needed: the change adds no external import.
  The smoke probe is **55/55** against both boxes after the deploy.
- **E2E**: `npm run e2e` (Playwright, using the installed Chrome/Edge channels).
  `e2e/smoke.spec.ts` needs no fixture and passes 5/5 against a live stack.

## What shipped this session (~37 commits)

**Phase 3 build list is DONE.** Lease + repair (`engine/content/custody.ts`),
publish handoff, file index off the global topic (`GET /files`), repair-vs-churn
measured (`engine/sim/repair.ts`), an opt-in S3 backend, and a compressed dev
timing profile so a storage cycle is 12 minutes instead of a day.

**The most important finding**: every signed storage gossip message was
**unverifiable**, and had been since accounts moved onto the engine. The app
signed with `signData` (WebCrypto JWK) while verifiers read the account engine
hex id; `atob(hex)` cannot yield a JWK, so the import threw inside a `catch` and
reported "invalid signature". Content distribution, the file index and
receipt-based scoring were all silently dead. Fixed — then the SAME mismatch was
made twice more in other files, so signer and verifier now live in one module
(`src/network/storage-signing.ts`) with a test asserting the exact trap.

## Bugs Lucian found by inspection — expect more, he is very good at this

Nine defects came from him noticing a number that could not be true. The pattern
is always *a value true of one thing, rendered against another*:

- uptime computed **three ways with two denominators**, so UPTIME and SCORE
  disagreed about the same provider
- **"Avg Uptime" was an average of one sample** — each device averaged itself
- uptime **oscillated 100% to 83%** for a provider that never missed a beat: six
  intervals span slightly more than one epoch, so the oldest renewal aged out
  before its replacement landed
- **"7/6 heartbeats due"** — my fix for the above, one layer up
- **`LAST REWARD -59066340h ago`** — a hardcoded 24h against a 12-minute epoch
- deregistration **never reached other nodes** (discovery ignored the block)
- **tombstones counted as files** ("4 files archived" on an empty network)
- **device-bound custody, silently** — a recovered account showed an inert
  serving row that would never heartbeat, earn or cache
- the device guard **failed OPEN** on an empty deviceId, which forked and
  **permanently froze** an account (fraud proofs working exactly as designed)

## Decisions Lucian made (do not silently revisit)

1. **Multi-device custody: per-device chains**, with the account signing a
   delegation. The reason is privacy — *"we do not want to doxx people's devices
   on the same chain"* — as much as the fork hazard. **Devices of one account
   never count as two replicas** (shared failure domain). Design and the open
   question are in ARCHITECTURE.md → *Multi-device custody*. **Not built.**
2. **Compressed timing (`STORAGE_TIMING=fast`) is dev-only** and on the
   remove-before-production list. It is a CONSENSUS input.
3. **`MIN_REPLICAS` = 2 and the uploader never counts itself** — authorship is
   not custody. On a two-account network the handoff therefore cannot complete;
   that is the rule working, not a bug.
4. Tombstone retention is **derived** (`2 × MAX_OFFLINE_MS`), never picked.

## Your next task, in this order

1. **Run T9 steps 2–6 and T10** — the remaining verification of Phase 3, and now
   automatable. Use the `e2e-browser-test` skill: two browser contexts are two
   devices over loopback WebRTC. Needs a captured session first
   (`npm run e2e:capture alice`), which is the one manual step.
2. **Wire the multi-device design** (decision 1). It reaches into `openAccount`
   and the mint, so settle the open question in ARCHITECTURE.md first.
3. **Phase 4** — relay federation. ARCHITECTURE.md records the archive-backfill
   gap and the shape its fix must take (**demand-driven on a miss, never a
   sync-on-rejoin**, which would be `O(archive)`).

## Traps that each cost a debugging cycle — do not repeat

- **Two log streams do not overlap.** `console.*` carries the
  `[StorageManager]` lines; `addLog()` carries the in-app panel and never
  reaches console. Waiting on the wrong one hangs forever and looks exactly like
  a dead feature.
- **PowerShell is primary, and `VAR=x cmd` is bash-only — it silently sets
  nothing.** Use `$env:VAR = 'x'; cmd`. Same for `os.ps1` vs `os.sh`: the wrong
  one runs nothing and prints nothing. **If an openstack command prints no
  table, it did not run.**
- **A silent `return` is indistinguishable from "the message never arrived".**
  That ambiguity consumed most of a day. Every rejection must say why.
- **One fire-and-forget gossip message is never enough.** Deletes,
  registrations and file announcements each failed this way. The fix shape is
  always a bounded, verifiable tombstone the peer can ASK for.
- **Never let a signer and a verifier live in different files.**
- **`relay/` is typechecked by nothing and tested by nothing.** Put releasable
  logic in pure engine modules; verify on isolated ports
  (`PORT=9190 RELAY_DATA_DIR=.relay-verify npx tsx relay/server.ts`) before
  deploying, and check `pm2 jlist` restart counts **after** the 60 s timer.
- **Verify infrastructure from OUTSIDE.** `systemctl is-active` proved nothing
  about TURN; a raw STUN probe did. Twice in one day something looked
  configured and was unreachable.
- **Do not guess twice.** I offered three wrong mechanisms in a row before
  checking. Get the log line, the archive query, or the probe first.

## Open items awaiting Lucian's decision (do not action unprompted)

1. **The pseudonymous device-group tag.** Per-device chains need SOME linkage
   for the replica rule, and unlinkability fights bounded minting. The nullifier
   shape resolves it; the cost is that observers can see "these providers are
   one person" without seeing who. ARCHITECTURE.md → *Multi-device custody*.
2. **A chain-landed check** — compare the archives' `headIndex` to the local
   head on the poll that already runs, and re-publish if behind. Two propagation
   hunts in one day would each have been a single log line. `O(own accounts)`.
   Offered, not answered.
3. **Refuse re-registration while another device's lease is live** (with an
   explicit override), closing the last multi-writer window before per-device
   chains exist.
4. **T8 step 5's day boundary is no longer blocking** — `STORAGE_TIMING=fast`
   solved it, and the reward ran green (98 milli-UNIT for 101.27 MB).
5. **`blob.pinAttemptState` is vestigial** (~40 lines). Carried, unactioned.
6. **The gossiped `LockoutNotice` penalizes only honest users.** Recommendation:
   delete the two `publishLockout` calls. It changes consensus voting behaviour,
   so it is his call.

## Working agreements

- **Dev mode**: chain/relay data is disposable. Keep the peer-id and attester
  keys.
- **Cloud**: read-only OpenStack commands are fine unprompted; **confirm before
  creating, resizing or deleting**. Security-group changes are permission-gated
  — stop and hand the commands over rather than working around the guard.
- Deploy = push, then per box `ssh -i ~/.ssh/neuron-ops ubuntu@<ip>`,
  `cd ~/neuron-web && git pull && pm2 restart neuron-relay`; then the smoke
  probe.
- **Face flows cannot be automated** — ask Lucian for the manual pass, and say
  exactly what to check and which log lines to expect.
- Comments explain *why*; match the existing density. A rule worth a comment is
  worth a test.
- When you finish, grep `README.md`, `CLAUDE.md` and `docs/*.md` for claims you
  invalidated — test counts, error counts, probe counts, phase status. Reading
  your own diff misses stale headers every time.
