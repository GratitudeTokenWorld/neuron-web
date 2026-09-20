import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * A "device" for E2E: one browser context with its own IndexedDB and
 * localStorage, which is exactly what makes it a separate node on this network.
 *
 * Two contexts in one Playwright run therefore reproduce the two-profile setup
 * the manual matrix uses (Chrome = A, Edge = B) without two machines, and they
 * talk over loopback WebRTC, which sidesteps the carrier-NAT problem that makes
 * phone testing need TURN.
 *
 * WHAT THIS CANNOT DO: create an account. That needs a live face through a
 * depth sweep and five randomly-ordered actions, and a synthetic video stream
 * cannot pass it — deliberately, since defeating it with a recording is the
 * attack the liveness gate exists to stop. So a device is SEEDED from a session
 * captured once by hand (`npm run e2e:capture`). Everything downstream of an
 * existing account — storage, custody, repair, transfers, the UI numbers — is
 * automatable, and that is where every defect of 2026-08-16 lived.
 */

/**
 * Console lines, newest last.
 *
 * There are TWO log streams in this app and they do not overlap:
 *
 *   - `console.*` — every `[StorageManager]` / `[SmokeStore]` / `[Node]` line.
 *     This is where the storage path narrates itself, so it is what specs
 *     assert on, and it is the only stream Playwright sees live.
 *   - `addLog()` — the in-app panel ("Node started", "Heartbeat sent for alice").
 *     It writes to a DOM buffer and NEVER reaches console, so `page.on('console')`
 *     cannot see it. Use `appLog(device)` for those; it opens the panel, which
 *     replays the whole buffer, and reads it back.
 *
 * Confusing the two costs a debugging cycle: waiting on an addLog-only string
 * here simply never matches, which looks exactly like the feature not running.
 */
export interface DeviceLog {
  lines: string[];
  /** Wait for a line matching `pattern`, or throw with the tail for context. */
  waitFor(pattern: RegExp, timeoutMs?: number): Promise<string>;
  /** Every line matching, without waiting. */
  all(pattern: RegExp): string[];
  /** Assert a line has NOT appeared. Cheap, and the thing most specs forget. */
  none(pattern: RegExp): void;
  clear(): void;
}

export interface Device {
  name: string;
  page: Page;
  context: BrowserContext;
  log: DeviceLog;
  close(): Promise<void>;
}

function attachLog(page: Page, name: string): DeviceLog {
  const lines: string[] = [];
  // console covers the `[StorageManager]` / `[SmokeStore]` / `[Node]` lines,
  // which is where the storage path actually narrates itself. Page errors are
  // captured too: an uncaught exception that kills a timer is otherwise
  // indistinguishable from "the feature silently did nothing", which cost a day.
  page.on('console', (m) => lines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => lines.push(`pageerror: ${e.message}`));

  const tail = () => lines.slice(-40).join('\n');
  return {
    lines,
    async waitFor(pattern: RegExp, timeoutMs = 60_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = lines.find((l) => pattern.test(l));
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `[${name}] timed out after ${timeoutMs}ms waiting for ${pattern}\n--- last 40 log lines ---\n${tail()}`,
          );
        }
        await page.waitForTimeout(250);
      }
    },
    all: (pattern: RegExp) => lines.filter((l) => pattern.test(l)),
    none(pattern: RegExp) {
      const hit = lines.find((l) => pattern.test(l));
      if (hit) throw new Error(`[${name}] expected NO line matching ${pattern}, found: ${hit}`);
    },
    clear: () => { lines.length = 0; },
  };
}

export interface OpenOptions {
  /** Saved session from `npm run e2e:capture`. Without it the app has no account. */
  storageStatePath?: string;
  /** 'chrome' | 'msedge' — the two real profiles the manual matrix uses. */
  channel?: 'chrome' | 'msedge';
  headless?: boolean;
  baseURL?: string;
}

const browsers: Browser[] = [];

/**
 * Open a device and wait until its node is up.
 *
 * Waits for `Node started` rather than `load`: the page is interactive long
 * before libp2p has connected, and asserting on storage state before then reads
 * an empty ledger and blames the feature.
 */
