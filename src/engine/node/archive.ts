import { type Block, encodeBlock, decodeBlock, verifyBlock } from '../core/block.js';
import type { ContentStore } from '../content/content-store.js';
import { cidOf, type Cid } from '../content/cid.js';
import type { Hex } from '../core/hash.js';

/**
 * Block archival — cold history moves to content-addressed storage instead of
 * being destructively pruned (the old design silently deleted blocks past a cap).
 *
 * A block body is serialized and stored by its CID in a {@link ContentStore}
 * (which a super-node backs durably). The account's Merkle accumulator still
 * commits every block's hash, so an archived block remains *provable* (via an
 * inclusion proof against the head's accumulator root) and *retrievable* (by CID,
 * with integrity re-checked on the way back). Nothing is lost.
 */

export interface ArchiveRef {
  accountId: Hex;
  index: number;
  hash: Hex;
  cid: Cid;
}

export class BlockArchive {
  constructor(private readonly store: ContentStore) {}

  /** Move a block body into content-addressed storage; return a compact reference. */
  archive(block: Block): ArchiveRef {
    const bytes = encodeBlock(block);
    const cid = cidOf(bytes);
    const r = this.store.putBlock(cid, bytes);
    if (!r.ok) throw new Error(`archive failed: ${r.reason}`);
    return { accountId: block.accountId, index: block.index, hash: block.hash, cid };
  }

  /** Retrieve and fully re-verify an archived block. Returns null on any mismatch. */
  retrieve(ref: ArchiveRef): Block | null {
    const bytes = this.store.getBlock(ref.cid);
    if (!bytes) return null;
    if (cidOf(bytes) !== ref.cid) return null; // content integrity
    const block = decodeBlock(bytes);
    if (block.hash !== ref.hash) return null; // matches the committed leaf
    if (!verifyBlock(block)) return null; // signature + content hash
    return block;
  }
}
