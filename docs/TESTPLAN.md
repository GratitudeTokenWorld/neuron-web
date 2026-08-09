# Manual E2E test plan — two-relay dev network

The features that need a real face + camera cannot be automated; this is the manual
matrix. It exercises everything the 197-test suite cannot: live libp2p transport,
cross-relay federation, the camera/liveness pipeline, and multi-browser sync.

**Topology under test:** 2 cloud relays (super-node archive + attester each) +
your local dev relay + 2 browser profiles.
Provisioning: [CLOUD.md](CLOUD.md); box setup: `scripts/setup-relay-box.sh`.

| Relay | IP | peerId |
|---|---|---|
| relay-1 | `80.97.27.224` | `12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh` |
| relay-2 | `80.97.27.112` | `12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU` |

## Before you start

Both relays are already the **baked defaults** (bootstrap list in `vite.config.ts`,
dev-relay federation in `relay/vite-plugin.ts`), so plain `npm run dev` is enough.
The env vars below exist to *override* the targets (e.g. pointing at replacement
boxes — get peerIds from `curl http://<IP>:9092/relay-info`):

```powershell
npm run dev    # defaults already point at both relays above

# only to override:
$env:PEER_RELAYS = '/ip4/<IP1>/tcp/9091/p2p/<PEERID1>,/ip4/<IP2>/tcp/9091/p2p/<PEERID2>'
$env:BOOTSTRAP_ADDRS = '/ip4/<IP1>/tcp/9090/ws/p2p/<PEERID1>,/ip4/<IP2>/tcp/9090/ws/p2p/<PEERID2>'
```

Rules that will save you a debugging session:

- **Open the app at `http://localhost:5173` — not the LAN IP, not the tunnel.**
  `localhost` is a secure context (camera works) that still allows plain `ws://` and
  `http://` to the raw-IP relays. The `https` tunnel would block both as mixed content.
- Two "users" = two browser *profiles* (or normal + incognito), so each has its own
  IndexedDB. Same machine is fine.
- Relay logs while testing: `ssh ubuntu@<IP> "pm2 logs neuron-relay --lines 50"`.
  Attestations log as `[Attester] personhood attestation acct=…`, archived blocks as
  `[Archive] Stored …` (with `DEBUG_ARCHIVE=1`).
- Testnet face limit is **3** accounts/face (`FACE_MAX_TESTNET`); mainnet is 1.
  Slots are provisional: a verify that never produces an open block is released
  after 5 min, so abandoned attempts no longer burn the limit.
- A 1–2 account network stays at optimistic `confirmed`, not `final` — committee
  finality needs a real validator population. **Not a bug.**

## T1 — Account creation with 2-of-2 attesters (the previously-broken flow)

The build defaults to `REQUIRED_ATTESTERS=2` (non-LOCAL_ONLY), so account creation
*must* reach two distinct attesters or fail with "Need 2 independent attesters".

