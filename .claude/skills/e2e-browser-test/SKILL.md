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

## What cannot be automated, and why

**Account creation.** It needs a live face through a depth sweep and five
randomly-ordered actions. A synthetic video cannot pass it — deliberately, since
defeating the gate with a recording is the attack it exists to stop. Chromium's
`--use-file-for-fake-video-capture` will not help; do not try.

So a device is **seeded from a session captured once by hand**:

```powershell
npm run e2e:capture alice     # create/recover in the window, then press ENTER
```

That saves `e2e/.sessions/alice.json` — **wallet keys, gitignored, treat like
`.relay-*`**. Only localStorage is saved; the chain re-syncs from the archives on
start, the same path a recovered device takes. A captured session survives a
*chain* reset but not an *account* wipe: re-capture after any reset that
destroys accounts.

Specs that need one `test.skip()` without it. That is deliberate — a missing
fixture is not a regression, and a red suite meaning "you did not set up" trains
people to ignore red.

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
const a = await openDevice('alice', { storageStatePath: 'e2e/.sessions/alice.json' });
const b = await openDevice('bob',   { storageStatePath: 'e2e/.sessions/bob.json', channel: 'msedge' });
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
- `uploadFile(d, name, bytes, seed)` — uploads and returns the CID
- `appLog(d)` — the in-app panel's lines
- `d.log.waitFor(re, ms)` / `.all(re)` / `.none(re)` — `none()` is the one specs forget

`uploadFile` seeds its bytes: content addressing means a constant buffer yields
the same CID every run, so a "new" upload would dedupe against the last test's
content and nothing would transfer.

## Writing a spec that means something

- **Assert what a human would see.** Read rendered text, not internals. The
  defects that reached production were all in the rendering.
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

## TESTPLAN rows

`docs/TESTPLAN.md` T8/T9/T10 are written for two devices. T9 steps 1–4, 6 and
T10 are automatable with two contexts; T9 step 5 needs a >6-minute absence under
`fast` timing, so give it a long `test.setTimeout()` or run it by hand. T1–T7
involve faces and stay manual.
