import { describe, it, expect } from 'vitest';
import { generateKeyPair, sign } from '../engine/core/keys';
import {
  accountRecordPayload,
  verifyAccountRecordSig,
  relayHttpBase,
  looksLikeAccountPub,
  resolveAccountFromRelays,
  fetchPendingSends,
  type AccountRecord,
  type PendingSendHint,
} from './account-resolver';

/** A well-formed, engine-signed account record for tests. */
function signedRecord(overrides: Partial<AccountRecord> = {}): AccountRecord {
  const keys = generateKeyPair();
  const rec: AccountRecord = {
    pub: keys.pub,
    username: 'alice',
    createdAt: 1_754_700_000_000,
    faceMapHash: 'f'.repeat(64),
    _version: 3,
    ...overrides,
  };
  rec._sig = sign(accountRecordPayload(rec), keys.priv);
  return rec;
}

/** fetch stub: base URL prefix → handler. Unlisted bases reject (unreachable). */
function fakeFetch(routes: Record<string, () => { status: number; body: unknown }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(`${prefix}/resolve?`) || url.startsWith(`${prefix}/pending-sends?`)) {
        const { status, body } = handler();
        return new Response(JSON.stringify(body), { status });
      }
    }
    throw new Error(`unreachable: ${url}`);
  }) as typeof fetch;
}

describe('G1 — on-demand account resolution', () => {
  it('accepts only records whose self-signature verifies', () => {
    const rec = signedRecord();
    expect(verifyAccountRecordSig(rec)).toBe(true);
    // Any signed-field tamper breaks it: the served username is bound to the pub.
    expect(verifyAccountRecordSig({ ...rec, username: 'mallory' })).toBe(false);
    expect(verifyAccountRecordSig({ ...rec, faceMapHash: '0'.repeat(64) })).toBe(false);
    expect(verifyAccountRecordSig({ ...rec, _sig: undefined })).toBe(false);
  });

  it('derives relay HTTP bases from multiaddrs (dns → https, bare ip → PORT+2)', () => {
    expect(relayHttpBase('/dns4/neuronweb.org/tcp/443/wss/http-path/relay-ws/p2p/12D3KooW'))
      .toBe('https://neuronweb.org');
    expect(relayHttpBase('/ip4/80.97.27.224/tcp/9090/ws/p2p/12D3KooW'))
      .toBe('http://80.97.27.224:9092');
    expect(relayHttpBase(undefined)).toBe('');
    expect(relayHttpBase('/ip4/10.0.0.1/tcp/9091/p2p/12D3KooW')).toBe(''); // tcp, not ws
  });

  it('tells engine account pubs (compressed P-256 hex) from usernames', () => {
    expect(looksLikeAccountPub('02' + 'a'.repeat(64))).toBe(true);
    expect(looksLikeAccountPub('03' + '1'.repeat(64))).toBe(true);
    expect(looksLikeAccountPub('alice')).toBe(false);
    expect(looksLikeAccountPub('04' + 'a'.repeat(64))).toBe(false); // uncompressed prefix
  });

  it('resolves from any healthy relay; 404s and dead relays are skipped', async () => {
    const rec = signedRecord();
    const fetchFn = fakeFetch({
      'http://relay1:9092': () => ({ status: 404, body: { error: 'not found' } }),
      'http://relay2:9092': () => ({ status: 200, body: rec }),
      // relay3 intentionally absent → fetch throws (unreachable)
    });
    const got = await resolveAccountFromRelays(
      ['http://relay1:9092', 'http://relay2:9092', 'http://relay3:9092'],
      { username: 'alice' },
      'testnet',
      fetchFn,
    );
    expect(got?.pub).toBe(rec.pub);
  });

  it('rejects forged and mismatched records — a relay cannot answer with a lie', async () => {
    const real = signedRecord();
    // Forged: valid-shaped record whose signature does not verify.
    const forged = { ...signedRecord({ username: 'alice' }), _sig: 'ab'.repeat(32) };
    // Mismatched: validly signed record for a DIFFERENT username than asked.
    const wrongName = signedRecord({ username: 'mallory' });

    expect(
      await resolveAccountFromRelays(['http://bad:9092'], { username: 'alice' }, 'testnet',
        fakeFetch({ 'http://bad:9092': () => ({ status: 200, body: forged }) })),
    ).toBeNull();
    expect(
      await resolveAccountFromRelays(['http://bad:9092'], { username: 'alice' }, 'testnet',
        fakeFetch({ 'http://bad:9092': () => ({ status: 200, body: wrongName }) })),
    ).toBeNull();
    // And a pub query must return exactly that pub.
    expect(
      await resolveAccountFromRelays(['http://bad:9092'], { pub: real.pub }, 'testnet',
        fakeFetch({ 'http://bad:9092': () => ({ status: 200, body: signedRecord() }) })),
    ).toBeNull();
  });

  it('pending-send discovery: unions relays, dedups by hash, survives dead relays', async () => {
    const hintA: PendingSendHint = { sender: '02' + 'a'.repeat(64), blockHash: 'h1', shard: 7, type: 'send' };
    const hintB: PendingSendHint = { sender: '02' + 'b'.repeat(64), blockHash: 'h2', shard: 9, type: 'nft-send' };
    const hints = await fetchPendingSends(
      ['http://r1:9092', 'http://r2:9092', 'http://dead:9092'],
      '02' + 'c'.repeat(64),
      'testnet',
      fakeFetch({
        'http://r1:9092': () => ({ status: 200, body: [hintA, hintB] }),
        'http://r2:9092': () => ({ status: 200, body: [hintA, { garbage: true }] }), // overlap + junk row
        // http://dead:9092 unreachable
      }),
    );
    expect(hints.map((h) => h.blockHash).sort()).toEqual(['h1', 'h2']);

    // All relays down / empty ⇒ empty list, never a throw.
    expect(await fetchPendingSends(['http://dead:9092'], 'x', 'testnet', fakeFetch({}))).toEqual([]);
    expect(
      await fetchPendingSends(['http://r1:9092'], 'x', 'testnet',
        fakeFetch({ 'http://r1:9092': () => ({ status: 200, body: [] }) })),
    ).toEqual([]);
  });

  it('prefers the freshest record when relays disagree (owner _version wins)', async () => {
    const keys = generateKeyPair();
    const make = (version: number, faceMapHash: string): AccountRecord => {
      const rec: AccountRecord = {
        pub: keys.pub, username: 'alice', createdAt: 1, faceMapHash, _version: version,
      };
      rec._sig = sign(accountRecordPayload(rec), keys.priv);
      return rec;
    };
    const stale = make(2, 'a'.repeat(64));
    const fresh = make(7, 'b'.repeat(64));
    const got = await resolveAccountFromRelays(
      ['http://r1:9092', 'http://r2:9092'],
      { username: 'alice' },
      'testnet',
      fakeFetch({
        'http://r1:9092': () => ({ status: 200, body: stale }),
        'http://r2:9092': () => ({ status: 200, body: fresh }),
      }),
    );
    expect(got?._version).toBe(7);
    expect(got?.faceMapHash).toBe('b'.repeat(64));
  });
});
