import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  /** Set by `newAccountDevice` — the account this device created. */
  username?: string;
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
  /**
   * Keep this device's profile on disk so it survives `close()` and can be
   * re-opened as the SAME device.
   *
   * Needed by every restart test, because `storageState` carries localStorage
   * only. A device's cached CIDs, chain and file index live in IndexedDB, so a
   * plain re-open is not a restart — it is a wiped machine holding the same
   * keys. T9 step 5 asserts that a returning node DISCARDS what its lapsed
   * lease no longer covers; against an empty IndexedDB it would discard nothing
   * and pass without testing anything at all.
   *
   * On first launch the captured session is injected into the fresh profile;
   * afterwards the profile is the source of truth.
   */
  userDataDir?: string;
  /** Wipe `userDataDir` first — a first boot, not a rejoin. */
  fresh?: boolean;
  /**
   * ⚠ DEV ONLY — create accounts from a SYNTHETIC face under this seed, with
   * no camera and no liveness check (`src/core/test-face.ts`).
   *
   * Requires the dev server to run with `TEST_FACE=1`; without it the client
   * constant is baked `false` and this does nothing at all, which is the point.
   * Each distinct seed is a different human to every match gate, so one machine
   * can hold several accounts without tripping `FACE_MAX`.
   *
   * Applied as an init script rather than by writing localStorage after load:
   * the app reads the seed during boot and again after the reload that account
   * creation performs, so a one-shot write would be missed by both.
   */
  testFaceSeed?: string;
}

/**
 * Seed a persistent profile with a captured session's localStorage.
 *
 * `launchPersistentContext` takes no `storageState`, so the wallet has to be
 * written in and the page reloaded before the app reads it. Only the app's own
 * origin is copied: a session file also carries whatever else the capture
 * browser had, and none of it belongs in a test profile.
 */
