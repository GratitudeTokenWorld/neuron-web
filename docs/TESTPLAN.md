# Manual E2E test plan — two-relay dev network

The features that need a real face + camera cannot be automated; this is the manual
matrix. It exercises everything the 470-test suite cannot: live libp2p transport,
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

- **On a desktop, open the app at `http://localhost:5173` — not the LAN IP.**
  `localhost` is a secure context (camera works) that still allows plain `ws://` and
  `http://` to the raw-IP relays. A LAN IP is *not* a secure context, so the camera
  is refused outright.
- **On a phone, the `npm run tunnel` URL is the only option, and it now works.**
  Face capture needs a secure context, so there is no `http://` route to a camera
  on a phone. The tunnel is `https`, which used to block every plain-`http://`
  call to the raw-IP relays as mixed content — silently reducing account creation
  to *"1 of 2 attesters responded"* and leaving the phone with only the
  same-origin dev relay for every archive query. The dev server now proxies each
  bootstrap relay under `/dev-relay/<n>` so both work. ⚠ That proxy is a **dev-only
  workaround that must be deleted before any shipped build, testnet included** —
  CLAUDE.md → *Remove before production*.
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

> **Expect `3 attestation(s) collected`, not 2** — that is correct, and it
> confuses everyone once. The dev topology has **three** attesters: the two
> cloud relays *plus your auto-spawned local dev relay*, which is a full
> attester with its own key and `signingPub`. `REQUIRED_ATTESTERS` is the
> quorum *minimum*; the client collects from every attester it can reach.
> Browsers never attest — a browser node has no signing key and no
> `/face-verify` endpoint, so a second browser profile adds nothing here.
> Production builds bake only the two cloud relays.
>
> Since v3 the same three relays also each receive a **Shamir share** of the
> account's recovery secret (`[Recovery] share stored … nid=…` in each log).
> Creation **aborts** if fewer than `REQUIRED_ATTESTERS` accept a share — an
> account whose share can never be reconstructed is unrecoverable by
> construction. Creating while a relay is down yields a narrower split; the
> client self-heals it later (SUPERNODE.md → share refresh).

1. Browser A → Create Account → username `alice` → face + PIN enrollment.
   The capture UI shows a **seven-box step tracker** (0 = setup, 1–5 = the five
   actions, 6 = capture; each turns green with a checkmark as it completes), a
   centre-out green bar, a rising tone, and a wireframe guide over the
   (mirrored) feed. Boxes **0 and 6 are the two phases made of three sub-steps**
   (the three depth legs; the three capture samples) and fill a third of the box
   at a time, left to right, so neither looks stalled while you complete three
   separate things. The run ends with box 6 ticked and the bar full at both
   edges (plus the confirmation chime) — held briefly so it can be seen.
   The feed is 90% of viewport width on mobile and 50% of viewport height on PC. It runs a **setup stage** first — frame your
   head ("move closer" / "move back" / "hold your head level"), then a
   **three-leg depth sweep: closer → back → closer** — a white inner ring tracks
   your distance and lands exactly on the dashed target oval at 100% (and
   shrinks back on the "move back" leg), while the two small arrows above and
   below say which WAY to travel: they point and drift **inward** to tighten the
   shot on a "move closer" leg and **outward** to widen it on "move back" (the
   ring is a distance readout, the arrows are the instruction) — which dials in
   the distance
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
   aborts with "Out of frame or too dark!" rather than continuing.
   (Same message covers a dark room — the detector cannot tell the two apart,
   and a covered lens must stay a failure, so they share one wording.)
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

> **Changed by G1 (2026-08-09):** clients no longer ingest the global `accounts`
> topic. Browser A learns about `bob` **on demand** — the explorer search / send
> flow calls the relays' `GET /resolve?username=bob` and verifies the record's
> signature locally. So bob will NOT appear in A spontaneously; he appears when
> A first searches for or sends to him. Sanity-check the endpoint directly:
> `curl "http://80.97.27.224:9092/resolve?username=bob&network=testnet"` (expect
> the JSON record within ~20 s of bob's creation — the owner's publish tick).
> Also expect `[Archive] Stored account record user=…` in relay logs with
> `DEBUG_ARCHIVE=1`.

