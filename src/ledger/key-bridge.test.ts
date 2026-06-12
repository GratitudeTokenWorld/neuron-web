import { describe, it, expect } from 'vitest';
import { sign as engineSign, verify as engineVerify } from '../engine/core/keys.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '../engine/core/hash.js';
import { engineKeysFromAppPrivate } from './key-bridge.js';

/** Make an app-style keypair: WebCrypto ECDSA P-256, extractable, priv as base64(JSON(JWK)). */
async function makeAppKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const appPrivB64 = btoa(JSON.stringify(privJwk));
  return { pair, appPrivB64 };
}

describe('key bridge (app WebCrypto ↔ engine @noble)', () => {
  it('derives engine keys whose signatures the engine verifies', async () => {
    const { appPrivB64 } = await makeAppKeys();
    const keys = engineKeysFromAppPrivate(appPrivB64);
    const sig = engineSign('block payload', keys.priv);
    expect(engineVerify(sig, 'block payload', keys.pub)).toBe(true);
    expect(engineVerify(sig, 'tampered', keys.pub)).toBe(false);
  });

  it('produces engine signatures that the original WebCrypto key accepts (engine blocks are standard ECDSA)', async () => {
    const { pair, appPrivB64 } = await makeAppKeys();
    const keys = engineKeysFromAppPrivate(appPrivB64);
    const msg = utf8ToBytes('cross-verify me');
    const sig = hexToBytes(engineSign(msg, keys.priv)); // raw r||s, low-S (noble)
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, sig, msg);
    expect(ok).toBe(true);
  });

  it('the engine verifies WebCrypto-made signatures too (bidirectional interop)', async () => {
    const { pair, appPrivB64 } = await makeAppKeys();
    const keys = engineKeysFromAppPrivate(appPrivB64);
    const msg = utf8ToBytes('signed by webcrypto');
    // WebCrypto may emit high-S signatures (which @noble rejects as non-canonical);
    // the engine signs low-S itself, so over a few attempts a low-S one verifies.
    let verified = false;
    for (let i = 0; i < 8 && !verified; i++) {
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, msg));
      verified = engineVerify(bytesToHex(sig), msg, keys.pub);
    }
    expect(verified).toBe(true);
  });
});
