import { test, expect } from '@playwright/test';
import { openDevice, openStorageTab, storageStats, providerRow, type Device } from './device';
import { existsSync } from 'node:fs';

/**
 * The Storage tab's NUMBERS.
 *
 * Every defect this file guards was found by a human noticing a figure that
 * could not be true — uptime disagreeing with the score beside it, an "average"
 * computed from one sample, "7/6 heartbeats due", "LAST REWARD -59066340h ago".
 * None of them broke a unit test, because each half was individually correct
 * and only the RENDERED combination was wrong. That is exactly the class a
 * browser can check and a unit test cannot.
 *
 * Requires a captured session (`npm run e2e:capture alice`) and a running dev
 * stack. Skipped rather than failed without one: a missing fixture is not a
 * regression, and a red suite that means "you did not set up" trains people to
 * ignore red.
 */
const SESSION = 'e2e/.sessions/alice.json';

test.describe('storage tab renders only what it measured', () => {
  test.skip(!existsSync(SESSION), `no captured session at ${SESSION} — run: npm run e2e:capture alice`);

  let d: Device;
  test.beforeAll(async () => {
    d = await openDevice('alice', { storageStatePath: SESSION, headless: true });
    await openStorageTab(d);
  });
  test.afterAll(async () => { await d?.close(); });

  test('aggregates carry their sample size, never a bare average', async () => {
    // "Avg Uptime" averaged the providers whose chain this node holds — its own
    // accounts — so on a two-device network each device averaged ITSELF and
    // neither number was an average of anything.
    const stats = await storageStats(d);
    const labels = Object.keys(stats);
    expect(labels.some((l) => /^avg uptime$/i.test(l))).toBe(false);
    expect(labels.some((l) => /uptime \(/i.test(l))).toBe(true);
    expect(labels.some((l) => /score \(/i.test(l))).toBe(true);
  });

  test('an unmeasured figure reads "—", never 0', async () => {
    // A network file count of 0 says "the network has no files"; the truth was
    // "no archive has answered yet". Same for a stranger's uptime.
    const stats = await storageStats(d);
    for (const [label, value] of Object.entries(stats)) {
      if (!/measured/i.test(label)) continue;
      if (/none measured/i.test(label)) {
        expect(value, `${label} should be "—" when nothing is measured`).toBe('—');
      }
    }
  });

  test('uptime and score agree about the same provider', async () => {
    // These were computed three ways with two denominators, so the UPTIME column
    // and the SCORE beside it described one provider differently. With no
    // latency or spot-check evidence, score IS the uptime fraction.
    const row = await providerRow(d, '(you)');
    test.skip(!row, 'this device is not serving storage');
    const uptime = /(\d+)%/.exec(row!);
    const score = /([01]\.\d{3})/.exec(row!);
    test.skip(!uptime || !score, `row has no measured uptime/score yet: ${row}`);
    const pct = Number(uptime![1]) / 100;
    const s = Number(score![1]);
    // Score = uptime x latency x spot-check, each floored at 0.1 and capped at 1,
    // so score can be LOWER than uptime but never higher than it.
    expect(s, `uptime ${pct} vs score ${s} in: ${row}`).toBeLessThanOrEqual(pct + 0.001);
  });

  test('a renewal count never exceeds the renewals due', async () => {
    // "100% (7/6 renewals)" — the numerator was counted over a window half an
    // interval wider than the denominator represented. Impossible on its face.
    const text = await d.page.textContent('#myStorageStats').catch(() => null);
    test.skip(!text, 'this device is not serving storage');
    const m = /(\d+)\s*\/\s*(\d+)\s*renewals/.exec(text!);
    test.skip(!m, `no renewals figure rendered: ${text?.slice(0, 120)}`);
    expect(Number(m![1]), `"${m![0]}" is impossible`).toBeLessThanOrEqual(Number(m![2]));
  });

  test('no elapsed time is negative', async () => {
    // "LAST REWARD -59066340h ago": an epoch index times a hardcoded 24h, in a
    // build where an epoch is 12 minutes. Any negative duration on screen is a
    // unit mismatch, so catch the whole class rather than that one field.
    const body = (await d.page.textContent('body')) ?? '';
    const negatives = body.match(/-\d+\s*(ms|s|m|h|d|min|hours?|days?)\b/gi) ?? [];
    expect(negatives, `negative durations rendered: ${negatives.join(', ')}`).toEqual([]);
  });

  test('a provider we hold no chain for shows dashes, not defaults', async () => {
    // Scoring the unknown as 1.0 made every node rank strangers above itself.
    // A discovered provider must render "—" for uptime/score/earnings, and may
    // still show what its signed heartbeat actually carries (capacity, seen).
    const rows = await d.page.evaluate(() => [...document.querySelectorAll('#storageProvidersList tr')]
      .map((r) => r.textContent!.replace(/\s+/g, ' ').trim())
      .filter((t) => t && !t.includes('(you)')));
    test.skip(rows.length === 0, 'no remote providers discovered yet');
    for (const row of rows) {
      expect(row, `a discovered provider must not render a score: ${row}`).not.toMatch(/1\.000/);
    }
  });
});
