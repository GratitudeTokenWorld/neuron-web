import { bytesToHex } from '../engine/core/hash.js';
import { publicKeyFromPrivate } from '../engine/core/keys.js';
import type { SignerKeys } from './engine-ledger.js';

/**
 * Key bridge: app (WebCrypto ECDSA P-256, JWK) → engine (@noble P-256, hex).
 *
 * The app's account keys are exportable JWK and both sides are P-256 ECDSA over
 * SHA-256, so we don't need to make the engine async. We extract the private
 * scalar `d` from the JWK and derive the compressed public key; the engine then
 * signs/verifies with @noble using these. Signatures are interoperable in BOTH
 * directions (a WebCrypto-made signature verifies under @noble and vice versa) —
 * see key-bridge.test.ts. This preserves the app's face+PIN recovery (which
 * encrypts the JWK) untouched while letting blocks run on the engine.
 *
 * The engine `accountId` becomes the compressed-hex pubkey derived here; the app
 * keeps the JWK for recovery and maps to this id for on-chain identity.
 */

function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The app's private JWK is base64(JSON(jwk)); pull out `d` and derive the engine keypair. */
export function engineKeysFromAppPrivate(appPrivB64: string): SignerKeys {
  const jwk = JSON.parse(atob(appPrivB64)) as { d?: string };
  if (!jwk.d) throw new Error('private JWK missing scalar `d` (key not exportable)');
  const priv = bytesToHex(base64UrlToBytes(jwk.d));
  return { pub: publicKeyFromPrivate(priv), priv };
}

/** Derive just the engine pubkey (compressed hex) from a private JWK — the on-chain accountId. */
export function engineAccountId(appPrivB64: string): string {
  return engineKeysFromAppPrivate(appPrivB64).pub;
}
