---
name: e2e-browser-test
description: Drive the running neuron-web app in a real browser with Playwright to verify a change end-to-end — storage/custody behaviour, the Storage tab's numbers, two-device transfers, repair and lease expiry. Use when asked to test, verify or reproduce something in the app itself rather than in unit tests; when a TESTPLAN row (T8/T9/T10) needs running; or when a UI figure looks wrong. Face flows cannot be automated — see the limits below.
---

# Testing neuron-web in a real browser

Unit tests cover the pure engine. They could not have caught a single display
defect of 2026-08-16 — uptime disagreeing with the score beside it, an "average"
of one sample, `7/6 renewals`, `LAST REWARD -59066340h ago` — because each half
was individually correct and only the *rendered combination* was wrong. Nor
could they catch the signature mismatch that silently killed content
distribution, because both sides passed their own tests. **Those live here.**

## Before anything: is the stack up?

These specs attach to a running stack; they never start one. Starting it here
would churn `.relay-data/` — the relay's peer id is baked into every client's
bootstrap addrs, so a regenerated one makes the whole repo unable to find it.

```powershell
# PowerShell is primary. `VAR=x cmd` is bash-only and silently sets NOTHING here.
npm run dev
$env:STORAGE_TIMING = 'fast'; npm run dev    # 2-min beat / 12-min epoch / 6-min lease
```