1. Browser A → Create Account → username `alice` → face + PIN enrollment.
   The capture UI shows a **six-box step tracker** (0 = setup, 1–5 = the five
   actions; each turns green with a checkmark as it completes), a centre-out
   green bar, a rising tone, and a wireframe guide over the (mirrored) feed.
   The feed is 90% of viewport width on mobile and 50% of viewport height on PC. It runs a **setup stage** first — frame your
   head ("move closer" / "move back" / "hold your head level"), then a
   **three-leg depth sweep: closer → back → closer** — a white inner ring tracks
   your distance and lands exactly on the dashed target oval at 100% (and
   shrinks back on the "move back" leg) — which dials in the distance
   *and* proves the face is three-dimensional (the perspective must reverse on
   demand, three times); exactly one face must be in shot throughout — then
   a **"relax your face"** baseline taken at that settled distance, then **five
   actions in a random order drawn per enrollment** — smile, open mouth, raise
   eyebrows, close eyes, and a head turn — each animated, each with a 12 s budget and each
   requiring the action to be **held ~0.3 s** (a momentary flicker does not
   count); then **capture** — hold still for 3 samples. The drawn order is
   written to the app log (`challenge sequence …`) — check it differs between runs.
   **Continuity:** from the first action to the last sample your face may not
   leave the frame for more than **1 s** — gaps between stages included. Worth
   testing deliberately: cover the lens for ~2 s mid-sequence and confirm the run
   aborts with "face left the frame" rather than continuing.
   **Anti-spoof checks worth trying:** sliding your body sideways must NOT satisfy
   the head turn (expect "turn, not slide"); holding a photo up must fail every
   action. The **setup depth sweep** is the strongest of them — a real head changes
   *shape* as it approaches (the eyes are nearer the lens than the jaw, so they
   magnify faster), while a phone, tablet or print is flat and merely scales.
   Two spoof tests worth running deliberately: (a) hold a face on a phone screen
   and move it toward the camera — size grows, shape does not, expect **"flat
   image detected"**; (b) have a second person step into frame, or hold a photo
   beside your own face — expect **"only one face in frame"**.

   > **(b) is the one that broke.** Until `SOLO_SCORE`, only the setup stage
   > looked for a second face; the actions and capture used `detectSingleFace`,
   > which does not fail on two faces — it returns the highest-scoring one. A
   > live head could perform every action while a photo beside it supplied the
   > enrolled descriptor. Run (b) at **every** stage, not just setup: during an
   > action, during a between-action pause, and during the three capture samples.
   > Each must abort with "only one face in frame".
   >
   > **Limits, so this is not over-trusted:** the detector finds *faces*. It has
   > no concept of a phone, a tablet or a hand — an object only registers if a
   > face is visible on it and scores above `SOLO_SCORE` (0.3). A small, dim, or
   > angled photo can still fall under that bar. The depth sweep, not this gate,
   > is what catches a screen presented *as* the face.
2. During "Contacting relay nodes": expect challenges from ≥2 relays. The status
   panel then shows `2/2` (or `3/3`) independent attestations.
3. **Pass:** account opens; balance = 1,000,000 UNIT.
4. **Cross-relay dedup:** watch both relays' logs — each should log the attestation.
   The nullifier from attester #1 is what the open block commits.
5. **Fail signatures to watch for** (the old bugs):
   - `1/2 attestations` → the client couldn't reach attester #2. Check
     `http://80.97.27.112:9092/relay-info` returns `signingPub`, and that the browser
     console shows no CORS error on `/face-verify/challenge` (needs `x-network` in
     `Access-Control-Allow-Headers` — fixed in `624d0d8`).
   - Attestation succeeds but account invisible in Browser B → see T2.

## T2 — Account sync across relays (the "did not sync" bug)

1. Browser B (other profile) → create `bob` (same face is fine on testnet, limit 3).
2. In Browser A, look up `bob` (search/profile). **Pass:** bob's account + username
   resolve in A within ~10 s without either browser talking to the other directly
   (close B's tab first for a stricter test: A must get bob's chain from a relay
   archive, not from B).
3. Reload Browser A (F5). **Pass:** alice persists, balance intact, no re-enrollment.
4. `curl http://80.97.27.224:9092/relay-info` and RELAY2: same `generation`, and both
   relays' logs show bob's open block archived (`[Archive] Stored open …`).

## T3 — Transfer (the "transfers did not work" bug)

Background: a transfer is sender `send` block + recipient `receive` (claim) block.
The recipient claims via the unclaimed-receive sweep (`autoClaimPending`) — the fix
history here is `6ca3d64`, `97e1c9d`, `e99abc4` (claim ordering/replay).

1. Browser A: send 1,000 UNIT to `bob`. **Pass (sender):** alice's balance drops
   immediately; block status `pending` → `confirmed` after the challenge window.
2. Browser B (open): **Pass (recipient):** bob's balance rises without manual action
   within ~15 s (auto-claim sweep).
