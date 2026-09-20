/**
 * Capture a logged-in browser session so E2E specs can skip account creation.
 *
 *   npx tsx e2e/capture-session.mts alice            (then create/recover in the window)
 *
 * WHY THIS IS MANUAL: creating an account needs a live face through a depth
 * sweep and five randomly-ordered actions. A synthetic video stream cannot pass
 * that — deliberately, because defeating the gate with a recording is the exact
 * attack it exists to stop. So a human does it ONCE per account and the session
 * is reused.
 *
 * What gets saved is localStorage, which holds the wallet keys. IndexedDB (the
 * chain, the file index, tracked CIDs) is NOT saved and does not need to be: a
 * seeded device re-syncs its own chain from the archives on start, which is the
 * same path a recovered device takes. That also means a captured session keeps
 * working across a testnet reset of the CHAIN — but not across an account wipe,
 * since the keys go with it. Re-capture after any reset that destroys accounts.
 *
 * ⚠ The file contains WALLET KEYS. `e2e/.sessions/` is gitignored; never commit
 * one, never paste one into an issue, and treat it like `.relay-*`.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const name = process.argv[2];
if (!name) {
  console.error('usage: npx tsx e2e/capture-session.mts <name>   e.g. alice');
  process.exit(1);
}
const out = `e2e/.sessions/${name}.json`;
const url = process.env.E2E_BASE_URL || 'http://localhost:5173';

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome', headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(url);

console.log(`\n  A browser window is open at ${url}.`);
console.log(`  Create or recover the account you want to save as "${name}".`);
console.log(`  When the account is loaded and the Storage tab looks right, press ENTER here.\n`);

await new Promise<void>((resolve) => {
  process.stdin.once('data', () => resolve());
  process.stdin.resume();
});

await mkdir(dirname(out), { recursive: true });
await context.storageState({ path: out });
const hasWallet = (await context.storageState()).origins
  .some((o) => o.localStorage.some((kv) => kv.name === 'neuronchain_wallet'));
console.log(hasWallet
  ? `\n  Saved ${out} — wallet keys present.`
  : `\n  Saved ${out} but NO neuronchain_wallet key was found. The account is not loaded; re-run.`);
await browser.close();
process.exit(hasWallet ? 0 : 1);
