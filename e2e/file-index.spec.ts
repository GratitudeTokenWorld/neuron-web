import { test, expect } from '@playwright/test';
import {
  openDevice, openStorageTab, storageStats, uploadFile, contentLibrary,
  relayFiles, RELAY_BASES, newAccountDevice, testFaceAvailable, TEST_FACE_HINT,
  profileDir, E2E_RUN, type Device,
} from './device';

/**
 * TESTPLAN T10 — the file index is no longer global.
 *
 * The last `O(N)` in storage: every client used to ingest and persist a record
 * for every file on the network. Now a client keeps its OWN files only and asks
 * the archives (`GET /files`) about anything else — the same on-demand,
 * verified-answer shape that closed G1, G2 and G3, and for the same reason.
 *
 * Two of these assertions are about where data ISN'T, which is the hard half:
 *
 *  - the relays are queried from Node, not through the page, because reading
 *    the archive through the client under test would prove nothing about which
 *    of the two holds the index;
 *  - the client's own-files-only claim is read off the RENDERED library rather
 *    than internals. Nothing exposes the node on `window`, and the defects that
 *    reached users were in the rendering anyway.
 */


test.describe('T10 — the archives hold the index', () => {
  test('step 1 — every relay answers /files with its OWN count', async () => {
    // `total` is that archive's own record count, never a network figure: no
    // node is allowed to claim knowledge of the whole network, which is the
    // entire point of removing the global topic.
    for (const base of RELAY_BASES) {
      const res = await relayFiles(base);
      expect(Array.isArray(res.records), `${base} returned no records array`).toBe(true);
      expect(typeof res.total).toBe('number');
      expect(res.total).toBeGreaterThanOrEqual(0);
      // Bounded answers only — an unbounded one is the O(N) firehose moved to HTTP.
      expect(res.records.length).toBeLessThanOrEqual(50);
    }
  });
});

test.describe('T10 — a client holds only its own files', () => {
  let a: Device, b: Device;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    a = await newAccountDevice('alice');
    b = await newAccountDevice('bob', { channel: 'msedge' });
  });

  test.afterAll(async () => { await Promise.all([a?.close(), b?.close()]); });

  test('step 2 — B never learns about A\'s file, while the archives do', async () => {
    test.setTimeout(600_000);
    await openStorageTab(a);
    await openStorageTab(b);

    const before = await contentLibrary(b);
    // Identified by FILENAME, not CID: the library renders the CID elided
    // (`bafkrei…c6xf6fq`), so a `toContain(cid)` check can never match — and the
    // negative half of this test would have passed for that reason alone,
    // which is a false green, not a passing test.
    const name = `own-files-only-${E2E_RUN}.bin`;
    const cid = await uploadFile(a, name, 32 * 1024);

    // Give the announcement every chance to reach B — the assertion is that it
    // does NOT, so a short wait would prove nothing. Before this change B held
    // A's record within seconds.
    await b.page.waitForTimeout(20_000);

    const after = await contentLibrary(b);
    expect(after.join('\n')).not.toContain(name);
    expect(after.length).toBe(before.length);

    // A's library does have it: own-files-only means own files, not no files.
    const mine = await contentLibrary(a);
    expect(mine.join('\n')).toContain(name);

    // Whether the ARCHIVE received it is asserted separately below: it depends
    // on gossip timing, while the claim under test here — that a client keeps
    // only its own files — does not. Folding the two together made a delivery
    // delay look like a failure of the index rule.
  });

  test('step 2b — the archives take the record even though no client did', async () => {
    test.setTimeout(900_000);
    const name = `archived-${E2E_RUN}.bin`;
    const cid = await uploadFile(a, name, 32 * 1024);

    // The first announcement is fire-and-forget: published into a mesh with no
    // subscriber, it is simply lost. The recovery is a RE-announce — 5 s after
    // start, 3 s after a peer connects, then every 5 MINUTES
    // (`storage-manager.ts` → reannounceTrackedFiles). So allow more than one
    // interval; a 5-minute poll sits exactly on the boundary.
    let seen = false;
    for (let i = 0; i < 90 && !seen; i++) {
      for (const base of RELAY_BASES) {
        const res = await relayFiles(base, { cid }).catch(() => ({ records: [], total: 0 }));
        if (res.records.some((r) => r.cid === cid)) { seen = true; break; }
      }
      if (!seen) await a.page.waitForTimeout(5_000);
    }
    expect(seen, `no archive holds ${cid.slice(0, 16)} after 450s (re-announce interval is 5 min)`).toBe(true);
  });

  test('step 4 — the archived-files chip reads "—" until an archive answers, never 0', async () => {
    // A count of 0 says "the network has no files"; the truth was "no archive
    // has answered yet". Rendering the unmeasured as a measurement is the
    // recurring defect class on this tab (see storage-ui.spec.ts for the rest).
    await openStorageTab(a);
    const stats = await storageStats(a);
    const label = Object.keys(stats).find((l) => /files/i.test(l));
    expect(label, 'no files chip on the Storage tab').toBeTruthy();
    // The label has to say the figure is the archives' view, not the network's.
    expect(label!).toMatch(/archiv/i);
    const value = stats[label!]!;
    if (value === '0') {
      throw new Error(`files chip reads a bare "0" — an unanswered archive must read "—" (label: ${label})`);
    }
    expect(value === '—' || /^\d/.test(value)).toBe(true);
  });

  test('step 5 — a withdrawal propagates as a tombstone, not an absence', async () => {
    test.setTimeout(600_000);
    // A holder has to be able to LEARN that a file was withdrawn. An absent
    // record is indistinguishable from one that never arrived, so the delete
    // has to be something a peer can ask for and verify.
    await openStorageTab(a);
    const cid = await uploadFile(a, 'withdraw-me.bin', 32 * 1024);

    // Same 5-minute re-announce interval as step 2 — see the note there.
    let published = false;
    for (let i = 0; i < 90 && !published; i++) {
      for (const base of RELAY_BASES) {
        const res = await relayFiles(base, { cid }).catch(() => ({ records: [], total: 0 }));
        if (res.records.some((r) => r.cid === cid)) { published = true; break; }
      }
      if (!published) await a.page.waitForTimeout(5_000);
    }
    expect(published, 'the file never reached an archive, so withdrawal cannot be tested').toBe(true);

    // Remove it through the UI the owner actually uses.
    await a.page.evaluate((c: string) => {
      const row = [...document.querySelectorAll('#contentLibraryList tr')]
        .find((r) => r.textContent?.includes(c.slice(0, 16)));
      const btn = row?.querySelector<HTMLButtonElement>('button[data-remove], button.btn-danger, button');
      btn?.click();
    }, cid);
    await a.page.click('#btnRemoveFileConfirm', { timeout: 15_000 });

    let tombstoned = false;
    for (let i = 0; i < 24 && !tombstoned; i++) {
      for (const base of RELAY_BASES) {
        const res = await relayFiles(base, { cid }).catch(() => ({ records: [], total: 0 }));
        if (res.records.some((r) => r.cid === cid && r.removed === true)) { tombstoned = true; break; }
      }
      if (!tombstoned) await a.page.waitForTimeout(5_000);
    }
    expect(tombstoned, `no archive shows ${cid.slice(0, 16)} as removed:true`).toBe(true);
  });
});