3. **Offline-recipient variant:** close B entirely; A sends another 1,000. Reopen B
   after a minute. **Pass:** the sweep claims the pending send on startup — balance
   includes it.
4. Reload both browsers. **Pass:** balances identical after reload (claims are
   on-chain, not local state).
5. **Double-spend guard (fraud proofs):** nothing to do manually — but if a balance
   ever *rises* on reload, capture both browsers' logs + relay archives immediately.

## T4 — NFTs (native ownership — this is the "smart contract" surface)

> ⚠ There is **no contract VM to test**: `createDeploy`/`createCall` are deferred
> stubs returning "not available", *by design* (ARCHITECTURE.md rejects a general VM;
> content ownership is native NFTs instead — B1/B2 commits). Test NFTs:

1. Browser A: mint an NFT (content + metadata). **Pass:** NFT appears with alice as
   owner; visible from Browser B after sync.
2. A transfers the NFT to `bob`. **Pass:** ownership flips in both browsers;
   same-browser receive works (`97e1c9d`); bob can see/render the content.
3. B burns it (if UI exposes burn). **Pass:** gone from both.
4. Reload both. **Pass:** ownership state survives.

> **All three face flows share one anti-spoofing path** (`challengeAndCapture`):
> account creation, **recovery** (T5) and change-face (Security settings) each run
> liveness → 3 random challenge actions → 3 capture samples under one presence
> guard. Recovery is the one that hands over the keys and the key-blob is public
> by design, so it gets the same treatment as enrollment — expect the full
> sequence when testing T5, not just a face scan.

## T5 — Recovery after wipe (redundant durability)

1. Browser B: note bob's balance. Wipe site data completely (DevTools → Application
   → Clear storage), or use a third profile.
2. Recover bob: username + face + PIN. **Pass:** account restores with full balance
   and history — key-blob served from a relay archive (`c9ac182`), chain from the
   delta archive. Do this once with relay #1 stopped (`pm2 stop neuron-relay`) to
   prove relay #2 alone suffices; restart afterwards.

## T6 — Username uniqueness + face limit

1. Third profile: try creating another `alice` (different face if you have a
   volunteer; same face otherwise). **Pass:** rejected — username already attested
   (`6f6317b`, per-human `nid` claim `5befd13`).
2. Create accounts with the same face until the testnet limit (3) is exceeded —
   the 4th must be rejected. **Pass:** attester returns the face-limit error and
   the client shows it cleanly.
   Note the count is **per relay** (each keeps its own face DB), so a create that
   reaches only one attester leaves the two boxes' counts out of step; check both
   if the rejection point surprises you.

## T7 — Operators & reset (do this LAST)

The first 3 accounts attested by a fresh relay become its operators (`.relay-operators.json`).

1. `curl http://80.97.27.224:9092/relay-info` → `operators` contains alice (first 3).
2. From a *non*-operator profile: Reset Testnet. **Pass:** relays ignore it (only
   that browser clears + resyncs).
3. From alice (first account in that browser): Reset Testnet. **Pass:** both relays
   wipe (`[Archive] WIPED by operator`), `generation` increments on both
   `/relay-info`, and every open browser clears on next refresh.

## Result log

| # | Test | Result | Notes |
|---|------|--------|-------|
| T1 | 2-attester account creation | ☑ | |
| T2 | Cross-relay account sync | ☑ | |
| T3 | Transfers + offline claim | ☑ | |
| T4 | NFT mint/transfer/burn | ☑ | Reload loss fixed in `482ac05` — replay order across accounts |
| T5 | Recovery after wipe (1 relay down) | ☑ | |
| T6 | Username uniqueness + face limit | ☑ | |
| T7 | Operator-gated reset | ☐ | Skipped by decision — reset is a dev-mode affordance |

File failures with: browser console log, `pm2 logs` from both relays, and which
browser/profile was which account.
