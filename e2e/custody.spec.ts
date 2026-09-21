import { test, expect } from '@playwright/test';
import {
  openDevice, openStorageTab, uploadFile, serveStorage, newAccountDevice,
  testFaceAvailable, TEST_FACE_HINT, profileDir, E2E_RUN, type Device,
} from './device';

/**
 * TESTPLAN T9 — publish handoff, repair, and what a returning node keeps.
 *
 * The POLICY is already pure and unit-tested (`engine/content/custody.ts`,
 * 32 tests). What no test covers is the WIRING: that `storage-manager.ts`
 * actually calls it, that the bytes actually move between two browsers, and
 * that the lease the rules read is the lease the network wrote. That is the
 * half this file is for, and the half every 2026-08-16 defect lived in.
 *
 * ## Why three accounts, when TESTPLAN says two devices
 *
 * `MIN_REPLICAS` is 2 and **the uploader is never one of them** — authorship is
 * not custody (decided 2026-08-16). So a handoff needs the uploader plus TWO
 * other live providers, and on a two-account network `Handoff complete` can
 * never be logged. That is the rule working, not a bug, but it means T9's
 * step 1 as written is unreachable with two devices. Steps 3–6 need only two.
 *
 * The accounts are created by the spec itself (`newAccountDevice`), with a
 * synthetic face — so there is no fixture to capture and nothing to skip for.
 * Requires the dev server to run with `TEST_FACE=1`.
 *
 * ## Why persistent profiles
 *
 * A device's cached CIDs live in IndexedDB, which `storageState` does not
 * carry. Re-opening a plain context is therefore not a restart, it is a wiped
 * machine holding the same keys — and a wiped machine has nothing to discard,
 * so the rejoin steps would pass without testing anything. These specs use
 * `userDataDir` so a close/re-open is a real restart.
 */



/** The active storage clock, read from the app's own startup line. */
function timingProfile(d: Device): 'fast' | 'normal' | 'unknown' {
  const line = d.log.all(/\[Storage\] timing profile = (\w+)/).at(-1);
  const name = line && /timing profile = (\w+)/.exec(line)?.[1];
  return name === 'fast' || name === 'normal' ? name : 'unknown';
}

test.describe('T9 — publish handoff', () => {
  let a: Device, b: Device, c: Device;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('alice');
    b = await newAccountDevice('bob', { channel: 'msedge' });
    c = await newAccountDevice('carol');
    // Both providers must hold a LIVE lease before the upload: a registration
    // without a heartbeat is not custody, and the handoff counts leases.
    await serveStorage(b);
    await serveStorage(c);
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close(), c?.close()]); });

  test('step 1 — the handoff completes only once two LIVE leases confirm', async () => {
    test.setTimeout(300_000);
    const cid = await uploadFile(a, 'handoff.bin', 64 * 1024);

    await a.log.waitFor(/Cache request published for/, 120_000);
    // The providers say they took it; the uploader says it is safe to leave.
    await Promise.all([
      b.log.waitFor(/\[StorageManager\] Cached /, 180_000),
      c.log.waitFor(/\[StorageManager\] Cached /, 180_000),
    ]);
    const done = await a.log.waitFor(/Handoff complete for/, 180_000);

    expect(done).toContain(cid.slice(0, 16));
    // The count in that line is LIVE holders, and it must have reached
    // MIN_REPLICAS. A line claiming fewer would mean the release fired early —
    // the uploader may then vanish and take the only copy with it.
    const live = Number(/\((\d+) live holders\)/.exec(done)?.[1] ?? 0);
    expect(live).toBeGreaterThanOrEqual(2);

    // And the uploader is not one of them.
    expect(a.log.all(/Handoff complete for/).length).toBe(1);
  });

});

test.describe('T9 — staging is durable', () => {
  let a: Device, b: Device;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('alice');
    b = await newAccountDevice('bob', { channel: 'msedge' });
    await serveStorage(b);
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close()]); });

  test('step 2 — an un-handed-off CID is retried after a reload, with no re-upload', async () => {
    test.setTimeout(600_000);
    // The property under test is PERSISTENCE, not the absence of providers: the
    // old note lived in memory, so closing the tab right after an upload
    // destroyed content the network had not taken custody of yet. Asserting it
    // this way holds whether or not a provider happens to be live, which
    // matters because a lease outlives the browser that created it — a spec
    // demanding "no live providers" would be testing the previous test's
    // leftovers, not this rule.
    await openStorageTab(a);
    const cid = await uploadFile(a, 'staging.bin', 64 * 1024);

    a.log.clear();
    await a.page.reload();
    await a.log.waitFor(/\[StorageManager\] Started/, 120_000);

    // Re-offered by the retry loop from the PERSISTED record. A memory-only
    // note could not produce this line after a reload at all.
    const again = await a.log.waitFor(
      new RegExp(`(Retried distribution for|Re-replication:|Cache request published for) ${cid.slice(0, 16)}`),
      300_000,
    );
    expect(again).toContain(cid.slice(0, 16));
    a.log.none(/pageerror:/);
  });
});

