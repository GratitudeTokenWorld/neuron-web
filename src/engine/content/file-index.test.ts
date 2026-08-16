import { describe, it, expect } from 'vitest';
import {
  FILE_QUERY_LIMIT_MAX,
  fileAnnouncePayload,
  fileRemovePayload,
  payloadFor,
  isWellFormedFileRecord,
  selectFileRecords,
  foldFileRecords,
  type FileRecord,
} from './file-index.js';

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

  it('still serves tombstones — silence cannot tell a holder a file was withdrawn', () => {
    const out = selectFileRecords([rec({ cid: 'a', timestamp: 1 }), rec({ cid: 'a', timestamp: 2, removed: true })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.removed).toBe(true);
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
