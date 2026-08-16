import { describe, it, expect } from 'vitest';
import {
  FILE_QUERY_LIMIT_MAX,
  fileAnnouncePayload,
  fileRemovePayload,
  payloadFor,
  isWellFormedFileRecord,
  selectFileRecords,
  foldFileRecords,
  countLiveFiles,
  tombstoneExpired,
  TOMBSTONE_RETAIN_MS,
  type FileRecord,
} from './file-index.js';
import { MAX_OFFLINE_MS } from './provider-ledger.js';

/**
 * A stand-in signer: the "signature" is the payload the signer actually signed,
 * prefixed by who signed it. That makes the interesting failure directly
 * expressible — a record whose FIELDS say one thing while the signature covers
 * another — which is the case a verifier that trusted the envelope would pass.
 */
const sign = (pub: string, payload: string) => `${pub}|${payload}`;
const verify = (payload: string, pub: string, signature: string) => signature === sign(pub, payload);

function rec(over: Partial<FileRecord> = {}): FileRecord {
  const base = {
    cid: 'cid1', sizeBytes: 1024, mimeType: 'image/png',
    timestamp: 1_000, uploaderPub: 'alice',
  };
  const merged = { ...base, ...over };
  const payload = merged.removed
    ? fileRemovePayload(merged.cid, merged.uploaderPub, merged.timestamp)
    : fileAnnouncePayload(merged);
  return { ...merged, signature: sign(merged.uploaderPub, payload), ...over.signature ? { signature: over.signature } : {} };
}

describe('payloads', () => {
  it('announce and remove are distinct strings for the same file', () => {
    const r = rec();
    expect(fileAnnouncePayload(r)).not.toBe(fileRemovePayload(r.cid, r.uploaderPub, r.timestamp));
  });

  it('payloadFor picks the one the record actually claims', () => {
    expect(payloadFor(rec())).toBe(fileAnnouncePayload(rec()));
    const tomb = rec({ removed: true });
    expect(payloadFor(tomb)).toBe(fileRemovePayload(tomb.cid, tomb.uploaderPub, tomb.timestamp));
  });

  it('the payload binds size and uploader, not just the CID', () => {
    const a = fileAnnouncePayload({ cid: 'c', sizeBytes: 1, uploaderPub: 'alice', timestamp: 5 });
    expect(a).not.toBe(fileAnnouncePayload({ cid: 'c', sizeBytes: 999, uploaderPub: 'alice', timestamp: 5 }));
    expect(a).not.toBe(fileAnnouncePayload({ cid: 'c', sizeBytes: 1, uploaderPub: 'mallory', timestamp: 5 }));
  });
});

describe('isWellFormedFileRecord', () => {
  it('accepts a good record', () => {
    expect(isWellFormedFileRecord(rec())).toBe(true);
  });

  it.each([
    ['no cid', { cid: '' }],
    ['no uploader', { uploaderPub: '' }],
    ['no signature', { signature: '' }],
    ['negative size', { sizeBytes: -1 }],
    ['NaN size', { sizeBytes: NaN }],
    ['zero timestamp', { timestamp: 0 }],
  ])('rejects: %s', (_label, over) => {
    expect(isWellFormedFileRecord({ ...rec(), ...over })).toBe(false);
  });

  it('rejects an absurdly long CID rather than storing it', () => {
    expect(isWellFormedFileRecord({ ...rec(), cid: 'x'.repeat(300) })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const v of [null, undefined, 42, 'cid', []]) expect(isWellFormedFileRecord(v)).toBe(false);
  });
});

