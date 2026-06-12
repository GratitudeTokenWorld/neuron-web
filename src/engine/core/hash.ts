import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

/**
 * Hashing primitives shared by every other module.
 *
 * Everything is content-addressed with SHA-256. We expose both byte- and
 * hex-oriented helpers because the wire/storage format is hex strings while the
 * Merkle/crypto math wants raw bytes.
 */

export type Hex = string;

export function hash(...parts: Uint8Array[]): Uint8Array {
  return sha256(parts.length === 1 ? parts[0]! : concatBytes(...parts));
}

export function hashHex(...parts: Uint8Array[]): Hex {
  return bytesToHex(hash(...parts));
}

/** Hash an arbitrary JSON-serialisable value via its canonical encoding. */
export function hashJson(value: unknown): Hex {
  return hashHex(utf8ToBytes(canonicalJson(value)));
}

/**
 * Deterministic JSON: object keys sorted recursively so the same logical value
 * always produces the same bytes (and therefore the same hash) on every node.
 * `bigint` is encoded as a decimal string so 256-bit balances are exact.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes };
