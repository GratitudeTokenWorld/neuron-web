import { sign as engineSign, verify as engineVerify } from '../engine/core/keys';
import { engineKeysFromAppPrivate } from '../ledger/key-bridge';
import type { KeyPair } from '../core/crypto';

/**
 * One place to sign and verify storage gossip, because the signer and the
 * verifier drifted apart twice in one day.
 *
 * Storage messages — cache requests, delete and replace requests, receipts, file
 * announcements — are signed with the account's ENGINE key and verified against
 * its engine id, the `026…` compressed hex that identifies the account
 * everywhere else in the system.
 *
 * They used to use the app's `signData`/`verifySignature`, whose verifier
 * imports the pub as a base64 JWK. Once accounts moved onto the engine, every
 * pub on the wire became hex, `atob(hex)` cannot yield a JWK, and EVERY signed
 * storage message failed verification — silently, inside a catch. Content
 * distribution, the file index and receipt scoring were all dead and had been
 * since the migration.
 *
 * Fixing that in `storage-manager.ts` missed two call sites in `node.ts`
 * (`deleteContent` still signed the app way, and the file-record fold still
 * verified the app way), so deletes were silently ignored by every provider and
 * client-side file lookups returned nothing. The signature was never wrong in
 * either case — only the key FORMAT handed across the boundary, which is exactly
 * the kind of mismatch that produces no error anywhere.
 *
 * So: these two functions, and nothing in the storage path signs or verifies by
 * hand. A new call site that imports from here cannot pick the wrong scheme.
 */

/** Sign a storage-gossip payload with the engine key derived from an app keypair. */
export function signStorageMsg(payload: string, keys: KeyPair): string {
  return engineSign(payload, engineKeysFromAppPrivate(keys.priv).priv);
}

/**
 * Verify a storage-gossip payload against an account's engine id.
 * Never throws — a malformed signature is simply not a valid one.
 */
export function verifyStorageMsg(signature: unknown, payload: string, enginePub: string): boolean {
  if (typeof signature !== 'string' || !signature || !enginePub) return false;
  try {
    return engineVerify(signature, payload, enginePub);
  } catch {
    return false;
  }
}
