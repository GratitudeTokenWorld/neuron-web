import { type Block, computeContentHash, verifyBlockSignature, GENESIS_PREV } from '../core/block.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { BlockArchive, type ArchiveRef } from './archive.js';
import type { Hex } from '../core/hash.js';

/**
 * Account store with a bounded hot window + archival of cold history.
 *
 * Keeps the most recent `hotWindow` block bodies in memory and moves older bodies
 * to a {@link BlockArchive} (content-addressed, super-node-backed). The Merkle
 * accumulator (leaf hashes only — tiny) is retained for the full chain, so any
 * block, hot or archived, can be produced with an inclusion proof against the
 * head root. This bounds hot memory while losing nothing.
 *
 * (Production keeps O(log n) accumulator peaks via an MMR rather than all leaf
 * hashes; the interface below is unchanged.)
 */

interface Held {
  acc: AccountAccumulator;
  hot: Block[];
  archived: Map<number, ArchiveRef>;
  length: number;
}

export interface ArchiveApplyResult {
  ok: boolean;
  reason?: string;
}

export interface ProvenBlock {
  block: Block;
  index: number;
  proof: Hex[];
  root: Hex;
  treeSize: number;
}

export class ArchivingStore {
  private readonly accounts = new Map<Hex, Held>();

  constructor(
    private readonly archive: BlockArchive,
    private readonly hotWindow = 128,
    private readonly verifySignatures = true,
  ) {}

  apply(block: Block): ArchiveApplyResult {
    if (computeContentHash(block) !== block.hash) return { ok: false, reason: 'content hash mismatch' };
    if (this.verifySignatures && !verifyBlockSignature(block)) return { ok: false, reason: 'invalid signature' };

    let held = this.accounts.get(block.accountId);
    if (block.index === 0) {
      if (block.type !== 'open' || block.previousHash !== GENESIS_PREV) {
        return { ok: false, reason: 'index 0 must be a genesis open block' };
      }
      if (held) {
        const g = held.hot[0] ?? null;
        return g && g.hash === block.hash ? { ok: true } : { ok: false, reason: 'conflicting open block' };
      }
      held = { acc: new AccountAccumulator(), hot: [], archived: new Map(), length: 0 };
      this.accounts.set(block.accountId, held);
    } else {
      if (!held) return { ok: false, reason: 'missing prior chain (genesis not seen)' };
      const head = held.hot[held.hot.length - 1]!;
      if (block.index !== held.length) return { ok: false, reason: `non-sequential index ${block.index}` };
      if (block.previousHash !== head.hash) return { ok: false, reason: 'previousHash does not match head' };
    }

    if (held.acc.rootWithHex(block.hash) !== block.accumulatorRoot) {
      return { ok: false, reason: 'accumulator root mismatch' };
    }
    held.acc.append(block.hash);
    held.hot.push(block);
    held.length++;

    while (held.hot.length > this.hotWindow) {
      const old = held.hot.shift()!;
      held.archived.set(old.index, this.archive.archive(old));
    }
    return { ok: true };
  }

  head(accountId: Hex): Block | undefined {
    const h = this.accounts.get(accountId);
    return h ? h.hot[h.hot.length - 1] : undefined;
  }

  length(accountId: Hex): number {
    return this.accounts.get(accountId)?.length ?? 0;
  }

  /** Total block bodies kept hot in memory — the bounded footprint. */
  hotCount(): number {
    let n = 0;
    for (const h of this.accounts.values()) n += h.hot.length;
    return n;
  }

  /** Total block bodies offloaded to the archive. */
  archivedCount(): number {
    let n = 0;
    for (const h of this.accounts.values()) n += h.archived.size;
    return n;
  }

  /** Fetch any block (hot or archived) together with a proof of its membership. */
  getProven(accountId: Hex, index: number): ProvenBlock | null {
    const h = this.accounts.get(accountId);
    if (!h || index < 0 || index >= h.length) return null;

    let block: Block | undefined;
    const oldestHot = h.hot[0]!.index;
    if (index >= oldestHot) {
      block = h.hot.find((b) => b.index === index);
    } else {
      const ref = h.archived.get(index);
      block = ref ? this.archive.retrieve(ref) ?? undefined : undefined;
    }
    if (!block) return null;

    return { block, index, proof: h.acc.proofHex(index), root: h.acc.rootHex(), treeSize: h.length };
  }
}
