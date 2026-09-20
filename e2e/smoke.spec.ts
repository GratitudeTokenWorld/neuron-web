import { test, expect } from '@playwright/test';
import { openDevice, openStorageTab, storageStats, appLog, type Device } from './device';

/**
 * Does the harness itself work?
 *
 * Needs NO captured session, so it runs on a clean machine and proves the parts
 * every other spec depends on: a real browser reaches the dev server, the node
 * boots, console capture sees the app's own log lines, and the Storage tab
 * renders. Without this, a suite that skips everything for want of a fixture
 * looks identical to a suite whose harness is broken — and the first is fine
 * while the second is worthless.
 */
test.describe('e2e harness', () => {
  let d: Device;
  test.beforeAll(async () => { d = await openDevice('smoke', { headless: true }); });
  test.afterAll(async () => { await d?.close(); });

  test('the node boots and says so', async () => {
    // Two log streams that do not overlap: console carries the [StorageManager]
    // lines, the in-app panel carries "Node started". A spec that waits on the
    // wrong one hangs forever and looks like a broken feature.
    expect(d.log.all(/\[StorageManager\] Started/).length).toBeGreaterThan(0);
    const panel = await appLog(d);
    expect(panel.some((l) => /Node started/.test(l)), 'in-app log unreachable').toBe(true);
  });

  test('console capture sees the app log, not just browser noise', async () => {
    // The `[StorageManager]` / `[SmokeStore]` lines are where the storage path
    // narrates itself, and they are the assertion surface for every custody
    // spec. If this fails, waitFor() can never match anything useful.
    await d.log.waitFor(/\[(SmokeStore|StorageManager)\]/, 60_000);
  });

  test('the storage timing profile is reported, and the specs know which', async () => {
    // A compressed profile is a CONSENSUS input: two devices on different
    // profiles reject each other's reward blocks mid-chain. Any custody timing
    // a spec asserts is meaningless without knowing which clock is running.
    const line = await d.log.waitFor(/timing profile/i, 30_000);
    expect(line).toMatch(/fast|production|normal/i);
  });

  test('the Storage tab renders its stat chips', async () => {
    await openStorageTab(d);
    const stats = await storageStats(d);
    expect(Object.keys(stats).length).toBeGreaterThan(0);
    // Providers is present whether or not this device serves, so it is the
    // safe existence check; the values are asserted in storage-ui.spec.ts.
    expect(Object.keys(stats).some((l) => /providers/i.test(l))).toBe(true);
  });

  test('the page threw no uncaught errors while booting', async () => {
    // An exception that kills a timer is otherwise indistinguishable from "the
    // feature silently did nothing" — which cost a full day on 2026-08-16.
    d.log.none(/^pageerror:/);
  });
});
