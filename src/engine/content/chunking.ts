import { hashJson, type Hex } from '../core/hash.js';
import { cidOf, verifyCid, type Cid } from './cid.js';

/**
 * Content chunking + manifest.
 *
 * Large media is split into fixed-size, independently content-addressed chunks
 * described by a small manifest. This is what makes big files safe to store and
 * stream: no single stored blob ever exceeds the chunk size (the root cause of
 * the old "100 MB video crashes the tab" bug was writing a monolithic blob over
 * the storage quota), and each chunk is integrity-checkable on its own.
 */

/** 8 MiB — matches the original smoke-store chunking. */
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

export interface ChunkRef {
  cid: Cid;
  size: number;
}

export interface Manifest {
  /** CID of the manifest itself (addresses the whole file). */
  cid: Cid;
  /** Total byte length of the reassembled content. */
  size: number;
  chunkSize: number;
  chunks: ChunkRef[];
}

export interface ChunkedContent {
  manifest: Manifest;
  /** The chunk payloads (views into the source buffer — copy before retaining). */
  chunks: { cid: Cid; bytes: Uint8Array }[];
}

export function chunkContent(bytes: Uint8Array, chunkSize: number = DEFAULT_CHUNK_SIZE): ChunkedContent {
  if (chunkSize <= 0) throw new RangeError('chunkSize must be positive');
  const chunks: { cid: Cid; bytes: Uint8Array }[] = [];
  const refs: ChunkRef[] = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    const part = bytes.subarray(off, Math.min(off + chunkSize, bytes.length));
    const cid = cidOf(part);
    chunks.push({ cid, bytes: part });
    refs.push({ cid, size: part.length });
  }
  const cid = hashJson({ size: bytes.length, chunkSize, chunks: refs });
  return { manifest: { cid, size: bytes.length, chunkSize, chunks: refs }, chunks };
}

/**
 * Reassemble content from a manifest, fetching each chunk via `getChunk`. Verifies
 * every chunk's CID and the total size; returns null on any missing/corrupt chunk.
 */
export function reassemble(manifest: Manifest, getChunk: (cid: Cid) => Uint8Array | undefined): Uint8Array | null {
  const out = new Uint8Array(manifest.size);
  let off = 0;
  for (const ref of manifest.chunks) {
    const part = getChunk(ref.cid);
    if (!part || part.length !== ref.size || !verifyCid(ref.cid, part)) return null;
    if (off + part.length > manifest.size) return null;
    out.set(part, off);
    off += part.length;
  }
  return off === manifest.size ? out : null;
}

/** Recompute a manifest's CID to confirm it describes exactly these chunks. */
export function verifyManifest(manifest: Manifest): boolean {
  const expected = hashJson({ size: manifest.size, chunkSize: manifest.chunkSize, chunks: manifest.chunks });
  if (expected !== manifest.cid) return false;
  const total = manifest.chunks.reduce((s, c) => s + c.size, 0);
  return total === manifest.size;
}

export type { Cid, Hex };

// ── Compact wire encoding ────────────────────────────────────────────────────

/**
 * A manifest on the wire: raw 32-byte digests instead of 64-char hex, and no
 * per-chunk `size` at all.
 *
 * Measured in `sim/manifest-encoding.ts` (2026-09-22): 16,400 bytes against
 * 46,130 as hex-JSON for a 4 GB file — 2.8x — and 2,495 bytes SMALLER than
 * gzipping that JSON while costing nothing to decompress. Compression was the
 * idea screened; this is what the measurement recommended instead, because a
 * SHA-256 is incompressible by construction and everything gzip recovered was
 * the hex expansion and the JSON scaffolding.
 *
 * **The CID is NOT computed over these bytes.** It stays `hashJson` over the
 * logical fields, so the address of a file never depends on how it was
 * serialised. Hashing an encoding is how the same file ends up with different
 * CIDs on different clients — the failure that made compression unacceptable in
 * the first place, and it would apply just as much to this format.
 *
 * Layout, little-endian:
 *   0  u8    version (1)
 *   1  u8    reserved (0)
 *   2  u16   reserved (0)
 *   4  u64   size
 *   12 u64   chunkSize
 *   20 …     32-byte digests, in order
 *
 * Every chunk's size is DERIVED: `chunkSize` for all but the last, and the
 * remainder for the last. Carrying it was pure redundancy.
 */
export const MANIFEST_WIRE_VERSION = 1;
const WIRE_HEADER_BYTES = 20;

export function encodeManifest(manifest: Manifest): Uint8Array {
  const n = manifest.chunks.length;
  const out = new Uint8Array(WIRE_HEADER_BYTES + n * 32);
  const view = new DataView(out.buffer);
  out[0] = MANIFEST_WIRE_VERSION;
  view.setBigUint64(4, BigInt(manifest.size), true);
  view.setBigUint64(12, BigInt(manifest.chunkSize), true);
  for (let i = 0; i < n; i++) {
    const hex = manifest.chunks[i]!.cid;
    for (let b = 0; b < 32; b++) {
      out[WIRE_HEADER_BYTES + i * 32 + b] = parseInt(hex.slice(b * 2, b * 2 + 2), 16);
    }
  }
  return out;
}

/**
 * Decode a wire manifest, or `null` if it is malformed.
 *
 * Returns null rather than throwing, and checks the declared sizes against the
 * actual byte length BEFORE trusting either: this parses untrusted input, so a
 * header claiming a billion chunks must cost nothing to reject.
 */
export function decodeManifest(bytes: Uint8Array): Manifest | null {
  if (bytes.length < WIRE_HEADER_BYTES) return null;
  if (bytes[0] !== MANIFEST_WIRE_VERSION) return null;
  const body = bytes.length - WIRE_HEADER_BYTES;
  if (body % 32 !== 0) return null;
  const n = body / 32;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = Number(view.getBigUint64(4, true));
  const chunkSize = Number(view.getBigUint64(12, true));
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(chunkSize)) return null;
  if (size < 0 || chunkSize <= 0) return null;
  // The chunk count is implied by size and chunkSize; a mismatch means the
  // header and the body disagree, so neither can be trusted.
  if (n !== Math.ceil(size / chunkSize) && !(size === 0 && n === 0)) return null;

  const hex = '0123456789abcdef';
  const chunks: ChunkRef[] = [];
  for (let i = 0; i < n; i++) {
    let cid = '';
    for (let b = 0; b < 32; b++) {
      const v = bytes[WIRE_HEADER_BYTES + i * 32 + b]!;
      cid += hex[v >> 4]! + hex[v & 15]!;
    }
    // Derived, not transmitted.
    const isLast = i === n - 1;
    chunks.push({ cid, size: isLast ? size - chunkSize * (n - 1) : chunkSize });
  }
  const cid = hashJson({ size, chunkSize, chunks });
  return { cid, size, chunkSize, chunks };
}
