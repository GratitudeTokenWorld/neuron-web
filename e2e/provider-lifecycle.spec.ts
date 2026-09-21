import { test, expect } from '@playwright/test';
import {
  openStorageTab, providerRow, serveStorage, uploadFile, newAccountDevice,
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

  test('step 1 — registering earns nothing, and says so', async () => {
    test.setTimeout(300_000);
    aPub = await serveStorage(a, 5);

    const row = await providerRow(a, aPub.slice(0, 12));
    expect(row, 'the provider does not appear in its own table').toBeTruthy();

    // Declared capacity earns NOTHING — you are paid for bytes held, not for
    // bytes promised. A non-zero rate here would mean capacity alone pays,
    // which is the free-rider hole the whole reward design exists to close.
    expect(row!).toContain('5');
    expect(row!).toMatch(/\b0(\.0+)?\b/);

    // One heartbeat was due and one was sent, so uptime is a real 100% — not a
    // default. `serveStorage` waits for that first heartbeat precisely so this
    // assertion is measuring something.
    expect(row!).toMatch(/100\s*%/);
  });

  test('step 2 — the other device discovers it, and admits what it cannot know', async () => {
    test.setTimeout(300_000);
    await openStorageTab(b);

    let row: string | null = null;
    for (let i = 0; i < 30 && !row; i++) {
      row = await providerRow(b, aPub.slice(0, 12));
      if (!row) await b.page.waitForTimeout(5_000);
    }
    expect(row, `device B never discovered ${aPub.slice(0, 12)} via GET /providers`).toBeTruthy();
    expect(row!).toContain('5');

    // The dashes are the point of this step. B holds none of A's chain and has
    // fetched nothing from it, so uptime, spot-check, score, rate and earnings
    // are UNKNOWN to B — and an unknown rendered as 0 or 100% is the recurring
    // defect class on this tab.
    const dashes = (row!.match(/—/g) ?? []).length;
    expect(dashes, `expected unknown columns to read "—", got: ${row}`).toBeGreaterThanOrEqual(3);
  });

  test('step 3 — an early heartbeat is refused, not silently accepted', async () => {
    test.setTimeout(300_000);
    await openStorageTab(a);
    await a.page.click('#btnManualHeartbeat');

    // Refused with a REASON. A silent no-op would look identical to a heartbeat
    // that worked, and uptime is computed from counted renewals.
    await a.page.waitForFunction(
      () => /interval not reached|Heartbeat/i.test(
        document.getElementById('serveStorageStatus')?.textContent ?? ''),
      undefined, { timeout: 60_000 },
    );
    const status = (await a.page.textContent('#serveStorageStatus')) ?? '';
    expect(status, status).toMatch(/interval not reached/i);
    expect(status).toMatch(/\d+\s*min/);
  });

  test('step 4 — deregistering does NOT reset the heartbeat clock', async () => {
    test.setTimeout(600_000);
    await openStorageTab(a);
    await a.page.click('#btnStopServing');
    await a.page.waitForSelector('#serveStorageForm', { state: 'visible', timeout: 60_000 });

    // Re-register, then ask for a heartbeat. The interval must still be running
    // from the ORIGINAL one: treating deregistration as a reset let a provider
    // re-register in a loop and claim a full day of uptime for a minute of
    // work, which is the bug this step exists to catch.
    await serveStorage(a, 5).catch(() => { /* first heartbeat may be refused — that IS the assertion */ });
    await a.page.click('#btnManualHeartbeat').catch(() => {});
    await a.page.waitForTimeout(3_000);
    const status = (await a.page.textContent('#serveStorageStatus')) ?? '';
    expect(status, `after re-registering the clock appears to have reset: "${status}"`)
      .toMatch(/interval not reached/i);
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
    test.setTimeout(1_800_000);

    await serveStorage(a, 5);
    // The provider must actually HOLD something: a reward is metered by stored
    // bytes, so an empty provider crossing an epoch boundary earns exactly 0
    // and would make this step pass while measuring nothing.
    await uploadFile(b, `reward-${E2E_RUN}.bin`, 256 * 1024);
    await a.log.waitFor(/\[StorageManager\] Cached /, 300_000);

    // Wait out an epoch boundary, then claim. Rewards settle one epoch behind:
    // the claim names the epoch BEFORE its own block, never the running one —
    // billing the running epoch pays a fraction of what was earned and closes
    // that epoch permanently.
    const issued = await a.log.waitFor(/Reward issued: (\d+) milli-UNIT/, 1_500_000);
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
