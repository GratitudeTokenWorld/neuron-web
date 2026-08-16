import type { BlockBackend } from '../engine/content/backend.js';
import type { Cid } from '../engine/content/cid.js';
import { signRequest, payloadHash, amzDate, uriEncode } from './sigv4.js';

/**
 * S3-compatible block backend — **opt-in, operator-configured, never a default.**
 *
 * > Constraint (Lucian, 2026-08-10): any S3 adapter is MANUALLY CONFIGURED by
 * > the node operator — never a default, never auto-discovered, never assumed to
 * > exist. The protocol must run with every node on plain local disk.
 *
 * That constraint is not a style note, it is the participation model applied to
 * disks: if any part of the core reached for an object store, the network would
 * have acquired a required party, and "no role is required" would be false for
 * the one role that holds the data. So this file is inert unless an operator
 * supplies credentials — `s3BackendFromEnv` returns `undefined` when they are
 * absent, and there is no fallback endpoint anywhere in the tree to find.
 *
 * What it is FOR: an operator who already has elastic capacity (MinIO, Garage,
 * Ceph RGW, Backblaze B2, Wasabi, AWS) and would rather lease that to the
 * network than provision disks. They remain bound by every rule a local-disk
 * node is bound by — declared capacity, proven custody, repaired around when
 * offline — because the lease is enforced on-chain and knows nothing about where
 * the bytes sit.
 *
 * What it is NOT: an S3 *server*. Implementing one is commodity work with mature
 * free implementations, and it would compete for attention with the lease/repair
 * logic that is the actual novelty here (ARCHITECTURE.md → Subsystem 4).
 *
 * The interface stays deliberately narrower than S3's. Content is immutable and
 * keyed by its own hash, so there is no versioning, no ACL, no multipart, no
 * lifecycle — `has`/`get`/`put`/`delete`/`list` map to HEAD/GET/PUT/DELETE and
 * one ListObjectsV2. Adopting S3's full semantics would mean building a more
 * complex API to do a simpler job.
 */

export interface S3BackendConfig {
  /** Base endpoint, e.g. `https://s3.eu-central-1.amazonaws.com` or `http://minio.lan:9000`. */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket. Trailing slash optional. */
  prefix?: string;
  /**
   * `https://endpoint/bucket/key` (path style, the default) rather than
   * `https://bucket.endpoint/key`. Path style is the default because every
   * self-hosted implementation speaks it and virtual-host style needs DNS the
   * operator may not control.
   */
  forcePathStyle?: boolean;
}

/** Clock and transport, injected so the backend is testable without a bucket. */
export interface S3BackendDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

export class S3Backend implements BlockBackend {
  private readonly prefix: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  /** Cached total; -1 until the first listing (see {@link bytesUsed}). */
  private used = -1;

  constructor(private readonly config: S3BackendConfig, deps: S3BackendDeps = {}) {
    for (const field of ['endpoint', 'bucket', 'region', 'accessKeyId', 'secretAccessKey'] as const) {
      if (!config[field]) throw new Error(`S3Backend: ${field} is required`);
    }
    this.prefix = config.prefix ? config.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.now = deps.now ?? Date.now;
  }

  // ── Key layout ─────────────────────────────────────────────────────────────

  /**
   * `<prefix><first 2 hex>/<cid>` — the same two-character fan-out the
   * filesystem backend uses. Object stores do not need it for performance, but
   * it makes a bucket browsable and, more usefully, makes a bucket produced by
   * one backend readable by the other. An operator moving between local disk and
   * an object store should not have to re-upload.
   */
  private keyFor(cid: Cid): string {
    // CIDs are hex; guard anyway, so a malformed cid can never walk out of the
    // prefix into another tenant's keyspace.
    if (!/^[0-9a-f]{4,}$/i.test(cid)) throw new Error(`invalid cid: ${cid}`);
    return `${this.prefix}${cid.slice(0, 2)}/${cid}`;
  }

  private urlFor(key: string): { url: string; path: string; host: string } {
    const base = new URL(this.config.endpoint);
    const encodedKey = key.split('/').map(s => uriEncode(s)).join('/');
    if (this.config.forcePathStyle === false) {
      const host = `${this.config.bucket}.${base.host}`;
      return { url: `${base.protocol}//${host}/${encodedKey}`, path: `/${encodedKey}`, host };
    }
    const path = `/${uriEncode(this.config.bucket)}/${encodedKey}`;
    return { url: `${base.protocol}//${base.host}${path}`, path, host: base.host };
  }

  // ── Signed request ─────────────────────────────────────────────────────────

  private async send(
    method: string,
    key: string,
    body?: Uint8Array,
    query?: Record<string, string>,
  ): Promise<Response> {
    const { url, path, host } = this.urlFor(key);
    const contentSha256 = await payloadHash(body);
    const headers = await signRequest({
      method,
      path,
      query,
      headers: { host },
      contentSha256,
      amzDate: amzDate(this.now()),
      region: this.config.region,
      service: 's3',
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
    });
    const qs = query && Object.keys(query).length
      ? '?' + Object.keys(query).sort().map(k => `${uriEncode(k)}=${uriEncode(query[k]!)}`).join('&')
      : '';
    return this.fetchFn(url + qs, {
      method,
      headers,
      body: body ? (body.slice().buffer as ArrayBuffer) : undefined,
    });
  }