describe('selectFileRecords', () => {
  it('filters by cid', () => {
    const out = selectFileRecords([rec({ cid: 'a' }), rec({ cid: 'b' })], { cid: 'b' });
    expect(out.map(r => r.cid)).toEqual(['b']);
  });

  it('filters by owner', () => {
    const out = selectFileRecords(
      [rec({ cid: 'a', uploaderPub: 'alice' }), rec({ cid: 'b', uploaderPub: 'bob' })],
      { owner: 'bob' },
    );
    expect(out.map(r => r.cid)).toEqual(['b']);
  });

  it('keeps only the newest record per CID', () => {
    const out = selectFileRecords([
      rec({ cid: 'a', timestamp: 1 }),
      rec({ cid: 'a', timestamp: 9 }),
      rec({ cid: 'a', timestamp: 5 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.timestamp).toBe(9);
  });

  it('a withdrawal supersedes the announcement it withdraws', () => {
    // Not both rows with the client left to pick: newest per CID wins, and the
    // withdrawal is newest. Whether it is then SERVED depends on the query —
    // see the browse-vs-lookup rule below.
    const rows = [rec({ cid: 'a', timestamp: 1 }), rec({ cid: 'a', timestamp: 2, removed: true })];
    expect(selectFileRecords(rows)).toHaveLength(0);              // browse: hidden
    expect(selectFileRecords(rows, { cid: 'a' })[0]!.removed).toBe(true);   // lookup: told
  });

  it('bounds the answer — an unbounded one is the firehose over HTTP', () => {
    const many = Array.from({ length: 500 }, (_, i) => rec({ cid: `c${i}`, timestamp: i + 1 }));
    expect(selectFileRecords(many, { limit: 10 })).toHaveLength(10);
    expect(selectFileRecords(many)).toHaveLength(50);                       // default
    expect(selectFileRecords(many, { limit: 10_000 })).toHaveLength(FILE_QUERY_LIMIT_MAX);
    expect(selectFileRecords(many, { limit: 0 })).toHaveLength(1);          // never zero-length by accident
  });

  it('returns the newest page, so a bounded answer is the useful half', () => {
    const many = Array.from({ length: 100 }, (_, i) => rec({ cid: `c${i}`, timestamp: i + 1 }));
    const page = selectFileRecords(many, { limit: 3 });
    expect(page.map(r => r.timestamp)).toEqual([100, 99, 98]);
  });

  it('drops malformed rows instead of serving them', () => {
    const out = selectFileRecords([rec(), { cid: '', sizeBytes: 1 } as unknown as FileRecord]);
    expect(out).toHaveLength(1);
  });
});

describe('foldFileRecords', () => {
  it('accepts records the uploader actually signed', async () => {
    const idx = await foldFileRecords([rec({ cid: 'a' }), rec({ cid: 'b' })], verify);
    expect([...idx.keys()].sort()).toEqual(['a', 'b']);
  });

  it('drops a record signed by someone else', async () => {
    const forged = { ...rec({ cid: 'a', uploaderPub: 'alice' }), signature: sign('mallory', fileAnnouncePayload(rec())) };
    const idx = await foldFileRecords([forged], verify);
    expect(idx.size).toBe(0);
  });

  it('rebuilds the payload from the FIELDS, so an inflated size cannot ride a valid signature', async () => {
    // The signature covers the honest 1024-byte announcement; the record claims
    // a gigabyte. A verifier that checked the signed envelope's own string would
    // pass this — the payload must be reconstructed from what the record says.
    const honest = rec({ cid: 'a', sizeBytes: 1024 });
    const inflated: FileRecord = { ...honest, sizeBytes: 1_073_741_824 };
    const idx = await foldFileRecords([inflated], verify);
    expect(idx.size).toBe(0);
  });

  it('a tombstone removes the file rather than inserting a row', async () => {
    const idx = await foldFileRecords([
      rec({ cid: 'a', timestamp: 1 }),
      rec({ cid: 'a', timestamp: 2, removed: true }),
    ], verify);
    expect(idx.has('a')).toBe(false);
  });

  it('an archive holding a stale announcement cannot revive a withdrawn file', async () => {
    // Order reversed: the withdrawal arrives first, the old announcement after.
    const idx = await foldFileRecords([
      rec({ cid: 'a', timestamp: 9, removed: true }),
      rec({ cid: 'a', timestamp: 1 }),
    ], verify);
    expect(idx.has('a')).toBe(false);
  });

  it('a NEWER announcement after a withdrawal re-publishes the file', async () => {
    const idx = await foldFileRecords([
      rec({ cid: 'a', timestamp: 5, removed: true }),
      rec({ cid: 'a', timestamp: 6 }),
    ], verify);
    expect(idx.has('a')).toBe(true);
  });

  it('one broken row does not deny service for the good ones', async () => {
    const idx = await foldFileRecords([
      { garbage: true } as unknown as FileRecord,
      { ...rec({ cid: 'b' }), signature: 'nope' },
      rec({ cid: 'c' }),
    ], verify);
    expect([...idx.keys()]).toEqual(['c']);
  });

  it('works with an async verifier (WebCrypto is async)', async () => {
    const idx = await foldFileRecords([rec({ cid: 'a' })], async (p, k, s) => verify(p, k, s));
    expect(idx.size).toBe(1);
  });
});

// ── Tombstones are not files ─────────────────────────────────────────────────

describe('countLiveFiles', () => {
  it('does not count withdrawals', () => {
    // The bug: the Storage tab reported "4 files archived" on a network with
    // none — all four rows were withdrawals left by the smoke probe.
    const withdrawn = [
      rec({ cid: 'a', timestamp: 1 }), rec({ cid: 'a', timestamp: 2, removed: true }),
      rec({ cid: 'b', timestamp: 1 }), rec({ cid: 'b', timestamp: 2, removed: true }),
    ];
    expect(withdrawn).toHaveLength(4);
    expect(countLiveFiles(withdrawn)).toBe(0);
  });

  it('counts a file once however many times it was re-announced', () => {
    expect(countLiveFiles([
      rec({ cid: 'a', timestamp: 1 }), rec({ cid: 'a', timestamp: 5 }), rec({ cid: 'a', timestamp: 9 }),
    ])).toBe(1);
  });

  it('counts a file that was withdrawn and then re-published', () => {
    expect(countLiveFiles([
      rec({ cid: 'a', timestamp: 1 }),
      rec({ cid: 'a', timestamp: 2, removed: true }),
      rec({ cid: 'a', timestamp: 3 }),
    ])).toBe(1);
  });

  it('ignores malformed rows', () => {
    expect(countLiveFiles([rec({ cid: 'a' }), { cid: '' } as unknown as FileRecord])).toBe(1);
  });
});

describe('tombstone retention', () => {
  it('outlives the custody lease, so a returning holder can still be told', () => {
    // A node absent longer than MAX_OFFLINE discards everything on rejoin, so it
    // never needs to hear about individual deletions — the window only has to
    // cover holders whose lease is still alive.
    expect(TOMBSTONE_RETAIN_MS).toBeGreaterThan(MAX_OFFLINE_MS);
  });

  it('expires a withdrawal only after the window', () => {
    const t = rec({ cid: 'a', timestamp: 1_000, removed: true });
    expect(tombstoneExpired(t, 1_000 + TOMBSTONE_RETAIN_MS)).toBe(false);
    expect(tombstoneExpired(t, 1_000 + TOMBSTONE_RETAIN_MS + 1)).toBe(true);
  });

  it('never expires a live announcement — this prunes deletions only', () => {
    const live = rec({ cid: 'a', timestamp: 1_000 });
    expect(tombstoneExpired(live, 1_000 + TOMBSTONE_RETAIN_MS * 100)).toBe(false);
  });
});

describe('selectFileRecords — tombstones in a browse vs a lookup', () => {
  const mixed = [
    rec({ cid: 'live', timestamp: 1 }),
    rec({ cid: 'gone', timestamp: 9, removed: true }),
  ];

  it('hides withdrawals from a browse', () => {
    // The page is newest-first and deletions are by definition the newest thing
    // that happened, so on a busy network every page would be tombstones and no
    // live file would ever appear.
    expect(selectFileRecords(mixed).map(r => r.cid)).toEqual(['live']);
  });

  it('still serves one when it is asked for BY CID', () => {
    const out = selectFileRecords(mixed, { cid: 'gone' });
    expect(out).toHaveLength(1);
    expect(out[0]!.removed).toBe(true);
  });

  it('a browse by owner also hides withdrawals', () => {
    expect(selectFileRecords(mixed, { owner: 'alice' }).map(r => r.cid)).toEqual(['live']);
  });
});