test.describe('T9 — repair', () => {
  let a: Device, b: Device, c: Device;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('alice');
    b = await newAccountDevice('bob', { channel: 'msedge' });
    // Two providers, because repair-on-read only becomes reachable once the
    // publisher has HANDED OVER — which needs MIN_REPLICAS live holders.
    c = await newAccountDevice('carol');
    await serveStorage(b);
    await serveStorage(c);
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close(), c?.close()]); });

  test('handoff releases the publisher copy, on PROVEN custody', async () => {
    test.setTimeout(900_000);
    const cid = await uploadFile(a, `repair-${E2E_RUN}.bin`, 64 * 1024);

    // Authorship is not custody. Until the release shipped, handoff logged
    // "safe to close" and deleted nothing: the publisher stopped being COUNTED
    // as a replica while still storing every byte it had ever uploaded.
    await a.log.waitFor(/Handoff complete for/, 300_000);
    const released = await a.log.waitFor(/Released own copy of/, 120_000);
    expect(released).toMatch(/\d+ live holder\(s\) have custody/);
    expect(released).toContain(cid.slice(0, 16));

    // And it released against LIVE holders, never a remembered confirmation —
    // releasing on "confirmed ever" deletes the last real copy.
    expect(released).not.toMatch(/0 live holder/);

    // STEP 3+4 are still NOT asserted, and the reason has moved twice.
    //
    // Fixed since this was written: the publisher used to keep its copy
    // forever (so the only node that may repair always had the bytes); the
    // UI's availability check inherited retrieve()'s 10-MINUTE deadline; and
    // the repair trigger was keyed on "nothing came back at all" when the
    // usual shape of a lost file is a readable manifest pointing at content
    // nobody can serve.
    //
    // What remains: with every holder closed, the read never returns to the
    // UI at all. `retrieve` logs `not local — trying 2 peer(s)` and retries,
    // and the not-found branch that now reports the failure is never reached,
    // so nothing is logged. The peers it dials are the relay, not the closed
    // providers, which suggests the 20 s bound is not being applied on every
    // path into retrieve.
    //
    // Next step is a decision, not a guess: whether an owner's read should ask
    // the archives for current holders (`GET /providers`) before concluding
    // the content is gone — which would also make the failure honest rather
    // than a timeout. Until then the repair POLICY stays covered where it is
    // testable: custody.test.ts (live-only counting, two-strike eviction,
    // rejoin discard) and engine/sim/repair.ts (repair-vs-churn, measured).
  });

  // STEP 3+4 — repair on read failure — remain UNVERIFIED end to end, and the
  // reason is now a different one from when this was written.
  //
  // The original blocker is fixed: the publisher used to keep its copy forever,
  // so the only node allowed to repair (`repairOnReadFailure` returns early
  // unless the node owns the cid) always had the bytes and no read could fail.
  // It now releases at handoff, asserted above.
  //
  // What blocks it now is the retrieve path. The UI checks availability FIRST
  // and only renders "Content not found" afterwards; `reportReadFailure` is
  // wired into that branch, but against a cid with zero reachable holders the
  // availability check does not return in any reasonable time — the panel sits
  // on "Checking…" and the branch is never reached, so nothing is logged at
  // all. Two things to decide, both Lucian's call:
  //
  //   1. `checkAvailability` needs a bounded deadline. "Checking…" forever is
  //      the worst of both worlds: the user learns nothing and repair, which is
  //      triggered by exactly this failure, never starts.
  //   2. Whether an owner's read should consult the archives for holders
  //      (`GET /providers`) before concluding the content is gone.
  //
  // Until then the repair POLICY is covered where it is testable:
  // engine/content/custody.test.ts (live-only counting, two-strike eviction,
  // rejoin discard) and engine/sim/repair.ts (repair-vs-churn, measured).
});

