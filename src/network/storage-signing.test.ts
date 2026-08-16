import { describe, it, expect } from 'vitest';
import { signStorageMsg, verifyStorageMsg } from './storage-signing';
import { generateKeyPair as appKeyPair } from '../core/crypto';
import { engineAccountId } from '../ledger/key-bridge';
import { generateKeyPair as engineKeyPair } from '../engine/core/keys';

/**
 * The mismatch these functions exist to prevent.
 *
 * Storage messages are signed with the account's ENGINE key and verified against
 * its engine id. When the signer and verifier disagreed about the key FORMAT —
 * app JWK on one side, engine hex on the other — nothing threw: the verifier's
 * key import failed inside a catch and returned "invalid signature". Content
 * distribution, the file index, receipt scoring and content deletion were each
 * silently dead for as long as the mismatch existed, and the same mistake was
 * made three times in one day because signers and verifiers lived apart.
 */
describe('storage message signing', () => {
  it('verifies against the account id the wire actually carries', async () => {
    const keys = await appKeyPair();
    const enginePub = engineAccountId(keys.priv);      // the `026…` id on the wire
    const payload = 'delete:cid1,cid2:owner:12345';
    expect(verifyStorageMsg(signStorageMsg(payload, keys), payload, enginePub)).toBe(true);
  });

  it('is NOT verifiable against the app JWK pub — the mismatch that broke everything', async () => {
    // `keys.pub` is a base64 JWK; the engine id is compressed hex. They are the
    // same key and the signature is fine, but a verifier handed the wrong FORM
    // of it fails — and fails quietly.
    const keys = await appKeyPair();
    const payload = 'cache:cid:owner:1';
    const sig = signStorageMsg(payload, keys);
    expect(keys.pub).not.toBe(engineAccountId(keys.priv));
    expect(verifyStorageMsg(sig, payload, keys.pub)).toBe(false);
  });

  it('rejects a tampered payload', async () => {
    const keys = await appKeyPair();
    const enginePub = engineAccountId(keys.priv);
    const sig = signStorageMsg('delete:cid1:owner:1', keys);
    expect(verifyStorageMsg(sig, 'delete:cid2:owner:1', enginePub)).toBe(false);
  });

  it('rejects another account\'s signature', async () => {
    const alice = await appKeyPair();
    const mallory = await appKeyPair();
    const payload = 'delete:cid1:alice:1';
    expect(verifyStorageMsg(signStorageMsg(payload, mallory), payload, engineAccountId(alice.priv))).toBe(false);
  });

  it('never throws on malformed input — a bad signature is not an exception', async () => {
    const enginePub = engineKeyPair().pub;
    for (const bad of [undefined, null, '', 42, {}, 'not-hex', 'zz'.repeat(32)]) {
      expect(verifyStorageMsg(bad, 'payload', enginePub)).toBe(false);
    }
    expect(verifyStorageMsg('ab'.repeat(32), 'payload', '')).toBe(false);
  });

  it('round-trips every storage payload shape in use', async () => {
    const keys = await appKeyPair();
    const pub = engineAccountId(keys.priv);
    for (const payload of [
      `cache:bafkrei:${pub}:1700000000000`,
      `delete:bafkreiA,bafkreiB:${pub}:1700000000000`,
      `replace:bafkreiOld:bafkreiNew:${pub}:1700000000000`,
      `receipt:bafkrei:${pub}:${pub}:97003:true:1700000000000`,
      `file:bafkrei:106168320:${pub}:1700000000000`,
      `file-remove:bafkrei:${pub}:1700000000000`,
      `stats:${pub}:106168320:1700000000000`,
    ]) {
      expect(verifyStorageMsg(signStorageMsg(payload, keys), payload, pub)).toBe(true);
    }
  });
});