  // ── BlockBackend ───────────────────────────────────────────────────────────

  async has(cid: Cid): Promise<boolean> {
    const key = this.keyFor(cid);   // outside the try: see get()
    try {
      const res = await this.send('HEAD', key);
      return res.ok;
    } catch {
      // A network failure is NOT "absent". Saying so would let `put` skip its
      // dedup check and re-upload, which is wasteful but harmless — whereas a
      // caller treating it as "we lost the block" would start a repair against a
      // holder that is fine. Callers that need certainty must retry.
      return false;
    }
  }

  async get(cid: Cid): Promise<Uint8Array | undefined> {
    // Resolve the key OUTSIDE the try. A malformed cid is a caller bug that must
    // surface; swallowing it would report an attempted prefix escape as a miss.
    const key = this.keyFor(cid);
    try {
      const res = await this.send('GET', key);
      if (!res.ok) return undefined;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return undefined;
    }
  }

  async put(cid: Cid, bytes: Uint8Array): Promise<number> {
    if (await this.has(cid)) return 0;   // content-addressed dedup
    const res = await this.send('PUT', this.keyFor(cid), bytes);
    if (!res.ok) {
      // Unlike the read paths, a failed write MUST throw. Returning 0 would be
      // indistinguishable from "already held", so the caller would record a
      // replica that does not exist — the exact inflated-redundancy failure the
      // lease model exists to prevent.
      throw new Error(`S3Backend: PUT ${cid.slice(0, 12)}… returned ${res.status}`);
    }
    if (this.used >= 0) this.used += bytes.length;
    return bytes.length;
  }

  async delete(cid: Cid): Promise<number> {
    const key = this.keyFor(cid);
    let size = 0;
    try {
      const head = await this.send('HEAD', key);
      if (!head.ok) return 0;
      size = Number(head.headers.get('content-length') ?? 0);
    } catch {
      return 0;
    }
    const res = await this.send('DELETE', key);
    // S3 DELETE is idempotent and answers 204 whether or not the key existed.
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3Backend: DELETE ${cid.slice(0, 12)}… returned ${res.status}`);
    }
    if (this.used >= 0) this.used -= size;
    return size;
  }

  /** Listed once on first call, then tracked incrementally by put/delete. */
  async bytesUsed(): Promise<number> {
    if (this.used >= 0) return this.used;
    let total = 0;
    for (const { size } of await this.listObjects()) total += size;
    this.used = total;
    return total;
  }

  async list(): Promise<Cid[]> {
    return (await this.listObjects()).map(o => o.cid);
  }

  /**
   * ListObjectsV2, following continuation tokens.
   *
   * Paginated because S3 caps a page at 1000 keys and silently truncates
   * otherwise — a listing that stopped at 1000 would under-report `bytesUsed`,
   * and a provider under-reporting its usage is a provider that over-reports its
   * free space and accepts assignments it cannot hold.
   */
  private async listObjects(): Promise<{ cid: Cid; size: number }[]> {
    const out: { cid: Cid; size: number }[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': '1000' };
      if (this.prefix) query.prefix = this.prefix;
      if (token) query['continuation-token'] = token;
      const res = await this.send('GET', '', undefined, query);
      if (!res.ok) throw new Error(`S3Backend: LIST returned ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]*)<\/Key>/.exec(m[1]!)?.[1];
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0);
        if (!key) continue;
        const cid = key.slice(key.lastIndexOf('/') + 1);
        // Keys the network did not write (an operator sharing a bucket) are not
        // ours to count or to serve.
        if (!/^[0-9a-f]{4,}$/i.test(cid)) continue;
        out.push({ cid, size });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
        ? /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1]
        : undefined;
    } while (token);
    return out;
  }
}

/**
 * Build the backend from operator-supplied environment, or `undefined`.
 *
 * `undefined` is the whole point: the caller must go on working without an
 * object store, so the absence of configuration is an ordinary answer rather
 * than an error. There is no default endpoint, no discovery, and no bucket name
 * anywhere in this repository — an operator who has not deliberately opted in
 * gets local disk, which is the honest bottom layer of the storage tier.
 *
 * Required: `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`.
 * Optional: `S3_REGION` (default `us-east-1`, what self-hosted stores expect),
 * `S3_PREFIX`, `S3_FORCE_PATH_STYLE=0` for virtual-host addressing.
 */
export function s3BackendFromEnv(
  env: Record<string, string | undefined> = process.env,
  deps: S3BackendDeps = {},
): S3Backend | undefined {
  const endpoint = env.S3_ENDPOINT;
  const bucket = env.S3_BUCKET;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  return new S3Backend({
    endpoint, bucket, accessKeyId, secretAccessKey,
    region: env.S3_REGION || 'us-east-1',
    prefix: env.S3_PREFIX,
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== '0',
  }, deps);
}