Check before running specs — a 000 means nothing is listening:

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5173/relay-info
```

## Run

```powershell
npm run e2e                     # headless
npm run e2e:headed              # watch it
npx playwright test e2e/smoke.spec.ts          # harness self-check, needs no account
npx playwright test -g "uptime"                # one test by name
npx playwright show-trace test-results\<dir>\trace.zip   # after a failure
```

`e2e/smoke.spec.ts` needs **no captured session**. Run it first whenever
anything looks broken: it separates "the harness is wrong" from "the app is
wrong", and a suite that skips everything for want of a fixture looks identical
to one whose harness is dead.

## Accounts are created by the specs — no capture step

`newAccountDevice('alice')` opens a device and gives it a brand-new account in
~4 seconds, with no human. It drives the REAL creation flow — same buttons,
same PIN dialog, same attestation, same v3 blob and Shamir split — with only
the camera replaced by a seeded synthetic descriptor
(`src/core/test-face.ts`, ⚠ dev-only, on the remove-before-production list).

**The stack must be started for it:**

```powershell
$env:LOCAL_ONLY = '1'; $env:TEST_FACE = '1'; $env:STORAGE_TIMING = 'fast'; npm run dev
```

- `TEST_FACE=1` bakes the synthetic-face flag. Without it the client constant is
  `false`, the app opens a real camera, and `createAccount` fails immediately
  with the remedy rather than hanging on a capture nobody is performing.
- `LOCAL_ONLY=1` is what makes repeated runs possible. The cloud relays cap
  attestation at **24 per IP per 24h** (`IP_MAX_PER_DAY`), and a day's debugging
  exhausts it — every later creation then fails with
  `only 0 attester relay(s) responded` behind two 429s. The local relay exempts
  local IPs ("local dev never limited"), and `LOCAL_ONLY` also sets
  `REQUIRED_ATTESTERS` to 1, so the local relay alone satisfies the quorum.
  Tests should not be spending the shared relays' Sybil quota anyway.
- On a `LOCAL_ONLY` stack the only archive the client reaches is the local
  relay. `RELAY_BASES` still lists the cloud boxes, and the archive assertions
  accept ANY base holding the record, so they pass either way.

Two limits are **per human, and a seed is a human**: `FACE_MAX` allows 3
accounts per face on testnet, and a username belongs to the nid that claimed it.
`E2E_RUN` tags every identity per run so neither is re-used — without it a
re-run fails with `Face limit reached (3/3)` or a 409, both of which read as
broken code rather than exhausted quota.

**Still manual:** recovery-share release. The synthetic path returns before
`onPass` fires, so it produces no trajectory proof — by design.

## The two log streams — confusing them costs a cycle

| stream | carries | how to read |
|---|---|---|
| `console.*` | `[StorageManager]` / `[SmokeStore]` / `[Node]` — where storage narrates itself | `device.log.waitFor(/…/)` |
| `addLog()` | the in-app panel: `Node started`, `Heartbeat sent for alice` | `appLog(device)` |

**They do not overlap.** `addLog` writes to a DOM buffer and never reaches
console, so waiting on one of its strings via `device.log` hangs forever — which
looks exactly like the feature not running. `appLog()` opens the panel, which
replays the whole buffer, so history is included.

## Two contexts are two devices

A browser context has its own IndexedDB and localStorage, which is what makes it
a separate node. Two contexts reproduce the manual Chrome/Edge setup on one
machine and talk over **loopback WebRTC** — sidestepping the carrier NAT that
makes phone testing need TURN.

```ts
const a = await newAccountDevice('alice');
const b = await newAccountDevice('bob', { channel: 'msedge' });
```

⚠ **Custody is per-device.** A seeded session carries an account that is
registered as a provider on whichever device registered it. Heartbeats, rewards
and cache requests all fail *closed* elsewhere, so a second context holding the
same account serves nothing and the row explains why. **Never drive the same
account from two contexts at once** — two writers on one chain fork it, and a
forked account is frozen permanently, not flaky.

Run serial, one worker. The config enforces it; do not raise it.

## Helpers (`e2e/device.ts`)

- `openDevice(name, opts)` — launches, waits for the node, attaches console capture
- `openStorageTab(d)` / `storageStats(d)` — the stat chips as a label→value map
- `providerRow(d, 'prefix')` — a provider's row as rendered text
- `newAccountDevice(name, opts)` — a device with a brand-new account, no human
- `createAccount(d, username, pin)` — the creation flow on an open device
- `profileDir(name)` — a persistent profile path, OUTSIDE the repo: Vite watches
  the project tree and a live Chrome holds `Default/Network/Cookies` locked, so
  a profile inside it throws EBUSY and takes the whole dev server down mid-run
- `waitForGossipMesh(d)` — waits for a circuit-relay reservation. A fresh
  profile starts with no mesh, and an announcement published into that gap is
  never delivered; the archive gets it minutes later, which reads as "the
  archive never got it"
- `uploadFile(d, name, bytes, seed)` — uploads and returns the CID
- `serveStorage(d, capacityGB)` — registers and waits for the FIRST heartbeat,
  i.e. the lease; a registration without one is not custody
- `contentLibrary(d)` — the device's own-files rows, as rendered
- `relayFiles(base, params)` / `RELAY_BASES` — the archives' `/files` answer
- `appLog(d)` — the in-app panel's lines
- `d.log.waitFor(re, ms)` / `.all(re)` / `.none(re)` — `none()` is the one specs forget

`uploadFile` seeds its bytes: content addressing means a constant buffer yields
the same CID every run, so a "new" upload would dedupe against the last test's
content and nothing would transfer.

## Writing a spec that means something

- **Assert what a human would see.** Read rendered text, not internals. The
  defects that reached production were all in the rendering.
- **Prefer a logical assertion to a screenshot.** Almost everything here is
  decidable in code — rendered text, a log line, an archive's JSON — and a
  screenshot only defers the judgement to a human. Keep images for what is
  genuinely visual: overlay alignment, letterboxing, a banner covering a
  control. (One of those bit this suite: a fixed warning bar sat over the tab
  strip and swallowed clicks until it was given `pointer-events:none`.)
- **Check the identifier is rendered in full before matching on it.** The
  content library ELIDES CIDs (`bafkrei…c6xf6fq`), so `toContain(cid)` can never
  match — and a negative assertion written that way passes for that reason
  alone. Match a filename, and assert the positive case too, so the negative
  cannot pass by rendering nothing.
- **Assert the impossible cannot appear** — a numerator above its denominator, a
  negative duration, a score above its uptime. Those catch a whole class, not one
  field, and each one here is a real bug that shipped.
- **Use `d.log.none()`** for rejections that must not happen. A silent `return`
  and a message that never arrived look identical from outside; that ambiguity
  cost most of a day.
- **Timing specs must state the profile.** A compressed profile is a consensus
  input; a custody assertion is meaningless without knowing which clock ran.
  `smoke.spec.ts` asserts the profile is reported at all.
- Long waits are real here: a 6-minute lease, a 100 MB WebRTC pull. Set
  `test.setTimeout()` per spec rather than raising the global floor.

## Current specs

- `e2e/smoke.spec.ts` — harness self-check, no fixture needed
- `e2e/storage-ui.spec.ts` — the display defects of 2026-08-16, as regressions
- `e2e/custody.spec.ts` — TESTPLAN T9 (handoff, repair, lease lapse)
- `e2e/file-index.spec.ts` — TESTPLAN T10; its step 1 queries the relays from
  Node, not through the page, because reading the archive through the client
  under test proves nothing about which of the two holds the index

## TESTPLAN rows

`docs/TESTPLAN.md` T8/T9/T10 are written for two devices, and for T9 step 1
that is **wrong**: `MIN_REPLICAS` is 2 and the uploader never counts itself, so
`Handoff complete` needs the uploader plus TWO other live providers — three
sessions. Steps 2–6 need two. T9 step 5 needs a >6-minute absence under `fast`
timing (the spec skips itself on the production clock rather than asserting
something unreachable). T1–T7 involve faces and stay manual.

**A restart needs a persistent profile.** `storageState` carries localStorage
only, so re-opening a context gives a device with an empty IndexedDB — no
cached CIDs, no chain. That is a wiped machine holding the same keys, not a
restart, and a rejoin test against it discards nothing and passes vacuously.
Pass `userDataDir` (and `fresh: true` to wipe deliberately):

```ts
const b = await openDevice('bob', {
  storageStatePath: 'e2e/.sessions/bob.json',
  userDataDir: 'e2e/.profiles/bob',   // survives close(); seeded on first boot
});
```
