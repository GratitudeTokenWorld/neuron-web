import { describe, it, expect } from 'vitest';
import { signRequest, uriEncode, payloadHash, amzDate } from './sigv4.js';

/**
 * AWS's own published SigV4 test suite credentials. Testing a signer against
 * itself proves only that it is deterministic — these vectors are the only thing
 * that says it is CORRECT, and a wrong signer fails in production with a single
 * opaque `SignatureDoesNotMatch` that blames the credentials.
 */
const VECTOR = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 'service',
  amzDate: '20150830T123600Z',
  host: 'example.amazonaws.com',
};

describe('SigV4 — AWS published vectors', () => {
  it('get-vanilla', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/',
      headers: { host: VECTOR.host },
      contentSha256: await payloadHash(undefined),
      ...VECTOR,
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('get-vanilla-query-order-key-case', async () => {
    const headers = await signRequest({
      method: 'GET',
      path: '/',
      query: { Param1: 'value1', Param2: 'value2' },
      headers: { host: VECTOR.host },
      contentSha256: await payloadHash(undefined),
      ...VECTOR,
    });
    expect(headers.authorization).toContain(
      'Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500',
    );
  });

  it('post-vanilla', async () => {
    const headers = await signRequest({
      method: 'POST',
      path: '/',
      headers: { host: VECTOR.host },
      contentSha256: await payloadHash(undefined),
      ...VECTOR,
    });
    expect(headers.authorization).toContain(
      'Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b',
    );
  });
});

describe('SigV4 mechanics', () => {
  it('signs the s3 service with x-amz-content-sha256 included', async () => {
    const headers = await signRequest({
      method: 'PUT',
      path: '/bucket/abcd',
      headers: { host: 'minio.local' },
      contentSha256: await payloadHash(new Uint8Array([1, 2, 3])),
      amzDate: '20150830T123600Z',
      region: 'us-east-1',
      accessKeyId: 'k', secretAccessKey: 's',
    });
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    expect(headers['x-amz-content-sha256']).toBe(await payloadHash(new Uint8Array([1, 2, 3])));
  });

  it('a different body produces a different signature', async () => {
    const sign = async (body: Uint8Array) => (await signRequest({
      method: 'PUT', path: '/b/k', headers: { host: 'h' },
      contentSha256: await payloadHash(body),
      amzDate: '20150830T123600Z', region: 'r', accessKeyId: 'k', secretAccessKey: 's',
    })).authorization;
    expect(await sign(new Uint8Array([1]))).not.toBe(await sign(new Uint8Array([2])));
  });

  it('refuses to sign without a host header — the signature would be meaningless', async () => {
    await expect(signRequest({
      method: 'GET', path: '/', headers: {},
      contentSha256: await payloadHash(undefined),
      amzDate: '20150830T123600Z', region: 'r', accessKeyId: 'k', secretAccessKey: 's',
    })).rejects.toThrow(/host/);
  });

  it('lower-cases and trims header names/values before signing', async () => {
    const a = await signRequest({
      method: 'GET', path: '/', headers: { Host: '  h  ' },
      contentSha256: await payloadHash(undefined),
      amzDate: '20150830T123600Z', region: 'r', accessKeyId: 'k', secretAccessKey: 's',
    });
    const b = await signRequest({
      method: 'GET', path: '/', headers: { host: 'h' },
      contentSha256: await payloadHash(undefined),
      amzDate: '20150830T123600Z', region: 'r', accessKeyId: 'k', secretAccessKey: 's',
    });
    expect(a.authorization).toBe(b.authorization);
  });
});

describe('uriEncode', () => {
  it('encodes what encodeURIComponent leaves alone', () => {
    // The exact reason this function exists: these five characters are legal to
    // encodeURIComponent and mandatory to encode for SigV4.
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(encodeURIComponent("!'()*")).toBe("!'()*");
  });

  it('keeps unreserved characters', () => {
    expect(uriEncode('aZ0-._~')).toBe('aZ0-._~');
  });

  it('encodes slashes for query values but can keep them for paths', () => {
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', false)).toBe('a/b');
  });

  it('encodes non-ASCII as UTF-8 bytes', () => {
    expect(uriEncode('é')).toBe('%C3%A9');
  });
});

describe('amzDate', () => {
  it('formats as YYYYMMDDTHHMMSSZ with no punctuation or millis', () => {
    expect(amzDate(Date.UTC(2015, 7, 30, 12, 36, 0))).toBe('20150830T123600Z');
  });
});

describe('payloadHash', () => {
  it('hashes an empty body to the well-known empty-string digest', async () => {
    expect(await payloadHash(undefined))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
