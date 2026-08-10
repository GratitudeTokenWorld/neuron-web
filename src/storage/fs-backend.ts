import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { BlockBackend } from '../engine/content/backend.js';
import type { Cid } from '../engine/content/cid.js';

/**
 * Filesystem block backend — the default for any server-side storage node, and
 * the honest bottom layer of the storage tier: plain files, no service, no
 * account, no dependency. The protocol must run with every node on local disk
 * (ARCHITECTURE.md → Subsystem 4), and this is that node.
 *
 * Lives outside `src/engine` on purpose: the engine is deliberately DOM- and
 * Node-free so it stays browser/worker-portable, and this file imports
 * `node:fs`. Everything policy-shaped (chunk cap, quota accounting, dedup
 * pre-check) stays in `ContentStore`; a backend only stores bytes.
 *
 * Layout: `<root>/<first 2 hex>/<cid>`. The two-character fan-out keeps
 * directory sizes sane on filesystems that degrade with very large flat
 * directories — a real concern for the Pi + SD-card class of node this tier is
 * meant to include. CIDs are hex hashes, so the prefix distributes evenly.
 */
export class FileSystemBackend implements BlockBackend {
  /** Cached total; -1 until the first scan (see {@link bytesUsed}). */
  private used = -1;

  constructor(private readonly root: string) {}

  private pathFor(cid: Cid): string {
    // CIDs are hex; guard anyway so a malformed cid can never escape the root.
    if (!/^[0-9a-f]{4,}$/i.test(cid)) throw new Error(`invalid cid: ${cid}`);
    return join(this.root, cid.slice(0, 2), cid);
  }

  async has(cid: Cid): Promise<boolean> {
    const path = this.pathFor(cid); // outside the catch: see get()
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  async get(cid: Cid): Promise<Uint8Array | undefined> {
    // Resolve the path OUTSIDE the try. A malformed cid is a caller bug that
    // must surface; swallowing it would report an attempted path escape as an
    // ordinary cache miss.
    const path = this.pathFor(cid);
    try {
      return new Uint8Array(await fs.readFile(path));
    } catch {
      return undefined; // absent or unreadable — a miss either way
    }
  }

  /**
   * Write via a temp file + atomic rename, so a crash or a full disk mid-write
   * can never leave a truncated block that would later fail its CID check and
   * read as corruption rather than absence.
   */
  async put(cid: Cid, bytes: Uint8Array): Promise<number> {
    if (await this.has(cid)) return 0; // content-addressed dedup
    const path = this.pathFor(cid);
    await fs.mkdir(join(this.root, cid.slice(0, 2)), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, bytes);
    await fs.rename(tmp, path);
    if (this.used >= 0) this.used += bytes.length;
    return bytes.length;
  }

  async delete(cid: Cid): Promise<number> {
    const path = this.pathFor(cid); // outside the catch: see get()
    try {
      const { size } = await fs.stat(path);
      await fs.unlink(path);
      if (this.used >= 0) this.used -= size;
      return size;
    } catch {
      return 0;
    }
  }

  /** Scanned once on first call, then tracked incrementally by put/delete. */
  async bytesUsed(): Promise<number> {
    if (this.used >= 0) return this.used;
    let total = 0;
    for (const { path } of await this.entries()) {
      try {
        total += (await fs.stat(path)).size;
      } catch { /* vanished mid-scan — ignore */ }
    }
    this.used = total;
    return total;
  }

  async list(): Promise<Cid[]> {
    return (await this.entries()).map((e) => e.cid);
  }

  /** Walk the two-level layout, skipping temp files and anything unexpected. */
  private async entries(): Promise<{ cid: Cid; path: string }[]> {
    const out: { cid: Cid; path: string }[] = [];
    let shards: string[];
    try {
      shards = await fs.readdir(this.root);
    } catch {
      return out; // root not created yet — an empty store, not an error
    }
    for (const shard of shards) {
      if (shard.length !== 2) continue;
      let names: string[];
      try {
        names = await fs.readdir(join(this.root, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.tmp')) continue; // interrupted write
        out.push({ cid: name, path: join(this.root, shard, name) });
      }
    }
    return out;
  }
}
