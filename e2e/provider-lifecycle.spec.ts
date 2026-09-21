import { test, expect } from '@playwright/test';
import {
  openStorageTab, providerRow, providerCells, serveStorage, uploadFile, newAccountDevice,
  clickForToast,
  testFaceAvailable, TEST_FACE_HINT, E2E_RUN, type Device,
} from './device';

/**
 * TESTPLAN T8 — storage provider lifecycle.
 *
 * Register, be discovered, be refused an early heartbeat, deregister, and get
 * paid. Exercised ad-hoc during development on 2026-08-15 but never recorded as
 * a pass, which is how "deregistering resets the heartbeat clock" survived long
 * enough to pay a full day's reward for sixty seconds of work.
 *
 * The rows here are about what the OTHER device sees as much as what the
 * provider does: discovery is `GET /providers`, an archive query, not gossip —
 * two accounts are almost certainly in different shards, so a provider that
 * only ever gossiped would be invisible to everyone.
 */

const timing = (d: Device) =>
  (d.log.all(/\[Storage\] timing profile = (\w+)/).at(-1)?.includes('fast') ? 'fast' : 'normal');

test.describe('T8 — provider lifecycle', () => {
  let a: Device, b: Device;
  let aPub = '';

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('provider');
    b = await newAccountDevice('observer', { channel: 'msedge' });
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close()]); });

  test('steps 1, 3 and 4 — register, refuse an early beat, and survive a deregister', async () => {
    test.setTimeout(900_000);

    // These three run as ONE sequence because the heartbeat interval is what
    // they are about, and it is 2 MINUTES under the compressed profile. Split
    // into separate tests, the window had already elapsed by the time the
    // "early" heartbeat was attempted, and the refusal under test could not
    // happen. TESTPLAN's "immediately" is load-bearing on this clock.
    aPub = await serveStorage(a, 5);

    // —— STEP 1 ——
    const row = await providerRow(a, aPub.slice(0, 7));
    expect(row, 'the provider does not appear in its own table').toBeTruthy();
    // Declared capacity earns NOTHING — paid for bytes held, not bytes
    // promised. A non-zero rate here is the free-rider hole the reward design
    // exists to close.
    expect(row!, `row: ${row}`).toContain('5');

    // Read the RATE CELL, not the row text: "the rate is 0" is satisfied by
    // the 0 in "5.0 GB", so a row-level match would pass for the wrong reason.
    const cells = await providerCells(a, aPub.slice(0, 7));
    expect(cells, 'no provider row cells').toBeTruthy();
    const rate = cells![cells!.length - 2] ?? '';
    expect(Number(rate.replace(/[^0-9.]/g, '') || '0'),
      `declared capacity must earn nothing — rate cell was "${rate}", row: ${row}`).toBe(0);

    // —— STEP 3 —— immediately, while the interval is certainly unexpired.
    // Read the TOAST this click produces. `#serveStorageStatus` still holds the
    // registration's own "Heartbeat sent" from a moment ago, so asserting on it
    // tested the previous action's success message.
    const early = await clickForToast(a, '#btnManualHeartbeat');
    // Refused WITH A REASON. A silent no-op is indistinguishable from a
    // heartbeat that worked, and uptime is computed from counted renewals.
    expect(early, `early heartbeat should have been refused — status: "${early}"`)
      .toMatch(/interval not reached/i);

    // —— STEP 4 —— deregistering must NOT reset the clock. Treating it as a
    // reset let a provider re-register in a loop and claim a full day of uptime
    // for a minute of work.
    await a.page.click('#btnStopServing');
    await a.page.waitForSelector('#serveStorageForm', { state: 'visible', timeout: 120_000 });

    await a.page.fill('#storageCapacityGB', '5');
    await a.page.click('#btnServeStorage');
    await a.page.waitForSelector('#stopServingArea', { state: 'visible', timeout: 180_000 });
    const afterRejoin = await clickForToast(a, '#btnManualHeartbeat', 60_000);
    expect(afterRejoin, `the heartbeat clock appears to have reset on re-register — status: "${afterRejoin}"`)
      .toMatch(/interval not reached/i);
  });

  test('step 2 — the other device discovers it, and admits what it cannot know', async () => {
    test.setTimeout(300_000);
    await openStorageTab(b);

    let row: string | null = null;
    for (let i = 0; i < 30 && !row; i++) {
      row = await providerRow(b, aPub.slice(0, 7));
      if (!row) await b.page.waitForTimeout(5_000);
    }
    expect(row, `device B never discovered ${aPub.slice(0, 7)} via GET /providers`).toBeTruthy();
    expect(row!).toContain('5');

    // The dashes are the point. B holds none of A's chain and has fetched
    // nothing from it, so uptime, spot-check, score, rate and earnings are
    // UNKNOWN to B — and an unknown rendered as 0 or 100% is the recurring
    // defect class on this tab.
    const dashes = (row!.match(/—/g) ?? []).length;
    expect(dashes, `expected unknown columns to read "—", got: ${row}`).toBeGreaterThanOrEqual(3);
  });
});

test.describe('T8 step 5 — the reward', () => {
  // Needs a provider that holds bytes across an epoch boundary. 12 minutes
  // under `fast`, a DAY at production timing — so this is skipped rather than
  // asserted on the production clock, where it is correct and unreachable.
  let a: Device, b: Device;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('rewarded', { channel: 'msedge' });
    b = await newAccountDevice('uploader');
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close()]); });

  test('pays for bytes HELD, one epoch behind, and only once', async () => {
    test.skip(timing(a) !== 'fast',
      `needs STORAGE_TIMING=fast (12-minute epoch); this stack runs "${timing(a)}" (24-hour epoch)`);
    test.setTimeout(2_700_000);

    await serveStorage(a, 5);
    // Enough bytes to be PAYABLE, not merely non-empty. The reward is
    // 1000 x storedGB x countedHeartbeats/6 in milli-UNIT, so 256 KB earns
    // 1000 x 0.00024 = 0.24 and truncates to zero — the run then fails with
    // "calculated reward is zero", which is the rule working and the test
    // measuring nothing. 12 MB earns ~12 milli-UNIT at full uptime.
    // (The manual pass on record was 98 milli-UNIT for 101 MB.)
    await uploadFile(b, `reward-${E2E_RUN}.bin`, 12 * 1024 * 1024);
    await a.log.waitFor(/\[StorageManager\] Cached /, 300_000);

    // Wait out an epoch boundary, then claim. Rewards settle one epoch behind:
    // the claim names the epoch BEFORE its own block, never the running one —
    // billing the running epoch pays a fraction of what was earned and closes
    // that epoch permanently.
    // Up to two epoch boundaries: the provider has to be registered at the
    // START of the epoch it is paid for, so registering mid-epoch means the
    // first boundary only makes it eligible and the second pays it.
    const issued = await a.log.waitFor(/Reward issued: (\d+) milli-UNIT/, 2_400_000);
    const amount = Number(/Reward issued: (\d+)/.exec(issued)![1]);
    expect(amount, `reward should be non-zero for a provider holding bytes: ${issued}`).toBeGreaterThan(0);

    // A second claim for the same epoch is refused. Without this an operator
    // could mint the same epoch repeatedly.
    a.log.clear();
    await openStorageTab(a);
    await a.page.click('#btnClaimReward');
    await a.page.waitForTimeout(10_000);
    a.log.none(/Reward issued: \d+ milli-UNIT/);
  });
});
