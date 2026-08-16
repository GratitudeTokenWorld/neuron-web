import { webcrypto } from 'node:crypto';

/**
 * AWS Signature Version 4, in about a hundred lines and with no dependencies.
 *
 * The S3-compatible backend needs request signing and nothing else from an S3
 * SDK: content here is immutable and keyed by its own hash, so there is no
 * versioning, no ACLs, no multipart, no lifecycle — the entire surface is
 * HEAD/GET/PUT/DELETE on one key plus a listing. Pulling in an SDK for that
 * would add megabytes and a vendor to a subsystem whose whole design constraint
 * is that **no node may require an object store to exist** (ARCHITECTURE.md →
 * Subsystem 4). A signer we can read is the proportionate answer.
 *
 * SigV4 is also what the alternatives speak — MinIO, Garage, Ceph RGW,
 * Backblaze B2, Wasabi — so "S3-compatible" here means the protocol, not the
 * company.
 *
 * Pure: no network, no clock (the caller passes the timestamp), no config. That
 * makes it testable against AWS's own published vectors, which is the only way
 * to know a signer is right — a signer tested against itself passes while
 * signing garbage.
 */

const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes as unknown as BufferSource));
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const k = await webcrypto.subtle.importKey(
    'raw', key as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await webcrypto.subtle.sign('HMAC', k, encoder.encode(data)));
}

/** SHA-256 of a payload, hex — what `x-amz-content-sha256` carries. */
export async function payloadHash(body: Uint8Array | undefined): Promise<string> {
  return hex(await sha256(body ?? new Uint8Array(0)));
}

/**
 * RFC 3986 encoding, which is NOT `encodeURIComponent`.
 *
 * `encodeURIComponent` leaves `!'()*` alone; SigV4 requires them percent-encoded,
 * and a signature over a differently-encoded path fails with a message that
 * blames your credentials. Only unreserved characters survive.
 */
export function uriEncode(str: string, encodeSlash = true): string {
  let out = '';
  for (const ch of str) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) out += ch;
    else if (ch === '/') out += encodeSlash ? '%2F' : '/';
    else {
      for (const b of encoder.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

export interface SignRequestArgs {
  method: string;
  /** Already-encoded absolute path, e.g. `/bucket/ab/abcd…`. Must begin with `/`. */
  path: string;
  /** Query parameters, unencoded. Sorted and encoded here. */
  query?: Record<string, string>;
  /**
   * Headers to sign. `host` is required; `x-amz-date` and `x-amz-content-sha256`
   * are added from `amzDate`/`contentSha256` if absent. Names are lower-cased.
   */
  headers: Record<string, string>;
  /** Hex SHA-256 of the body (see `payloadHash`). */
  contentSha256: string;
  /** `YYYYMMDDTHHMMSSZ` — the caller's clock, so this module has none. */
  amzDate: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Sign a request. Returns the complete header set to send, including
 * `Authorization`.
 *
 * The canonical request is assembled exactly as the spec dictates and in the
 * spec's order — every field is load-bearing, and a mismatch anywhere produces
 * one indistinguishable `SignatureDoesNotMatch`, which is why this is separated
 * out and pinned by vectors rather than debugged against a live bucket.
 */
export async function signRequest(args: SignRequestArgs): Promise<Record<string, string>> {
  const { method, path, query = {}, contentSha256, amzDate, region,
    service = 's3', accessKeyId, secretAccessKey } = args;

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.headers)) headers[k.toLowerCase()] = v.trim();
  headers['x-amz-date'] ??= amzDate;
  if (service === 's3') headers['x-amz-content-sha256'] ??= contentSha256;
  if (!headers['host']) throw new Error('signRequest: host header is required');

  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k]!)}`)
    .join('&');

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(n => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    contentSha256,
  ].join('\n');

  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join('\n');

  let key = encoder.encode(`AWS4${secretAccessKey}`);
  for (const part of [date, region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** `YYYYMMDDTHHMMSSZ` from a millisecond timestamp. */
export function amzDate(now: number): string {
  return new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