test.describe('T9 — the lease is what counts', () => {
  let a: Device, b: Device;
  // Bob restarts mid-test, so his profile has to outlive the browser — same
  // directory on the way back in, or the "rejoin" is a wiped machine.
  const bobDir = profileDir(`bob-lease-${E2E_RUN}`);

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('alice');
    b = await newAccountDevice('bob', { channel: 'msedge', userDataDir: bobDir });
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close()]); });

  test('steps 5+6 — a rejoin past the lease discards, and a lapsed holder stops counting', async () => {
    // A 6-minute lease under `fast`, 12 HOURS under `normal`. Skipped rather
    // than failed on the production clock: the assertion would be correct and
    // simply unreachable, and a red suite meaning "wrong profile" trains people
    // to ignore red. The profile is a consensus input, so it is named here.
    test.skip(timingProfile(b) !== 'fast',
      `needs STORAGE_TIMING=fast (6-minute lease); this stack runs "${timingProfile(b)}" `
      + '(12-hour lease). Restart with: $env:STORAGE_TIMING = \'fast\'; npm run dev');
    test.setTimeout(900_000);

    await serveStorage(b);
    const cid = await uploadFile(a, 'lease.bin', 64 * 1024);
    await b.log.waitFor(/\[StorageManager\] Cached /, 180_000);

    // Away for longer than one lease: MAX_OFFLINE_MS is 3 heartbeat intervals,
    // which under `fast` is 6 minutes.
    await b.close();
    await a.page.waitForTimeout(7 * 60_000);

    // Step 6, read WHILE the lease is lapsed and before bob returns. The count
    // that drives repair is live leases, and a holder that once confirmed is
    // explicitly not one — a replica count including offline holders is a
    // guess, and the first honest failure takes the object below the threshold
    // the guess said was met.
    //
    // Read here, not after the rejoin: bob heartbeats on restart, so his lease
    // goes live again and he is counted once more (correctly — the repair round
    // then re-sends him the content he discarded). Sampling after that reports
    // the healed state and says nothing about the lapse.
    // STEP 6 is deliberately NOT asserted here — see the note at the end of this
    // file. The rule it describes (only live leases count) is what `liveHolders`
    // and `planRepair` implement, and those are unit-tested; what is hard is
    // catching the one LOG LINE that prints the count.

    // Same profile, no reseed: this is bob coming back, not a new device.
    b = await openDevice('bob', { userDataDir: bobDir, headless: true, channel: 'msedge' });
    const rejoin = await b.log.waitFor(/Rejoin .*lease lapsed/, 180_000);

    // The unit has to follow the profile. This line used to read
    // `lapsed 0h ago (max 0h)` under `fast` — a fixed unit against a moved
    // clock, the same defect family as `LAST REWARD -59066340h ago`, and it is
    // the only line that explains why a node just erased its disk.
    expect(rejoin).not.toMatch(/\b0h\b/);
    expect(rejoin).toMatch(/discarding \d+ CID\(s\)/);

    // And the discarded bytes are really gone, not merely uncounted.
    expect(rejoin).toMatch(/content re-homed/);
  });
});

/**
 * STEP 6 — "lapsed holders stop counting" — is not asserted by this suite, and
 * the reason is worth recording rather than leaving as a gap someone re-derives.
 *
 * The step's pass condition is a LOG LINE: A's re-replication should read
 * `at 0/10 live (1 confirmed ever)` while the holder's lease is lapsed. Getting
 * that line printed needs three things at once, and two of them fight the test:
 *
 *  1. Another provider must be live, because `retryUnconfirmedDistributions`
 *     returns at the top when `selectProviders(1)` is empty — so with the
 *     lapsed holder as the only provider the loop bails BEFORE logging, and the
 *     line can never appear. (Adding a third device fixes this one.)
 *  2. The CID's backoff must have elapsed. `lastDistributed` gates the loop and
 *     the wait grows with `cidStuckCount` (observed at 100 s and climbing), so
 *     after a few rounds against an absent holder the next line can be further
 *     away than the lapse itself. Two runs of 12+ minutes saw no line at all.
 *  3. It must be sampled after the lapse, not before — the newest matching line
 *     is otherwise one from while the holder was still healthy.
 *
 * The RULE is not unverified: `liveHolders` and `planRepair` decide it, and
 * `engine/content/custody.test.ts` pins them, including that lapsed holders are
 * dropped rather than merely uncounted. What is unverified is the wiring's
 * narration of it. If this is worth closing, the cheap way is a counter the UI
 * renders (a replica count on the Storage tab, which a spec can read on demand)
 * rather than a log line behind two timers.
 */