export async function openDevice(name: string, opts: OpenOptions = {}): Promise<Device> {
  const browser = await chromium.launch({
    channel: opts.channel ?? 'chrome',
    headless: opts.headless ?? false,
  });
  browsers.push(browser);
  const context = await browser.newContext({
    storageState: opts.storageStatePath,
    permissions: [],
  });
  const page = await context.newPage();
  const log = attachLog(page, name);
  await page.goto(opts.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:5173');
  // `[StorageManager] Started` is a console.log and fires once the node is up.
  // "Node started" is addLog-only and invisible here — waiting on it hangs.
  await log.waitFor(/\[StorageManager\] Started/, 60_000);
  return {
    name, page, context, log,
    async close() { await context.close(); await browser.close(); },
  };
}

export async function closeAllDevices(): Promise<void> {
  for (const b of browsers.splice(0)) await b.close().catch(() => {});
}

/**
 * The in-app log panel's contents, for lines that never reach console.
 *
 * Opening the panel re-renders the entire buffer, so this returns history too,
 * not just what arrives after it is opened.
 */
export async function appLog(d: Device): Promise<string[]> {
  const open = await d.page.evaluate(() =>
    !!document.getElementById('mobileLogPanel')?.classList.contains('open'));
  if (!open) await d.page.click('#logFab');
  await d.page.waitForSelector('#mobileLogScroller', { state: 'visible' });
  return d.page.evaluate(() =>
    [...document.querySelectorAll('#mobileLogScroller > *')]
      .map((e) => e.textContent!.replace(/\s+/g, ' ').trim())
      .filter(Boolean));
}

/** Open the Storage tab and wait for it to render. */
export async function openStorageTab(d: Device): Promise<void> {
  await d.page.click('[data-tab="storage"]');
  await d.page.waitForSelector('#storageNetworkStatBar', { state: 'visible' });
}

/**
 * The provider row for an account, as the UI renders it — the surface where
 * every 2026-08-16 display defect lived (uptime disagreeing with score, an
 * "average" of one sample, "7/6 heartbeats due", a negative LAST REWARD).
 * Read it as text so a test asserts what a human would actually see.
 */
export async function providerRow(d: Device, pubPrefix: string): Promise<string | null> {
  return d.page.evaluate((prefix) => {
    const rows = [...document.querySelectorAll('#storageProvidersList tr')];
    const hit = rows.find((r) => r.textContent?.includes(prefix));
    return hit ? hit.textContent!.replace(/\s+/g, ' ').trim() : null;
  }, pubPrefix);
}

/** The stat chips above the provider table, as a label→value map. */
export async function storageStats(d: Device): Promise<Record<string, string>> {
  return d.page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const chip of document.querySelectorAll('#storageNetworkStatBar > div')) {
      const label = chip.querySelector('div:nth-child(1)')?.textContent?.trim();
      const value = chip.querySelector('div:nth-child(2)')?.textContent?.trim();
      if (label) out[label] = value ?? '';
    }
    return out;
  });
}

/**
 * Upload a file from the Storage tab and return its CID.
 *
 * Bytes are deterministic but NOT constant: content addressing means an
 * all-zero buffer produces the same CID every run, so a "new" upload would
 * silently dedupe against the previous test's content and nothing would
 * transfer. `seed` makes each run's content distinct.
 *
 * The form has one file input per content type; "other" is the generic one, so
 * the type selector has to be set to match or the input is hidden and
 * `setInputFiles` fills a control the submit handler never reads.
 */
export async function uploadFile(
  d: Device, name: string, sizeBytes: number, seed = Date.now(),
): Promise<string> {
  const buffer = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buffer[i] = (i + seed) % 251;
  await d.page.selectOption('#storageContentType', 'other');
  await d.page.setInputFiles('#otherFile', {
    name, mimeType: 'application/octet-stream', buffer,
  });
  await d.page.fill('#storageContentName', name);
  await d.page.click('#btnStoreContent');
  // The CID is only knowable once the store completes; the log carries it.
  const line = await d.log.waitFor(/distributeContent: cid=([a-z0-9]+)/, 180_000);
  return /cid=([a-z0-9]+)/.exec(line)![1]!;
}
