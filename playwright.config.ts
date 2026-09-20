import { defineConfig } from '@playwright/test';

/**
 * E2E against a RUNNING dev stack — it never starts one.
 *
 * `npm run dev` spawns the relay, and the relay owns durable identity
 * (`.relay-data/`: peer id, attester key, recovery shares). A runner that
 * started and killed its own stack would churn that, and the baked bootstrap
 * multiaddrs embed the relay's peer id — so a fresh peer id makes every client
 * in the repo unable to find it. Start the stack yourself; these specs attach.
 *
 * Uses the INSTALLED Chrome and Edge (`channel:`) rather than Playwright's
 * bundled Chromium, because that is the topology being tested by hand: two real
 * browser profiles on one machine, each with its own IndexedDB, talking over
 * loopback WebRTC. No 150 MB browser download either.
 *
 * Serial, one worker: these specs drive a shared live network with real relays
 * and real chains. Parallel workers would interleave writes to the same
 * accounts and fork them — which on this ledger is not a flaky test, it is a
 * permanently frozen account (see CLAUDE.md → equivocation).
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  // Storage steps wait on real leases and real transfers: a 6-minute lease under
  // STORAGE_TIMING=fast, a 100 MB WebRTC pull. Per-test timeouts are set in the
  // specs that need them; this is the floor for everything else.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'off',
    // The app needs a secure context for the camera; localhost counts as one, so
    // no HTTPS is required for anything except the face flows we cannot automate.
    permissions: [],
  },
});
