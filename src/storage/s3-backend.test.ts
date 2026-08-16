import { describe, it, expect } from 'vitest';
import { S3Backend, s3BackendFromEnv, type S3BackendConfig } from './s3-backend.js';

/**
 * A tiny in-memory S3, enough to exercise the adapter end to end without a
 * bucket: HEAD/GET/PUT/DELETE on a key, plus a paginated ListObjectsV2 that
 * truncates at `pageSize` exactly as the real one does at 1000.
 *
 * It also RECORDS every request, so the tests can assert the things that only
 * show up on the wire — that every call is signed, that the key layout is what
 * it claims to be, and that a listing actually follows its continuation token.
 */
function fakeS3(pageSize = 1000) {
  const objects = new Map<string, Uint8Array>();
  const requests: { method: string; url: string; auth: string | undefined }[] = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ method, url: String(input), auth: headers.authorization });

    const listType = url.searchParams.get('list-type');
    if (method === 'GET' && listType === '2') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token') ?? '';
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix) && k > after).sort();
      const page = keys.slice(0, pageSize);
      const truncated = keys.length > page.length;
      const xml = `<ListBucketResult>${page.map(k =>
        `<Contents><Key>${k}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join('')
        }<IsTruncated>${truncated}</IsTruncated>${truncated
          ? `<NextContinuationToken>${page[page.length - 1]}</NextContinuationToken>` : ''
        }</ListBucketResult>`;
      return new Response(xml, { status: 200 });
    }

    // Path style: /<bucket>/<key…>
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'PUT') {
      objects.set(key, new Uint8Array(init!.body as ArrayBuffer));
      return new Response(null, { status: 200 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const held = objects.get(key);
    if (!held) return new Response(null, { status: 404 });
    if (method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': String(held.length) } });
    }
    return new Response(held.slice().buffer as ArrayBuffer, { status: 200 });
  }) as unknown as typeof fetch;

  return { objects, requests, fetchFn };
}

const CONFIG: S3BackendConfig = {
  endpoint: 'http://minio.lan:9000',
  bucket: 'neuron',
  region: 'us-east-1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

const CID_A = 'abcdef0123456789';
const CID_B = 'fedcba9876543210';
const bytes = (...v: number[]) => new Uint8Array(v);

function backend(over: Partial<S3BackendConfig> = {}, pageSize = 1000) {
  const s3 = fakeS3(pageSize);
  const be = new S3Backend({ ...CONFIG, ...over }, { fetch: s3.fetchFn, now: () => 1_440_938_160_000 });
  return { be, ...s3 };
}

describe('S3Backend — BlockBackend contract', () => {
  it('stores and reads back a block', async () => {
    const { be } = backend();
    expect(await be.put(CID_A, bytes(1, 2, 3))).toBe(3);
    expect(await be.has(CID_A)).toBe(true);
    expect([...(await be.get(CID_A))!]).toEqual([1, 2, 3]);
  });

  it('is a no-op for a block already held — content addressing means no rewrite', async () => {
    const { be, requests } = backend();
    await be.put(CID_A, bytes(1, 2, 3));
    const putsBefore = requests.filter(r => r.method === 'PUT').length;
    expect(await be.put(CID_A, bytes(1, 2, 3))).toBe(0);
    expect(requests.filter(r => r.method === 'PUT').length).toBe(putsBefore);
  });

  it('reports a miss as undefined, not as an error', async () => {
    const { be } = backend();
    expect(await be.get(CID_A)).toBeUndefined();
    expect(await be.has(CID_A)).toBe(false);
  });

  it('delete returns the bytes freed, and 0 for a block it never held', async () => {
    const { be } = backend();
    await be.put(CID_A, bytes(1, 2, 3, 4));
    expect(await be.delete(CID_A)).toBe(4);
    expect(await be.delete(CID_A)).toBe(0);
    expect(await be.has(CID_A)).toBe(false);
  });

  it('tracks bytesUsed across writes and deletes', async () => {
    const { be } = backend();
    expect(await be.bytesUsed()).toBe(0);
    await be.put(CID_A, bytes(1, 2, 3));
    await be.put(CID_B, bytes(4, 5));
    expect(await be.bytesUsed()).toBe(5);
    await be.delete(CID_A);
    expect(await be.bytesUsed()).toBe(2);
  });

  it('lists what it holds', async () => {
    const { be } = backend();
    await be.put(CID_A, bytes(1));
    await be.put(CID_B, bytes(2));
    expect((await be.list()).sort()).toEqual([CID_A, CID_B].sort());
  });
});

describe('S3Backend — the details that only fail in production', () => {
  it('signs every request', async () => {
    const { be, requests } = backend();
    await be.put(CID_A, bytes(1));
    await be.get(CID_A);
    await be.list();
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it('uses the same two-character fan-out as the filesystem backend', async () => {
    // So a bucket written by one backend is readable by the other; an operator
    // moving between local disk and an object store should not re-upload.
    const { be, objects } = backend();
    await be.put(CID_A, bytes(1));
    expect([...objects.keys()]).toEqual([`${CID_A.slice(0, 2)}/${CID_A}`]);
  });

  it('honours a key prefix, with or without stray slashes', async () => {
    for (const prefix of ['blocks', '/blocks/', 'blocks/']) {
      const { be, objects } = backend({ prefix });
      await be.put(CID_A, bytes(1));
      expect([...objects.keys()]).toEqual([`blocks/${CID_A.slice(0, 2)}/${CID_A}`]);
    }
  });

  it('follows continuation tokens — a listing that stopped at one page would under-report usage', async () => {
    const s3 = fakeS3(2);                     // pages of 2, like S3's 1000
    const be = new S3Backend(CONFIG, { fetch: s3.fetchFn });
    const cids = ['aa11', 'bb22', 'cc33', 'dd44', 'ee55'];
    for (const c of cids) await be.put(c, bytes(1, 2, 3));

    expect((await be.list()).sort()).toEqual([...cids].sort());
    // Three pages of two for five keys, so the loop genuinely iterated.
    expect(s3.requests.filter(r => r.url.includes('list-type')).length).toBeGreaterThan(1);

    // And a FRESH backend, which has no incrementally-tracked total, still gets
    // the right usage — that figure comes from the paginated scan alone.
    const fresh = new S3Backend(CONFIG, { fetch: s3.fetchFn });
    expect(await fresh.bytesUsed()).toBe(cids.length * 3);
  });

  it('ignores keys the network did not write — a shared bucket is the operator\'s business', async () => {
    const { be, objects } = backend();
    objects.set('ab/not-a-cid.txt', bytes(9, 9, 9));
    await be.put(CID_A, bytes(1));
    expect(await be.list()).toEqual([CID_A]);
  });

  it('THROWS on a failed write rather than reporting 0 bytes added', async () => {
    // 0 is indistinguishable from "already held", so a swallowed write error
    // would have the caller record a replica that does not exist — the inflated
    // redundancy the whole lease model exists to prevent.
    const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const be = new S3Backend(CONFIG, { fetch: failing });
    await expect(be.put(CID_A, bytes(1))).rejects.toThrow(/500/);
  });

  it('reports a network failure on READ as a miss, not a throw', async () => {
    const broken = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const be = new S3Backend(CONFIG, { fetch: broken });
    expect(await be.get(CID_A)).toBeUndefined();
    expect(await be.has(CID_A)).toBe(false);
  });

  it('refuses a malformed cid instead of walking out of the prefix', async () => {
    const { be } = backend({ prefix: 'mine' });
    for (const bad of ['../../etc/passwd', 'not hex', '', 'ab']) {
      await expect(be.get(bad)).rejects.toThrow(/invalid cid/);
    }
  });

  it('supports virtual-host addressing when the operator asks for it', async () => {
    const { be, requests } = backend({ forcePathStyle: false });
    await be.put(CID_A, bytes(1)).catch(() => {});
    expect(requests[0]!.url).toContain('//neuron.minio.lan:9000/');
  });
});

describe('s3BackendFromEnv — opt-in, never a default', () => {
  const FULL = {
    S3_ENDPOINT: 'http://minio.lan:9000',
    S3_BUCKET: 'neuron',
    S3_ACCESS_KEY_ID: 'k',
    S3_SECRET_ACCESS_KEY: 's',
  };

  it('returns undefined with no configuration at all', () => {
    // The load-bearing test in this file. A node that has not opted in must get
    // local disk, and "no object store" must be an ordinary answer rather than
    // an error — otherwise the network has acquired a required party.
    expect(s3BackendFromEnv({})).toBeUndefined();
  });

  it.each(Object.keys(FULL))('returns undefined when %s is missing', (missing) => {
    const env: Record<string, string | undefined> = { ...FULL };
    delete env[missing];
    expect(s3BackendFromEnv(env)).toBeUndefined();
  });

  it('builds a backend only when the operator supplied everything', () => {
    expect(s3BackendFromEnv(FULL)).toBeInstanceOf(S3Backend);
  });

  it('has no default endpoint or bucket to fall back on', () => {
    // A default endpoint would be auto-discovery by another name.
    expect(s3BackendFromEnv({ S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's' })).toBeUndefined();
    expect(s3BackendFromEnv({ S3_ENDPOINT: 'http://x', S3_BUCKET: 'b' })).toBeUndefined();
  });

  it('rejects an incomplete config passed directly, too', () => {
    expect(() => new S3Backend({ ...CONFIG, bucket: '' })).toThrow(/bucket/);
    expect(() => new S3Backend({ ...CONFIG, secretAccessKey: '' })).toThrow(/secretAccessKey/);
  });
});
