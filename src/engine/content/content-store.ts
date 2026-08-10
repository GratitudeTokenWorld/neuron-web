import { chunkContent, reassemble, DEFAULT_CHUNK_SIZE, type Manifest } from './chunking.js';
import { type Cid } from './cid.js';
import { MemoryBackend, type BlockBackend } from './backend.js';

/**
 * Quota-aware content store (a storage node's declared capacity).
 *
 * Two guarantees that together fix the old "100 MB file crashes the tab":
 *   1. No single stored blob ever exceeds the chunk size — large content is
 *      chunked first, so we never attempt a monolithic over-quota write.
 *   2. Every write is quota-checked up front (dedup-aware), so the store fails
 *      cleanly with a reason instead of throwing/crashing when space runs out.
 *
 * Chunks are content-addressed, so identical chunks across files are stored once.
 *
 * WHERE the blocks live is a {@link BlockBackend} — memory by default, and
 * (outside the engine, where their dependencies belong) a filesystem or an
 * operator-configured object store. This class owns the policy that must hold
 * for every backend — the chunk-size cap, the quota accounting, the
 * dedup-aware pre-check — so a new backend cannot accidentally opt out of it.
 *
 * `quotaBytes` is the node's DECLARED CAPACITY in the storage model: what it
 * advertises it will hold for the network, and the ceiling it refills to after
 * a lease expiry (ARCHITECTURE.md → Subsystem 4).
 */

export interface StoreResult {
  ok: boolean;
  manifest?: Manifest;
  reason?: string;
}

export class ContentStore {
  private bytesUsed = 0;

  constructor(
    private readonly quotaBytes: number,
    private readonly chunkSize: number = DEFAULT_CHUNK_SIZE,
    private readonly backend: BlockBackend = new MemoryBackend(),
  ) {}

  /** Adopt a backend's existing contents (a node restarting on the same disk). */
  async open(): Promise<void> {
    this.bytesUsed = await this.backend.bytesUsed();
  }

  used(): number {
    return this.bytesUsed;
  }

  available(): number {
    return this.quotaBytes - this.bytesUsed;
  }

  has(cid: Cid): Promise<boolean> {
    return this.backend.has(cid);
  }

  getBlock(cid: Cid): Promise<Uint8Array | undefined> {
    return this.backend.get(cid);
  }

  /** Store a single chunk, guarding both the per-blob size cap and total quota. */
  async putBlock(cid: Cid, bytes: Uint8Array): Promise<StoreResult> {
    if (bytes.length > this.chunkSize) {
      return { ok: false, reason: `blob ${bytes.length}B exceeds chunk size ${this.chunkSize}B — must be chunked` };
    }
    if (await this.backend.has(cid)) return { ok: true }; // content-addressed dedup, no new space
    if (this.bytesUsed + bytes.length > this.quotaBytes) {
      return { ok: false, reason: `quota exceeded (need ${bytes.length}B, ${this.available()}B free)` };
    }
    this.bytesUsed += await this.backend.put(cid, bytes);
    return { ok: true };
  }

  /**
   * Store arbitrary content: chunk it, pre-check quota for the *new* chunks, then
   * write. Returns the manifest. Never writes a blob larger than the chunk size.
   */
  async storeContent(bytes: Uint8Array): Promise<StoreResult> {
    const { manifest, chunks } = chunkContent(bytes, this.chunkSize);
    let need = 0;
    for (const c of chunks) if (!(await this.backend.has(c.cid))) need += c.bytes.length;
    if (this.bytesUsed + need > this.quotaBytes) {
      return { ok: false, reason: `quota: content needs ${need}B but only ${this.available()}B free` };
    }
    for (const c of chunks) {
      const r = await this.putBlock(c.cid, c.bytes);
      if (!r.ok) return r;
    }
    return { ok: true, manifest };
  }

  /** Reassemble content from a manifest using locally-held chunks. */
  async getContent(manifest: Manifest): Promise<Uint8Array | null> {
    // Fetch every chunk first: `reassemble` is synchronous, and a partially
    // available file must read as a miss rather than a truncated buffer.
    const held = new Map<Cid, Uint8Array>();
    for (const ref of manifest.chunks) {
      const bytes = await this.backend.get(ref.cid);
      if (!bytes) return null;
      held.set(ref.cid, bytes);
    }
    return reassemble(manifest, (cid) => held.get(cid));
  }

  /**
   * Drop blocks this node no longer holds on the network's behalf. Returns the
   * bytes freed. This is the mechanism behind lease expiry and rejoin cleanup:
   * a node past `MAX_OFFLINE` discards what was re-homed while it was away and
   * refills to its declared capacity (ARCHITECTURE.md → Subsystem 4).
   */
  async release(cids: Iterable<Cid>): Promise<number> {
    let freed = 0;
    for (const cid of cids) freed += await this.backend.delete(cid);
    this.bytesUsed -= freed;
    return freed;
  }

  /** Every block held — for GC/repair sweeps and possession proofs. */
  heldCids(): Promise<Cid[]> {
    return this.backend.list();
  }
}