test.describe('T10 — the one-time migration off the global index', () => {
  test('step 3 — a foreign record on disk is dropped once, and stays dropped', async () => {
    test.setTimeout(600_000);
    test.skip(!await testFaceAvailable(), TEST_FACE_HINT);
    // A device that ran an older build has an IDB store holding a record per
    // file it ever saw announced, and `start()` loads it back — so filtering
    // live gossip alone would leave the O(N) set on disk forever. This seeds
    // exactly that state rather than waiting to meet a legacy device.
    // Needs an account, because the prune only runs once keys are registered —
    // "ours" is undecidable before that, and pruning then would delete the
    // node's own records.
    const dir = profileDir(`migration-${E2E_RUN}`);
    let d = await newAccountDevice('migration', { userDataDir: dir });

    const planted = await d.page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      // The EXACT ledger database. Three start with `neuronchain-`
      // (`-security`, `-smoke-blocks`, `-testnet`), and a prefix match picked
      // `-security`, which has no fileIndex store — reported as "no fileIndex
      // store", which reads like the store was never created.
      const name = dbs.map((x) => x.name).find((n) => /^neuronchain-(testnet|mainnet)$/.test(n ?? ''));
      if (!name) return `no ledger database (saw: ${dbs.map((x) => x.name).join(', ')})`;
      return new Promise<string>((resolve) => {
        const req = indexedDB.open(name);
        req.onerror = () => resolve('open failed');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('fileIndex')) { db.close(); return resolve('no fileIndex store'); }
          const tx = db.transaction('fileIndex', 'readwrite');
          // uploaderPub is a key this device does not hold — that is what makes
          // the record foreign, and it is the only thing the prune looks at.
          tx.objectStore('fileIndex').put({
            cid: 'bafy-foreign-legacy-record-0001',
            sizeBytes: 4096,
            mimeType: 'application/octet-stream',
            timestamp: Date.now(),
            uploaderPub: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          });
          tx.oncomplete = () => { db.close(); resolve('ok'); };
          tx.onerror = () => { db.close(); resolve('write failed'); };
        };
      });
    });
    expect(planted, 'could not seed a legacy record').toBe('ok');

    // Restart: the prune runs after keys are registered, because "ours" is
    // undecidable before that.
    await d.page.reload();
    const dropped = await d.log.waitFor(/Dropped \d+ foreign file record\(s\)/, 180_000);
    expect(dropped).toMatch(/the index is own-files-only now/);

    // Second start: nothing left to drop. If this line appears again the store
    // was never actually emptied and the O(N) set returns on every boot.
    await d.close();
    // Let the tab lock clear before reopening. `tab-lock.ts` refuses a second
    // live tab for the same profile, and the lock outlives `context.close()` by
    // a moment — reopening immediately boots into
    // `Tab locked - another NeuronChain tab is active`, which looks like a
    // migration failure and is really the app protecting its own chain.
    await new Promise((r) => setTimeout(r, 15_000));
    // Same profile, no reseed — the second boot of the same device.
    d = await openDevice('migration', { userDataDir: dir, headless: true });
    await d.page.waitForTimeout(20_000);
    d.log.none(/Dropped \d+ foreign file record\(s\)/);
    await d.close();
  });
});
