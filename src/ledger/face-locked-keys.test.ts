import { describe, it, expect, vi } from 'vitest';

// face-store → face-verify imports the face-api/tfjs model libs at module load (only
// needed for the camera, not for the crypto helpers we exercise here). Stub them so
// this runs under Node. (Worth splitting the face *crypto* out of the model module.)
vi.mock('@tensorflow/tfjs', () => ({}));
vi.mock('@vladmandic/face-api', () => ({}));

import { generateAccountKeys } from '../core/account.js';
import { createEncryptedKeyBlob, recoverKeysWithFace } from '../core/face-store.js';
import { engineKeysFromAppPrivate, engineAccountId } from './key-bridge.js';
import { EngineLedger } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { verifyBlock } from '../engine/core/block.js';

/**
 * The user's priority: confirm the face+PIN-locked keys actually work with the new
 * engine. This exercises the REAL face-store (createEncryptedKeyBlob /
 * recoverKeysWithFace) end-to-end: lock keys behind face+PIN, recover them, bridge
 * to the engine, and open + sign an account on the engine. No browser needed.
 */

// Deterministic, clearly-distinct 128-D "face descriptors" for the test (different
// seeds are far apart in Euclidean distance, same seed is identical).
function descriptor(seed: number): number[] {
  return Array.from({ length: 128 }, (_, i) => (((i * 13 + seed * 131) % 100) / 100) - 0.5);
}

const attester = generateKeyPair();

describe('face-locked keys ↔ engine', () => {
  it('locks keys behind face+PIN, recovers them, and opens + signs on the engine', async () => {
    const keys = await generateAccountKeys();
    const face = descriptor(1);
    const pin = '1234';

    // Lock the account keys behind face + PIN (the real blob the app stores).
    const blob = await createEncryptedKeyBlob(keys, 'alice', face, 'facemap-hash', pin);

    // Recover with the same face + PIN → exact same keys back.
    const recovered = await recoverKeysWithFace(blob, face, pin);
    expect(recovered).not.toBeNull();
    expect(recovered!.keys.priv).toBe(keys.priv);

    // The engine identity derived from the keys is stable across create/recover.
    expect(engineAccountId(recovered!.keys.priv)).toBe(engineAccountId(keys.priv));

    // The recovered, face-unlocked keys open an account and sign a valid engine block.
    const engineKeys = engineKeysFromAppPrivate(recovered!.keys.priv);
    const ledger = new EngineLedger('testnet');
    const commitment = deriveCommitment('human-alice', engineKeys.pub);
    const open = await ledger.openAccount(engineKeys.pub, engineKeys, {
      nullifier: 'human-alice',
      attestations: [createAttestation('personhood', commitment, attester)],
    });
    expect(verifyBlock(open)).toBe(true);
    expect(open.accountId).toBe(engineKeys.pub);

    // And can authorize a payment with the same recovered keys.
    const bob = engineKeysFromAppPrivate((await generateAccountKeys()).priv);
    ledger.registerAccount({ username: 'bob', pub: bob.pub });
    const send = await ledger.createSend(engineKeys.pub, bob.pub, 1000, engineKeys);
    expect(send.error).toBeUndefined();
  });

  it('does not recover with a wrong PIN', async () => {
    const keys = await generateAccountKeys();
    const face = descriptor(2);
    const blob = await createEncryptedKeyBlob(keys, 'bob', face, 'facemap-hash', '1234');
    expect(await recoverKeysWithFace(blob, face, '9999')).toBeNull();
  });

  it('does not recover with a wrong face', async () => {
    const keys = await generateAccountKeys();
    const face = descriptor(2);
    const blob = await createEncryptedKeyBlob(keys, 'carol', face, 'facemap-hash', '1234');
    const wrongFace = Array.from({ length: 128 }, () => 0.4); // far from `face`
    expect(await recoverKeysWithFace(blob, wrongFace, '1234')).toBeNull();
  });
});
