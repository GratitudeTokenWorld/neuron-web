import { describe, it, expect, vi } from 'vitest';

// face-store → face-verify pulls in the face-api/tfjs model libs at module load
// (only needed for the camera, not the crypto helpers here). Stub them for Node.
vi.mock('@tensorflow/tfjs', () => ({}));
vi.mock('@vladmandic/face-api', () => ({}));

import type { KeyPair } from '../core/crypto.js';
import { generateAccountKeys } from '../core/account.js';
import {
  createEncryptedKeyBlob,
  recoverKeysWithFace,
  deriveCombinedKey,
  EncryptedKeyBlob,
} from '../core/face-store.js';
import { engineAccountId } from './key-bridge.js';
import { quantizeDescriptor, deriveFaceRawBits } from '../core/face-verify.js';
import { derivePinRawBits, encryptWithPinKey, generatePinSalt } from '../core/pin-crypto.js';

/**
 * Regressions for two fixes:
 *  1. Identity binding — the encrypted key blob (its `pub`, the face-key salt, and
 *     the linkedAnchor) is bound to the engine `accountId`, NOT the JWK `keys.pub`.
 *     A mismatch silently broke recovery ("blob may be tampered" / decryption fail).
 *  2. PIN-rotation round-trip — the manual re-encryption the Change-PIN handler does
 *     stays compatible with recoverKeysWithFace (new PIN recovers, old PIN does not).
 */

// Deterministic, clearly-distinct 128-D "face descriptors": same seed = identical.
function descriptor(seed: number): number[] {
  return Array.from({ length: 128 }, (_, i) => (((i * 13 + seed * 131) % 100) / 100) - 0.5);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

/**
 * Reproduce the Change-PIN handler's combined-key re-encryption (pinVersion=2):
 * re-wrap the keys under XOR(faceBytes(salt=accountId), newPinBytes) and refresh
 * pinSalt / pinVerifier / encryptedCanonical. blob.pub (the salt) is unchanged.
 */
async function rotatePin(
  blob: EncryptedKeyBlob,
  keys: KeyPair,
  faceCanonical: number[],
  accountId: string,
  newPin: string,
): Promise<EncryptedKeyBlob> {
  const quantized = quantizeDescriptor(faceCanonical);
  const newSalt = generatePinSalt();
  const newPinBytes = await derivePinRawBits(newPin, newSalt);
  const newPinKey = await crypto.subtle.importKey(
    'raw', newPinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
  const faceBytes = await deriveFaceRawBits(quantized, accountId);
  const newSharedKey = await deriveCombinedKey(faceBytes, newPinBytes);
  return {
    ...blob,
    pinSalt: b64(newSalt),
    pinVersion: 2,
    encryptedKeys: await encryptWithPinKey(JSON.stringify(keys), newSharedKey),
    pinVerifier: await encryptWithPinKey('PINOK', newPinKey),
    encryptedCanonical: await encryptWithPinKey(JSON.stringify(faceCanonical), newPinKey),
  };
}

describe('recovery identity binding (accountId)', () => {
  it('binds the blob to the engine accountId — not the JWK pub — and round-trips', async () => {
    const keys = await generateAccountKeys();
    const accountId = engineAccountId(keys.priv);
    expect(accountId).not.toBe(keys.pub); // engine compressed-hex vs JWK base64

    const face = descriptor(1);
    const blob = await createEncryptedKeyBlob(keys, 'alice', face, 'fmh', '1234', accountId);
    expect(blob.pub).toBe(accountId);

    const recovered = await recoverKeysWithFace(blob, face, '1234');
    expect(recovered).not.toBeNull();
    expect(recovered!.keys.priv).toBe(keys.priv);
  });

  it('does not recover if blob.pub (the face-key salt) is swapped to the JWK pub', async () => {
    // This is exactly the pre-fix breakage: keys encrypted under the accountId salt
    // but the blob carrying the JWK pub → recoverKeysWithFace derives the wrong salt.
    const keys = await generateAccountKeys();
    const accountId = engineAccountId(keys.priv);
    const face = descriptor(3);
    const blob = await createEncryptedKeyBlob(keys, 'bob', face, 'fmh', '1234', accountId);
    const mismatched: EncryptedKeyBlob = { ...blob, pub: keys.pub };
    expect(await recoverKeysWithFace(mismatched, face, '1234')).toBeNull();
  });

  it('defaults blob.pub to keys.pub when no accountId is given (legacy/test callers)', async () => {
    const keys = await generateAccountKeys();
    const face = descriptor(4);
    const blob = await createEncryptedKeyBlob(keys, 'dave', face, 'fmh', '1234');
    expect(blob.pub).toBe(keys.pub);
    expect((await recoverKeysWithFace(blob, face, '1234'))!.keys.priv).toBe(keys.priv);
  });
});

describe('PIN rotation round-trip', () => {
  it('recovers with the new PIN after a change, and rejects the old PIN', async () => {
    const keys = await generateAccountKeys();
    const accountId = engineAccountId(keys.priv);
    const face = descriptor(5);

    const blob = await createEncryptedKeyBlob(keys, 'carol', face, 'fmh', '1111', accountId);
    const rotated = await rotatePin(blob, keys, face, accountId, '2222');

    const ok = await recoverKeysWithFace(rotated, face, '2222');
    expect(ok).not.toBeNull();
    expect(ok!.keys.priv).toBe(keys.priv);

    expect(await recoverKeysWithFace(rotated, face, '1111')).toBeNull();
  });
});