1. Browser B (other profile) → create `bob` (same face is fine on testnet, limit 3).
2. In Browser A, **search for `bob`** (explorer search) or start a transfer to
   him. **Pass:** bob's account + username resolve in A within ~10 s without
   either browser talking to the other directly (close B's tab first for a
   stricter test: A must get bob's record from a relay `/resolve` and his chain
   from a relay archive, not from B).
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
   > **How this works post-G1:** the client asks the relays
   > `GET /pending-sends?pub=<bob>&network=testnet` on startup / recovery / every
   > 60 s, then delta-pulls each reported sender's chain (fully verified — the
   > relay's answer is only a hint). Probe it directly with curl if a claim
   > seems stuck. The pre-G1 build found offline sends only by accident: the
   > O(N) accounts firehose taught every device every account, and the startup
   > refresh pulled every chain.
   **Wiped-recipient variant (the 2026-08-09 regression):** close B, A sends,
   then recover bob in a FRESH private window (full wipe). **Pass:** after
   recovery, bob's balance includes the pending send within ~90 s (recovery
   `/pending-sends` check + delta pull + challenge window + sweep), and the
   send's TX appears in bob's explorer (he now holds alice's chain).
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

> **Changed by the v3 custody split (2026-08-15) — the whole flow needs a
> re-run.** Accounts are sealed under face+PIN+**recovery share**; the share is
> **Shamir 2-of-n across the attesters**, so recovery must satisfy **two**
> relays. Each draws its OWN ordered action sequence
> (`POST /recovery-share/challenge`) and the capture performs both back to back
> in one presence-guarded session — so on a fresh device expect a **longer
> sequence than enrollment** (setup + 3 actions per relay + 3 capture samples),
> with the drawn sequences written to the app log. The old keyblobs gossip is
> gone: the blob arrives via `GET /keyblob`. Watch the relay logs — expect
> `[Recovery] share released acct=… x=N` on both, and
> `[Recovery] release DENIED … (trajectory rejected: …)` on a refused attempt.

1. Browser B: note bob's balance. Wipe site data completely (DevTools → Application
   → Clear storage), or use a third profile.
2. Recover bob: username + face + PIN. **Pass:** account restores with full balance
   and history — key-blob via `GET /keyblob`, share released after the relay-side
   face match, chain from the delta archive. Do this once with relay #1 stopped
   (`pm2 stop neuron-relay`) to prove relay #2 alone suffices (every relay holds
   the full share, not a fragment); restart afterwards.
   **New negative checks, run deliberately:**
   - Wrong-face release: have a second person attempt bob's recovery with the
     right username + PIN. **Pass:** "No relay released the recovery share:
     face does not match this account", relay logs `release DENIED`, and after
     3+ attempts the relay answers with a lockout (`locked - try again in Ns`) —
     wiping the browser must NOT reset that timer (it lives on the relay).
   - **Photo release (the attack the trajectory gate closes):** hold a printed
     or on-screen photo of bob and attempt recovery with the right PIN. It should
     fail at the capture stage (the depth sweep or an expression it cannot
     perform); if a photo ever gets past the client, the relay must still refuse
     with `trajectory rejected: …`. **Pass:** no share released, either way.
   - **One relay down still recovers** (Shamir any-2-of-3): stop one cloud relay,
     recover — the local dev relay + the remaining cloud relay supply the two
     shares. **Pass:** recovery completes.
   - PIN-only offline attack is dead by construction (pinned by the v2-control
     test in `src/core/face-match.test.ts`) — nothing to test manually.
3. **PIN change / face change on a fresh device** (v3): both require the cached
   share, so straight after a wipe they must refuse with "run Recover Account
   once" — and work again after one successful recovery. **Pass:** both
   behaviours observed.
