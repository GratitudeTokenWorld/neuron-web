import { chunkContent, reassemble, DEFAULT_CHUNK_SIZE, type Manifest } from './chunking.js';
import { type Cid } from './cid.js';

/**
 * Quota-aware content store (models a node's OPFS/IndexedDB backing).
 *
 * Two guarantees that together fix the old "100 MB file crashes the tab":
 *   1. No single stored blob ever exceeds the chunk size — large content is
 *      chunked first, so we never attempt a monolithic over-quota write.
 *   2. Every write is quota-checked up front (dedup-aware), so the store fails
 *      cleanly with a reason instead of throwing/crashing when space runs out.
 *
 * Chunks are content-addressed, so identical chunks across files are stored once.
 */

export interface StoreResult {
  ok: boolean;
  manifest?: Manifest;
  reason?: string;
}

export class ContentStore {
  private readonly blocks = new Map<Cid, Uint8Array>();
  private bytesUsed = 0;

  constructor(
    private readonly quotaBytes: number,
    private readonly chunkSize: number = DEFAULT_CHUNK_SIZE,
  ) {}

  used(): number {
    return this.bytesUsed;
  }

  available(): number {
    return this.quotaBytes - this.bytesUsed;
  }

  has(cid: Cid): boolean {
    return this.blocks.has(cid);
  }

  getBlock(cid: Cid): Uint8Array | undefined {
    return this.blocks.get(cid);
  }

  /** Store a single chunk, guarding both the per-blob size cap and total quota. */
  putBlock(cid: Cid, bytes: Uint8Array): StoreResult {
    if (bytes.length > this.chunkSize) {
      return { ok: false, reason: `blob ${bytes.length}B exceeds chunk size ${this.chunkSize}B — must be chunked` };
    }
    if (this.blocks.has(cid)) return { ok: true }; // content-addressed dedup, no new space
    if (this.bytesUsed + bytes.length > this.quotaBytes) {
      return { ok: false, reason: `quota exceeded (need ${bytes.length}B, ${this.available()}B free)` };
    }
    this.blocks.set(cid, bytes.slice()); // own copy so the source buffer can be released
    this.bytesUsed += bytes.length;
    return { ok: true };
  }

  /**
   * Store arbitrary content: chunk it, pre-check quota for the *new* chunks, then
   * write. Returns the manifest. Never writes a blob larger than the chunk size.
   */
  storeContent(bytes: Uint8Array): StoreResult {
    const { manifest, chunks } = chunkContent(bytes, this.chunkSize);
    let need = 0;
    for (const c of chunks) if (!this.blocks.has(c.cid)) need += c.bytes.length;
    if (this.bytesUsed + need > this.quotaBytes) {
      return { ok: false, reason: `quota: content needs ${need}B but only ${this.available()}B free` };
    }
    for (const c of chunks) {
      const r = this.putBlock(c.cid, c.bytes);
      if (!r.ok) return r;
    }
    return { ok: true, manifest };
  }

  /** Reassemble content from a manifest using locally-held chunks. */
  getContent(manifest: Manifest): Uint8Array | null {
    return reassemble(manifest, (cid) => this.blocks.get(cid));
  }
}
