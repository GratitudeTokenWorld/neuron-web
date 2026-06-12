import { hashHex, type Hex } from '../core/hash.js';

/**
 * Content addressing. A CID is the SHA-256 of the bytes — immutable, globally
 * dedup-able, and self-verifying (anyone can recompute it to check integrity).
 */
export type Cid = Hex;

export function cidOf(bytes: Uint8Array): Cid {
  return hashHex(bytes);
}

/** Verify that `bytes` actually hash to `cid` (integrity check on retrieval). */
export function verifyCid(cid: Cid, bytes: Uint8Array): boolean {
  return cidOf(bytes) === cid;
}