3. **Recover under DIFFERENT lighting from the one you enrolled in** — this is the
   case that used to fail, so it is now part of the pass condition, not a bonus.
   Enroll a fresh account in a dim room (lamp off, curtains drawn), then recover it
   in good natural light, and once the other way round. **Pass:** both recover.

   > **Verified 2026-08-15, both directions:** dim → natural light `distance=0.295
   > margin=0.155 PASS`; bright → dim `distance=0.285 margin=0.165 PASS`. Both
   > measure ~0.51 quantized, so both failed before the fix. The two agreeing to
   > within 0.01 is the point — a lighting change costs a stable ~0.29 either way.

   > Recovery compares the live scan to the stored canonical on **raw** descriptors
   > at 0.45 — the same threshold the relay's Sybil check uses. It previously
   > compared the *quantized* pair, which enforced ~0.21 raw and made a dim-room
   > account unrecoverable in daylight by its own owner (`src/core/face-match.test.ts`
   > pins the regression). Existing accounts need no migration: the stored
   > descriptor never changed, only the gate.
   >
   > With `localStorage.neuron_debug = '1'` the flow logs two `[face]` lines that
   > must be read together — enrollment quality, and the distance recovery
   > actually decided on:
   >
   > ```
   > [face] enroll quality spread mean=… max=… (warn 0.23, reject 0.45) luma=…
   > [face] recovery match distance=… threshold=0.45 margin=… PASS/FAIL
   > ```
   >
   > **The second line is the one that matters.** Capture it for every recovery,
   > passing or failing: a threshold can only be judged against the spread of
   > distances real successes produce, and a bare failure cannot distinguish a
   > stranger (~0.9) from the owner missing by a hair (0.46).
   >
   > Enrollment spread does **not** track lighting — measured 2026-08-15, a dim
   > room with a phone flashlight scored *better* (max 0.150) than decent natural
   > light (0.154), and luma read 147 vs 172 because auto-gain hides darkness. So
   > `ENROLL_SPREAD_LIMIT` stays a backstop against captures that cannot work at
   > all, not a lighting gate. A rejected capture shows *"The captures of your face
   > did not agree with each other"* and enrolls nothing.

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

## Running T8–T9 in a sitting: compressed timing

At production timing one storage cycle is a day, so T8 step 5 and T9 step 5 are
untestable in one session. `STORAGE_TIMING=fast` divides every storage duration
by 120 — 2-minute heartbeat, 12-minute reward epoch, 6-minute lease — leaving
every ratio identical, so the rules exercised are the rules that ship.

```powershell
# 1. WIPE FIRST. epochDay = floor(ts / REWARD_EPOCH_MS), so an existing chain's
#    epoch numbering is meaningless under the other profile.
#    (Relay side: docs/SUPERNODE.md → Resets. Client side: clear site data.)
# 2. Restart the dev server. BOTH devices load from it, so both get the profile.
$env:STORAGE_TIMING = 'fast'; npm run dev

# `VAR=x cmd` is bash-only and sets NOTHING in PowerShell. In Git Bash use:
#   STORAGE_TIMING=fast npm run dev
# `$env:` persists for the window: Remove-Item Env:STORAGE_TIMING to undo.
# 3. Restart the tunnel too if a phone is testing — `npm run tunnel` mints a NEW
#    trycloudflare hostname each start, and a phone left on the old URL fails
#    every same-origin archive query with ERR_NAME_NOT_RESOLVED.
npm run tunnel
```

**Confirm before testing, two ways:** the app log shows
`⚠ Storage timing: FAST (2min beat / 12min epoch / 6min lease)` at startup — on
the phone too, so no DevTools needed — and the Storage tab shows a ⚠
`Timing fast (2m beat)` chip. Both must appear on *both* devices. If one is missing it, that device is on production
timing and will reject the other's reward blocks mid-chain — the two will look
like they are on different networks, because in the way that matters they are.

Timings below are written at production values; divide by 120 under `fast`
(4h → 2min, 24h → 12min, 12h lease → 6min).

## T8 — Storage provider lifecycle (NOT YET RUN)

Storage runs on the engine as of 2026-08-15. Two devices, each with an account.

1. **Register.** Storage tab → pick an account, capacity, Serve.
   **Pass:** your row appears with the declared GB, `RATE/DAY` **0** (you hold no
   bytes — declared capacity earns nothing), and `UPTIME` 100% / `SCORE` 1.000
   (one heartbeat was due, one was sent).
2. **Discovery.** On the *other* device, open the Storage tab.
   **Pass:** the first device appears within ~15 s, with its capacity, and with
   `—` in UPTIME / SPOT CHECK / SCORE / RATE / EARNED. Those dashes are correct:
   that node holds none of the other's chain and has fetched nothing from it yet.
   (Discovery is `GET /providers` — it does **not** arrive by gossip; the two
   accounts are almost certainly in different shards.)
3. **Heartbeat interval.** Immediately hit Serve again on the same account.
   **Pass:** refused with `Heartbeat interval not reached (next in ~239min)`.
