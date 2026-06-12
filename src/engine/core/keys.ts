import { p256 } from '@noble/curves/p256';
import { hash, bytesToHex, hexToBytes, utf8ToBytes, type Hex } from './hash.js';

/**
 * Account identity keys (ECDSA P-256).
 *
 * An account's public key IS its identity (`accountId`). Signing always happens
 * over the SHA-256 of the message, so signatures commit to a fixed-length digest
 * regardless of payload size.
 *
 * NOTE (roadmap): the production system additionally carries post-quantum
 * (ML-DSA) keys for forward security. Those are deliberately out of scope for
 * Phase 0 — this module establishes the classical signing layer the rest of the
 * foundation builds on; PQ keys slot in alongside without changing these APIs.
 */

export interface KeyPair {
  /** Compressed P-256 public key, hex (33 bytes). Doubles as the accountId. */
  pub: Hex;
  /** Private scalar, hex (32 bytes). */
  priv: Hex;
}

export function generateKeyPair(): KeyPair {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, true);
  return { pub: bytesToHex(pub), priv: bytesToHex(priv) };
}

export function publicKeyFromPrivate(priv: Hex): Hex {
  return bytesToHex(p256.getPublicKey(hexToBytes(priv), true));
}

/** Sign a message (raw bytes or utf8 string). Returns a 64-byte compact sig as hex. */
export function sign(message: Uint8Array | string, priv: Hex): Hex {
  const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
  const sig = p256.sign(hash(msg), hexToBytes(priv));
  return bytesToHex(sig.toCompactRawBytes());
}

/** Verify a signature produced by {@link sign}. Never throws — returns false on malformed input. */
export function verify(sig: Hex, message: Uint8Array | string, pub: Hex): boolean {
  try {
    const msg = typeof message === 'string' ? utf8ToBytes(message) : message;
    return p256.verify(hexToBytes(sig), hash(msg), hexToBytes(pub));
  } catch {
    return false;
  }
}
