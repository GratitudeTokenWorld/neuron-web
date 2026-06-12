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