async function seedSession(page: Page, sessionPath: string, url: string): Promise<void> {
  const state = JSON.parse(readFileSync(sessionPath, 'utf8')) as {
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  const origin = new URL(url).origin;
  const entries = state.origins.find((o) => o.origin === origin)?.localStorage ?? [];
  if (entries.length === 0) {
    throw new Error(`${sessionPath} holds nothing for ${origin} — re-capture against this base URL`);
  }
  await page.evaluate((kv: { name: string; value: string }[]) => {
    for (const { name, value } of kv) localStorage.setItem(name, value);
  }, entries);
}

const browsers: Browser[] = [];
const contexts: BrowserContext[] = [];

/**
 * Open a device and wait until its node is up.
 *
 * Waits for `Node started` rather than `load`: the page is interactive long
 * before libp2p has connected, and asserting on storage state before then reads
 * an empty ledger and blames the feature.
 */
export async function openDevice(name: string, opts: OpenOptions = {}): Promise<Device> {
  const url = opts.baseURL ?? process.env.E2E_BASE_URL ?? 'http://localhost:5173';
  const channel = opts.channel ?? 'chrome';
  const headless = opts.headless ?? false;

  let browser: Browser | undefined;
  let context: BrowserContext;
  let page: Page;
  let log: DeviceLog;

  if (opts.userDataDir) {
    // A real restart: the profile (IndexedDB included) outlives the browser.
    if (opts.fresh && existsSync(opts.userDataDir)) rmSync(opts.userDataDir, { recursive: true, force: true });
    const firstBoot = !existsSync(opts.userDataDir);
    context = await chromium.launchPersistentContext(opts.userDataDir, {
      channel, headless, permissions: [],
    });
    contexts.push(context);
    page = context.pages()[0] ?? (await context.newPage());
    log = attachLog(page, name);
    if (opts.testFaceSeed) await applyTestFaceSeed(context, opts.testFaceSeed);
    await page.goto(url);
    if (firstBoot && opts.storageStatePath) {
      // Seed, then reload: the app read localStorage at boot and found nothing.
      await seedSession(page, opts.storageStatePath, url);
      log.clear();
      await page.reload();
    }
  } else {
    browser = await chromium.launch({ channel, headless });
    browsers.push(browser);
    context = await browser.newContext({ storageState: opts.storageStatePath, permissions: [] });
    if (opts.testFaceSeed) await applyTestFaceSeed(context, opts.testFaceSeed);
    page = await context.newPage();
    log = attachLog(page, name);
    await page.goto(url);
  }

  // `[StorageManager] Started` is a console.log and fires once the node is up.
  // "Node started" is addLog-only and invisible here — waiting on it hangs.
  await log.waitFor(/\[StorageManager\] Started/, 60_000);
  return {
    name, page, context, log,
    async close() {
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
    },
  };
}

export async function closeAllDevices(): Promise<void> {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
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
 * Refuse a prefix that cannot identify anything.
 *
 * `includes('')` is true of every row, so an empty prefix silently returns the
 * FIRST provider and every assertion about it passes for the wrong reason —
 * which is exactly what happened when an earlier step failed before setting the
 * pub, and the discovery test went green against a row belonging to somebody
 * else. The table elides pubs to 7 leading characters (`trunc(pub, 14)`), so
 * anything longer than that cannot match either.
 */
function assertUsablePrefix(d: Device, prefix: string): void {
  if (!prefix || prefix.length < 4) {
    throw new Error(`[${d.name}] provider lookup needs a real prefix, got "${prefix}" — `
      + 'an empty one matches every row');
  }
  if (prefix.length > 7) {
    throw new Error(`[${d.name}] provider pubs render elided to 7 characters; `
      + `"${prefix}" (${prefix.length}) can never match. Use pub.slice(0, 7)`);
  }
}

/**
 * The provider row for an account, as the UI renders it — the surface where
 * every 2026-08-16 display defect lived (uptime disagreeing with score, an
 * "average" of one sample, "7/6 heartbeats due", a negative LAST REWARD).
 * Read it as text so a test asserts what a human would actually see.
 */
export async function providerRow(d: Device, pubPrefix: string): Promise<string | null> {
  assertUsablePrefix(d, pubPrefix);
  return d.page.evaluate((prefix) => {
    const rows = [...document.querySelectorAll('#storageProvidersList tr')];
    const hit = rows.find((r) => r.textContent?.includes(prefix));
    return hit ? hit.textContent!.replace(/\s+/g, ' ').trim() : null;
  }, pubPrefix);
}

/**
 * A provider's row as CELLS, in column order:
 * Provider | Capacity | Uptime | Latency | Spot Check | Score | Rate/day | Earned
 *
 * `providerRow` returns the whole row as one string, which makes it easy to
 * write an assertion that passes for the wrong reason — "the rate is 0" is
 * satisfied by the 0 in "5.0 GB". Read the cell when the claim is about a
 * specific column.
 */
export async function providerCells(d: Device, pubPrefix: string): Promise<string[] | null> {
  assertUsablePrefix(d, pubPrefix);
  return d.page.evaluate((prefix) => {
    const rows = [...document.querySelectorAll('#storageProvidersList tr')];
    const hit = rows.find((r) => r.textContent?.includes(prefix));
    if (!hit) return null;
    return [...hit.querySelectorAll('td')].map((c) => c.textContent!.replace(/\s+/g, ' ').trim());
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
  // Open the tab first. The form only exists on the Storage tab, and a helper
  // that assumed a caller had already opened it failed three T9 steps with
  // `waiting for #storageContentType` — which reads as a missing control
  // rather than the wrong tab being in front of it.
  await openStorageTab(d);

  const buffer = Buffer.alloc(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) buffer[i] = (i + seed) % 251;
  await d.page.selectOption('#storageContentType', 'other');
  await d.page.setInputFiles('#otherFile', {
    name, mimeType: 'application/octet-stream', buffer,
  });
  await d.page.fill('#storageContentName', name);
  await d.page.click('#btnStoreContent');

  // Read the CID from the RESULT PANEL, not from the log.
  //
  // `distributeContent` logs `cid=${cid.slice(0, 20)}…` — truncated for
  // readability — and scraping that returned a 20-character prefix that looks
  // exactly like a CID and matches nothing. Every lookup keyed on it silently
  // missed: `trackedCids.get()` found no entry so repair declined ("this node
  // tracks no such CID"), and `/files?cid=` never matched, which read as the
  // archive not having received the announcement. Two T10 rows and the whole
  // of T9 step 3 were chasing that. The panel shows the full CID, which is
  // also what a person would copy.
  await d.page.waitForSelector('#storageCidResult', { state: 'visible', timeout: 180_000 });
  const cid = await d.page.evaluate(() => {
    const text = document.getElementById('storageCidResult')?.textContent ?? '';
    return /CID:\s*([A-Za-z0-9]+)/.exec(text)?.[1] ?? '';
  });
  // A CID is far longer than the 20-char prefix the log prints; anything short
  // is the old bug coming back.
  if (cid.length < 40) {
    throw new Error(`[${d.name}] CID looks truncated ("${cid}") — read it from #storageCidResult, not the log`);
  }
  return cid;
}

/**
 * Register this device as a storage provider and wait until it is discoverable.
 *
 * The app sends the FIRST heartbeat 8 s after the register block, deliberately,
 * so the registration has time to propagate before the smoke address is
 * announced. Returning before that heartbeat lands hands the spec a provider
 * with no lease — and a lease, not a registration, is what custody counts. The
 * status element is the only place that completion is reported: it is written
 * by `addLog`/DOM, never to console, so it cannot be waited on via `d.log`.
 */
export async function serveStorage(d: Device, capacityGB = 5): Promise<string> {
  await openStorageTab(d);
  const serving = await d.page.isVisible('#stopServingArea');
  const pub = await d.page.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>('#storageProviderAccount');
    return sel?.value ?? '';
  });
  if (!pub) throw new Error(`[${d.name}] no account in the provider selector — is the session seeded?`);
  if (serving) return pub;

  await d.page.fill('#storageCapacityGB', String(capacityGB));
  await d.page.click('#btnServeStorage');
  // "you are now discoverable to peers" — the first heartbeat, i.e. the lease.
  await d.page.waitForFunction(
    () => /discoverable|Heartbeat skipped/i.test(
      document.getElementById('serveStorageStatus')?.textContent ?? ''),
    undefined, { timeout: 90_000 },
  );
  const status = await d.page.textContent('#serveStorageStatus');
  if (/skipped/i.test(status ?? '')) throw new Error(`[${d.name}] first heartbeat skipped: ${status}`);
  return pub;
}

/** The content library rows (the uploader's OWN files), as rendered. */
export async function contentLibrary(d: Device): Promise<string[]> {
  return d.page.evaluate(() =>
    [...document.querySelectorAll('#contentLibraryList tr')]
      .map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
      .filter(Boolean));
}

/**
 * A relay's `/files` answer.
 *
 * Queried straight from Node rather than through the page: T10's claim is that
 * the ARCHIVES hold the index and clients do not, so reading it through the
 * client under test would prove nothing about where it lives.
 */
export async function relayFiles(
  base: string, params: Record<string, string> = {},
): Promise<{ records: { cid: string; removed?: boolean; sizeBytes?: number }[]; total: number }> {
  const q = new URLSearchParams({ network: 'testnet', ...params });
  const res = await fetch(`${base}/files?${q}`);
  if (!res.ok) throw new Error(`${base}/files → HTTP ${res.status}`);
  return res.json() as Promise<{ records: { cid: string; removed?: boolean }[]; total: number }>;
}

/**
 * The archive relays under test — the two cloud boxes AND the local dev relay.
 *
 * The local one is an archive in its own right (the dev topology is 2 cloud +
 * 1 local, which is also why account creation logs three attestations), and it
 * receives an announcement first. Querying only the cloud pair made a
 * propagation delay look like a missing record: federation to the cloud boxes
 * took longer than a 60 s poll, while the record had been available locally the
 * whole time.
 */
export const RELAY_BASES = (process.env.E2E_RELAYS
  ?? 'http://localhost:9092,http://80.97.27.224:9092,http://80.97.27.112:9092').split(',');


/** Seed the synthetic face before the app boots, and on every later load. */
async function applyTestFaceSeed(context: BrowserContext, seed: string): Promise<void> {
  await context.addInitScript((s: string) => {
    try { localStorage.setItem('neuron_test_face', s); } catch { /* blocked storage */ }
  }, seed);
}

/**
 * Create an account end to end, with no human.
 *
 * Drives the REAL creation flow — the same buttons, the same PIN dialog, the
 * same attestation quorum, the same v3 blob and Shamir split. Only the camera
 * is replaced (see `src/core/test-face.ts`), so what a spec exercises afterwards
 * is the path that ships.
 *
 * Fails loudly if the synthetic face is not active: without `TEST_FACE=1` on the
 * dev server the app opens a real camera, and the run would otherwise hang on a
 * capture nobody is performing — which looks exactly like a broken feature.
 */
export async function createAccount(
  d: Device, username: string, pin = '1234',
): Promise<void> {
  const banner = await d.page.locator('#testFaceBanner').count();
  if (banner === 0) {
    throw new Error(
      `[${d.name}] synthetic face is not active — no #testFaceBanner. `
      + "Restart the dev server with: $env:TEST_FACE = '1'; npm run dev",
    );
  }

  await d.page.click('[data-tab="account"]');
  await d.page.fill('#newUsername', username);
  await d.page.click('#btnCreateAccount');

  // Set, then confirm. Each dialog is built fresh with no stable id, so it is
  // waited on by the TITLE a person reads. Waiting on "a password input exists"
  // instead matches the first dialog's field while the second is still being
  // built, and the keystrokes land in an element that is about to be removed —
  // which looks exactly like a PIN the app refused.
  await enterPin(d, pin, /Set a 4-digit PIN/i);
  await enterPin(d, pin, /Confirm your PIN/i);

  // The attestation quorum, the share split and the open block all happen after
  // the PIN, and each talks to the relays — so this is the slow part.
  await d.page.waitForFunction(
    () => /Account created/i.test(document.getElementById('createStatus')?.textContent ?? ''),
    undefined, { timeout: 180_000 },
  );
}


/**
 * Where a persistent device profile lives — OUTSIDE the repo, deliberately.
 *
 * Vite watches the project directory, and a live Chrome profile holds
 * `Default/Network/Cookies` locked. Watching it throws EBUSY, which crashes the
 * dev server the specs are talking to: the whole stack dies mid-run and every
 * later navigation fails with ERR_CONNECTION_RESET, which reads like a network
 * bug rather than a file-watch one. Keeping profiles in the OS temp directory
 * removes the hazard at the source rather than relying on an ignore rule that
 * a future config edit could drop.
 */
export function profileDir(name: string): string {
  return join(tmpdir(), 'neuron-e2e-profiles', name);
}


/** True while a PIN dialog whose text matches `title` is on screen. */
function pinDialogUp(d: Device, title: RegExp): Promise<boolean> {
  return d.page.evaluate((t: string) => {
    const overlay = [...document.querySelectorAll('div')].find((x) => x.style.zIndex === '9999');
    return !!overlay && new RegExp(t, 'i').test(overlay.textContent ?? '');
  }, title.source);
}

/**
 * Fill the PIN dialog whose title matches `title` and wait for it to close.
 *
 * It closes ITSELF: `promptPin` submits 80 ms after the fourth digit. Clicking
 * Confirm therefore races that removal and hangs on a detached button — while
 * the PIN has in fact been accepted, so the run fails on a step that worked.
 * The click stays only as a fallback for a dialog that did not self-submit.
 */
async function enterPin(d: Device, pin: string, title: RegExp): Promise<void> {
  await d.page.waitForFunction(
    (t: string) => {
      const overlay = [...document.querySelectorAll('div')].find((x) => x.style.zIndex === '9999');
      return !!overlay && new RegExp(t, 'i').test(overlay.textContent ?? '');
    },
    title.source, { timeout: 240_000 },
  );
  await d.page.locator('input[type="password"]:visible').last().fill(pin);

  const deadline = Date.now() + 20_000;
  let clicked = false;
  while (Date.now() < deadline) {
    if (!await pinDialogUp(d, title)) return;
    if (!clicked && Date.now() > deadline - 15_000) {
      clicked = true;
      await d.page.getByRole('button', { name: 'Confirm' }).click({ timeout: 5_000 }).catch(() => {});
    }
    await d.page.waitForTimeout(250);
  }
  throw new Error(`[${d.name}] PIN dialog "${title.source}" never closed`);
}


/**
 * A per-run tag, so each run's identities are its own.
 *
 * Both limits this trips are per-HUMAN, and a seed IS a human: testnet allows
 * `FACE_MAX` = 3 accounts per face, and a username belongs to the nid that
 * claimed it. Re-using a seed across runs therefore burns a face's three slots
 * and then fails with `Face limit reached (3/3)`, while re-using a username
 * fails with a 409 from a different nid. Both read as broken code rather than
 * exhausted quota, so neither is left to chance.
 */
export const E2E_RUN = Date.now().toString(36).slice(-6);

/**
 * Open a device and give it a brand-new account, with no human involved.
 *
 * This replaces the captured-session fixture entirely: there is nothing to
 * capture, so specs no longer skip for want of one. The account is real — real
 * attestation quorum, real v3 blob, real Shamir split — only the camera is
 * synthetic (`src/core/test-face.ts`).
 *
 * Each call costs one `/face-verify/verify` per attester against the per-IP
 * daily cap (24 on testnet), so a spec that needs three accounts costs three of
 * roughly eight full runs a day from one address. Create accounts in
 * `beforeAll`, never per test.
 */
export async function newAccountDevice(
  name: string, opts: OpenOptions & { pin?: string } = {},
): Promise<Device> {
  const ident = `${name}${E2E_RUN}`;
  const d = await openDevice(name, {
    headless: true,
    ...opts,
    // A fresh profile every run: the account is new, so carrying an old
    // profile's IndexedDB would seat a chain belonging to nobody here.
    userDataDir: opts.userDataDir ?? profileDir(`${name}-${E2E_RUN}`),
    fresh: opts.fresh ?? true,
    testFaceSeed: opts.testFaceSeed ?? `${ident}-face`,
  });
  try {
    await createAccount(d, ident, opts.pin ?? '1234');
  } catch (err) {  // eslint-disable-line @typescript-eslint/no-unused-vars
    // One retry, on a clean page. Creation talks to the relay several times and
    // a loaded machine (three describes' worth of browsers already opened and
    // closed) can stall it past the dialog timeout — observed once, and working
    // again seconds later. A retry is cheap; a run lost at the fourth setup is
    // twenty minutes. The reload matters: the first attempt may have left the
    // form mid-flow.
    // Creation talks to the relay several times, and by the fourth describe of
    // a run the machine has opened and closed a dozen browsers while the single
    // local relay has minted as many accounts. It stalls, then works again
    // seconds later. Two retries with a settle between, because one was not
    // enough to make a full-file run reliable — and a run lost at the last
    // setup is twenty minutes.
    console.warn(`[${name}] account creation failed, retrying: ${(err as Error).message.slice(0, 120)}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await d.page.waitForTimeout(10_000 * attempt);
      await d.page.reload();
      await d.log.waitFor(/\[StorageManager\] Started/, 120_000);
      try {
        const retryName = `${ident}r${attempt}`;
        await createAccount(d, retryName, opts.pin ?? '1234');
        d.username = retryName;
        await waitForGossipMesh(d);
        return d;
      } catch (again) {
        if (attempt === 2) throw again;
        console.warn(`[${name}] retry ${attempt} failed: ${(again as Error).message.slice(0, 100)}`);
      }
    }
  }
  d.username = ident;
  await waitForGossipMesh(d);
  return d;
}

/**
 * Is the synthetic-face bypass live on the dev server these specs talk to?
 *
 * Checked by BOOTING the app with a probe seed and looking for the banner, not
 * by reading the served source: Vite does not substitute `__TEST_FACE__` in the
 * raw module it hands back over HTTP, so a text probe reports false against a
 * server where the feature is in fact working. The result is cached — one
 * browser launch per run.
 */
let testFaceProbe: Promise<boolean> | undefined;
export function testFaceAvailable(): Promise<boolean> {
  testFaceProbe ??= (async () => {
    try {
      const d = await openDevice('test-face-probe', {
        headless: true, testFaceSeed: `probe-${E2E_RUN}`,
      });
      const present = (await d.page.locator('#testFaceBanner').count()) > 0;
      await d.close();
      return present;
    } catch {
      return false;
    }
  })();
  return testFaceProbe;
}

export const TEST_FACE_HINT =
  "synthetic face not active — restart the dev server with: $env:TEST_FACE = '1'; "
  + "$env:STORAGE_TIMING = 'fast'; npm run dev";


/**
 * Wait until the device has a circuit-relay reservation, i.e. until its gossip
 * can actually reach anyone.
 *
 * A freshly created profile starts with no mesh, and an announcement published
 * into that gap is simply not delivered — the file then reaches the archives
 * only on a later retry, minutes later. Tests read that as "the archive never
 * got it", which is a propagation-timing artefact rather than the behaviour
 * under test.
 *
 * There is no positive readiness line to wait for, so this waits for the
 * ABSENCE of `No circuit-relay addrs yet`: that warning is emitted by
 * `broadcastPeerAddrs` on its own timer, so a quiet window means a reservation
 * is held. Never fails the run — a slow mesh is a reason to wait, not a defect
 * for this helper to adjudicate.
 */
export async function waitForGossipMesh(d: Device, timeoutMs = 120_000): Promise<boolean> {
  const QUIET_MS = 20_000;
  const deadline = Date.now() + timeoutMs;
  let lastWarn = d.log.all(/No circuit-relay addrs yet/).length;
  let quietSince = Date.now();
  while (Date.now() < deadline) {
    await d.page.waitForTimeout(2_000);
    const now = d.log.all(/No circuit-relay addrs yet/).length;
    if (now > lastWarn) { lastWarn = now; quietSince = Date.now(); }
    if (Date.now() - quietSince >= QUIET_MS) return true;
  }
  return false;
}


/**
 * Click something and return the TOAST it produced.
 *
 * Several storage actions report only through a toast — the manual heartbeat
 * among them — and a toast removes itself after 4 s. Reading
 * `#serveStorageStatus` instead returns whatever the LAST action left there,
 * which is how "the early heartbeat was refused" was tested against the
 * registration's own success message and failed for the wrong reason.
 */
export async function clickForToast(d: Device, selector: string, timeoutMs = 30_000): Promise<string> {
  // Clear the tray first and count, rather than diffing text: the same action
  // can legitimately produce the SAME message twice, and a text-diff drops the
  // second one as "not fresh" — which reads as "no toast appeared".
  await d.page.evaluate(() => {
    for (const t of document.querySelectorAll('#toasts .toast')) t.remove();
  });
  await d.page.click(selector);
  const deadline = Date.now() + timeoutMs;
  let last: string[] = [];
  while (Date.now() < deadline) {
    last = await d.page.evaluate(() =>
      [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent ?? ''));
    if (last.length > 0) return last[last.length - 1]!;
    await d.page.waitForTimeout(200);
  }
  throw new Error(`[${d.name}] no toast after clicking ${selector} within ${timeoutMs}ms `
    + `(tray held: ${JSON.stringify(last)})`);
}
