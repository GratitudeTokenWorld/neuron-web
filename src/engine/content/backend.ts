import { type Cid } from './cid.js';

/**
 * Where a storage node's blocks physically live.
 *
 * Deliberately tiny and CID-native: content is IMMUTABLE and keyed by its own
 * hash, so a backend needs no mutable-key semantics, no versioning, no ACLs and
 * no multipart — the things that make an object-store API large. Adopting one
 * would mean building a more complex interface to do a simpler job
 * (ARCHITECTURE.md → Subsystem 4 → *Storage backends are pluggable*).
 *
 * Async by definition: every real backing store is (OPFS, IndexedDB, a
 * filesystem, an object store). The in-memory implementation below is the only
 * synchronous one, and it still presents the async surface so callers never
 * branch on which backend they were handed.
 *
 * Adapters live where their dependencies belong — this file stays pure and
 * browser/worker-portable (the engine is DOM- and Node-free by design), so the
 * filesystem and S3 adapters live outside `src/engine`. Per the project
 * constraint, any object-store adapter is **operator-configured, never a
 * default**: the protocol must run with every node on plain local disk.
 */
export interface BlockBackend {
  /** True if this backend holds the block. */
  has(cid: Cid): Promise<boolean>;
  /** The block's bytes, or undefined when not held. */
  get(cid: Cid): Promise<Uint8Array | undefined>;
  /**
   * Store one block. Content-addressed, so writing a cid that is already held
   * MUST be a no-op rather than a rewrite (callers rely on this for dedup).
   * Returns the bytes actually added — 0 when the block was already present.
   */
  put(cid: Cid, bytes: Uint8Array): Promise<number>;
  /** Remove a block. Returns the bytes freed — 0 when it was not held. */
  delete(cid: Cid): Promise<number>;
  /** Total bytes currently held. */
  bytesUsed(): Promise<number>;
  /** Every cid held, for GC/repair sweeps and possession proofs. */
  list(): Promise<Cid[]>;
}

/**
 * In-memory backend: the default, and what tests and browser caches use.
 * Holds its own copy of every block so the caller's buffer can be released.
 */
export class MemoryBackend implements BlockBackend {
  private readonly blocks = new Map<Cid, Uint8Array>();
  private used = 0;

  async has(cid: Cid): Promise<boolean> {
    return this.blocks.has(cid);
  }

  async get(cid: Cid): Promise<Uint8Array | undefined> {
    return this.blocks.get(cid);
  }

  async put(cid: Cid, bytes: Uint8Array): Promise<number> {
    if (this.blocks.has(cid)) return 0; // content-addressed dedup
    this.blocks.set(cid, bytes.slice());
    this.used += bytes.length;
    return bytes.length;
  }

  async delete(cid: Cid): Promise<number> {
    const held = this.blocks.get(cid);
    if (!held) return 0;
    this.blocks.delete(cid);
    this.used -= held.length;
    return held.length;
  }

  async bytesUsed(): Promise<number> {
    return this.used;
  }

  async list(): Promise<Cid[]> {
    return [...this.blocks.keys()];
  }
}