4. **Deregister.** Stop Serving. **Pass:** the row disappears on both devices
   (the other within one discovery poll). Re-register and heartbeat: **Pass:** it
   is still refused until the 4h interval elapses — deregistering must not reset
   the clock (that bug paid a full day's reward for 60 s of work).
5. **Reward.** Needs a provider registered before an epoch boundary, heartbeats
   through that epoch, and a claim in the next one (rewards settle one epoch
   behind and pay only for bytes actually held). **Run this under
   `STORAGE_TIMING=fast`**, where an epoch is 12 minutes: register, upload
   something so the provider actually holds bytes, wait out an epoch boundary,
   and watch for `[StorageManager] Reward issued: <n> milli-UNIT`.
   **Pass:** the amount equals `1000 × storedGB × countedHeartbeats/6`, and a
   second claim for the same epoch is refused (`epoch N already rewarded`).
   **Also check:** the claim names the epoch *before* the block, never the
   running one — a claim for the running epoch would pay a fraction of what was
   earned and close the epoch permanently.

## T9 — Publish handoff and repair (NOT YET RUN)

Lease + repair and the publish handoff landed 2026-08-15. Everything below is
observable in the console; the policy itself is unit-tested
(`src/engine/content/custody.test.ts`, `src/engine/sim/repair.test.ts`), so what
this checks is the WIRING — which is the half no test covers.

Two devices, A (uploader) and B (registered storage provider, serving).

1. **Handoff completes.** On A, upload a small file to the Storage tab.
   **Pass:** `[StorageManager] Cache request published…`, then B logs
   `[StorageManager] Cached …`, and A logs
   `Handoff complete for <cid>… (N live holders) — safe to close`.
   The count is **live** holders — B must have a current lease for it to rise.
2. **Staging is durable.** Stop B (or upload while no provider is live). **Pass:**
   A logs `… is STAGING on this device only` and the CID is still retried after a
   **page reload** — the record is persisted, not in memory. Start B: the retry
   loop hands it over and the handoff-complete line appears without a re-upload.
   (Before this, closing the tab right after an upload destroyed the content.)
3. **Repair on read failure.** With the file replicated, stop B, then open the
   file on A. **Pass:** the read fails once and A logs
   `Read failed for <cid>… — repairing now (N live holder(s))` and immediately
   re-replicates rather than waiting for a timer. Nothing should be polling B in
   the meantime — repair is triggered by USE, not by watching.
4. **One flaky fetch is not data loss.** Watch a spot-check round while B is
   briefly unreachable (e.g. its relay reconnects). **Pass:** no eviction on the
   first failure; only a second consecutive failure logs
   `Evicting <pub>… after 2 consecutive failures`. A single failure followed by a
   success must leave the holder set unchanged.
5. **Rejoin past the lease discards.** Stop B for more than one lease —
   **12 h at production timing, 6 minutes under `STORAGE_TIMING=fast`** — then
   start it. **Pass:** B logs
   `Rejoin <pub>…: lease lapsed …h ago … discarding N CID(s)`, its stored bytes
   drop to ~0, and its free space on both devices' Storage tabs rises to the
   full declared capacity. Restarting B inside 12 h instead must log
   `lease live — keeping all N CID(s), no re-transfer needed` and delete nothing.
6. **Lapsed holders stop counting.** While B's lease is lapsed, watch A's
   re-replication line. **Pass:** it reads `at 0/10 live (1 confirmed ever)` —
   the count that drives repair is live leases, and a holder that once confirmed
   is explicitly not one.

## T10 — File index is no longer global (NOT YET RUN)

The last `O(N)` in storage closed 2026-08-15: clients used to ingest and persist
a record for every file on the network. **Needs a relay deploy** — `GET /files`
is new.

1. **Archives answer.** `curl "http://80.97.27.224:9092/files?network=testnet"`
   **Pass:** `{"records":[…],"total":N}` on both relays; `total` is that
   archive's own count, not a network figure.
2. **A client holds only its own.** On device B (which owns no files), open the
   Storage tab and check `node.storage.getFileIndex().size` in the console.
   **Pass:** 0, while device A's upload is visible in `/files` on the relays.
   Before this change B would have held A's record.
3. **The migration runs once.** On a device that ran an older build, watch the
   startup log. **Pass:** `Dropped N foreign file record(s) — the index is
   own-files-only now`, once, and 0 on the next start (the IDB store is the
   thing that had to be emptied; filtering live gossip alone would have left it).
4. **The stat is honest.** Storage tab → the chip reads **Files (archived)** and
   shows `—` until an archive answers, never `0`.
5. **Withdrawal propagates.** Delete a file on A. **Pass:** `/files?cid=<cid>`
   on both relays returns the record with `"removed":true` (a tombstone, not an
   absence — a holder has to be able to *learn* the file was withdrawn).

## Result log

| # | Test | Result | Notes |
|---|------|--------|-------|
| T1 | 2-attester account creation | ☑ | Re-verified 2026-08-15 on v3: 3 attestations (2 cloud + local dev relay) and a **2-of-3 Shamir split** stored on all three (`[Recovery] share stored` ×3, x=1/2/3) |
| T2 | Cross-relay account sync | ☑ | Through G1 `/resolve` (on-demand, not spontaneous) |
| T3 | Transfers + offline claim | ☑ | Through G2 `/head-proof` packets; offline **and** wiped-recipient variants |
| T4 | NFT mint/transfer/burn | ☑ | Re-verified 2026-08-10 incl. the A→B→A round trip: ownership sticks across refreshes and the claim lands without one. Discovery via inbox signal + `/pending-sends`; claims verify transfer packet + `/token` mint proof |
| T5 | Recovery after wipe (1 relay down) | ☑ | **Fully green on v3, 2026-08-15**, all four sub-checks. (a) Fresh-device recovery via the face-gated release with all three custodians up — used local x=1 + cloud x=2 and never contacted the third, proving any-2-of-3. (b) Same with relay-2 stopped: `distance=0.158 margin=0.292 PASS`. (c) Photo attempt fails at the action steps before the relay gate is reached; a scripted motionless proof is refused server-side with `ratio 0.02 below 0.9`. (d) **Lockout survives a browser wipe:** 5 scripted bad releases armed a 2-min per-account backoff on all three relays; a completely wiped profile then performed both relay-drawn sequences correctly and was still refused with `locked - try again in 27s`. Note hammering during a lockout does NOT extend it (429 returns before the counter), so escalation costs the attacker real waiting: 3 free, then 30s, 2m, 8m, 32m… to 24h |
| T5.3 | Recovery across a lighting change | ☑ | Both directions verified 2026-08-15: dim→light `0.295`, bright→dim `0.285`, threshold `0.45` (~0.51 quantized — both would have failed before the fix). Pre-v3 run, but the biometric gate it measured is unchanged by v3 |
| T6 | Username uniqueness + face limit | ☑ | Slot counts zero on an operator reset, `nid` preserved |
| T7 | Operator-gated reset | ☑ | Exercised repeatedly in dev (epoch propagates relay→relay in ~60 s) |
| T8 | Storage provider lifecycle | ☐ | **Steps 1–4 not yet run.** Register/discover/interval/deregister were all exercised ad-hoc during development on 2026-08-15 (both devices saw each other, rate correctly 0) but not as a recorded pass. Step 5 (reward) is now runnable under `STORAGE_TIMING=fast` — the open question about a clock backdoor is closed: no backdoor, the whole profile compresses |
| T9 | Publish handoff + repair | ☐ | **Not yet run.** Written 2026-08-15 alongside the lease/repair work. All five steps fit one sitting under `STORAGE_TIMING=fast` (6-minute lease) |
| T10 | File index is no longer global | ☐ | **Not yet run, and BLOCKED on a relay deploy** — `GET /files` does not exist on the cloud boxes yet |
| — | Mobile capture (part of T1) | ☑ | 2026-08-15: account created on a phone through the tunnel. Required three fixes — the capture guide was letterboxed on a portrait feed, close-eyes was unpassable below ~8 fps, and the attesters were unreachable over `https`. Face flows had never been run on a phone before |

**Automated pre-check.** Before the manual matrix, run the live probe — it
covers everything about the archive API that does *not* need a face:

```sh
npx tsx scripts/g1-resolve-smoke.mts    # 55 checks; expect ALL CHECKS PASSED
```

It publishes a signed account record and a real signed sender chain to relay-1
only, then asserts both relays (via federation) resolve the record, reject a
forged higher-`_version` one, report the pending send addressed to an offline
recipient with the right `headIndex`, and serve a `/head-proof` packet that
verifies. A failure here means the manual run will fail too — fix it first.

> Re-runs require deploying the updated relay to both cloud boxes first
> (`git pull && npm install && pm2 restart neuron-relay`, then check `pm2 jlist`
> restart counts again after >60 s — see CLAUDE.md relay caution). If you ran a
> manual (non-operator) wipe, bump the generation and zero the face counts on
> **one** relay per SUPERNODE.md → *Resets*; the follower carries it to the rest.

File failures with: browser console log, `pm2 logs` from both relays, and which
browser/profile was which account.
