import { type Block, computeContentHash, verifyBlockSignature, GENESIS_PREV } from '../core/block.js';
import { AccountAccumulator } from '../core/accumulator.js';
import type { Hex } from '../core/hash.js';

/**
 * Per-node storage of the account chains a node actually replicates.
 *
 * The whole point of the architecture is that a node holds ONLY the accounts it
 * cares about (its own + the ones it follows + — for super-nodes — its assigned
 * shards), so its footprint is O(own + followed), not O(network). This store is
 * that local state: a map of accountId → verified, in-order chain, with the
 * matching Merkle accumulator maintained as blocks are applied.
 *
 * Every applied block is fully validated: signature + content hash (verifyBlock),
 * sequential index, `previousHash` linkage to the current head, and that the
 * block's claimed `accumulatorRoot` matches the recomputed root. Out-of-order or
 * forged blocks are rejected without mutating state.
 */

interface HeldAccount {
  blocks: Block[];
  accumulator: AccountAccumulator;
}

export interface ApplyResult {
  ok: boolean;
  reason?: string;
}

export class AccountStore {
  private readonly accounts = new Map<Hex, HeldAccount>();

  /**
   * @param verifySignatures when true (default, production) every applied block's
   *   signature is checked. Simulations that generate honest blocks themselves can
   *   pass false to skip the redundant per-recipient signature re-verification —
   *   all structural checks (content hash, index linkage, accumulator root) still
   *   run, so routing/state correctness is unaffected.
   */
  constructor(private readonly verifySignatures: boolean = true) {}

  hasAccount(id: Hex): boolean {
    return this.accounts.has(id);
  }

  accountCount(): number {
    return this.accounts.size;
  }

  /** Total blocks held across all accounts — the node's memory footprint proxy. */
  blockCount(): number {
    let n = 0;
    for (const a of this.accounts.values()) n += a.blocks.length;
    return n;
  }

  head(id: Hex): Block | undefined {
    const a = this.accounts.get(id);
    return a ? a.blocks[a.blocks.length - 1] : undefined;
  }

  chain(id: Hex): readonly Block[] {
    return this.accounts.get(id)?.blocks ?? [];
  }

  /** Apply a block, validating it fully. Idempotent on already-known blocks. */
  apply(block: Block): ApplyResult {
    if (computeContentHash(block) !== block.hash) return { ok: false, reason: 'content hash mismatch' };
    if (this.verifySignatures && !verifyBlockSignature(block)) return { ok: false, reason: 'invalid signature' };

    if (block.index === 0) return this.applyGenesis(block);

    const held = this.accounts.get(block.accountId);
    if (!held) return { ok: false, reason: 'missing prior chain (genesis not seen yet)' };

    const head = held.blocks[held.blocks.length - 1]!;
    if (block.index <= head.index) {
      // Already have this height — accept iff it's the exact same block (idempotent).
      const existing = held.blocks[block.index];
      if (existing && existing.hash === block.hash) return { ok: true };
      return { ok: false, reason: `stale or conflicting block at index ${block.index}` };
    }
    if (block.index !== head.index + 1) {
      return { ok: false, reason: `non-sequential index ${block.index} (head at ${head.index})` };
    }
    if (block.previousHash !== head.hash) {
      return { ok: false, reason: 'previousHash does not match current head' };
    }
    return this.commit(held, block);
  }

  private applyGenesis(block: Block): ApplyResult {
    if (block.type !== 'open' || block.previousHash !== GENESIS_PREV) {
      return { ok: false, reason: 'index 0 must be a genesis open block' };
    }
    const existing = this.accounts.get(block.accountId);
    if (existing) {
      const g = existing.blocks[0];
      return g && g.hash === block.hash
        ? { ok: true }
        : { ok: false, reason: 'conflicting open block for existing account' };
    }
    const held: HeldAccount = { blocks: [], accumulator: new AccountAccumulator() };
    this.accounts.set(block.accountId, held);
    return this.commit(held, block);
  }

  /** Verify the accumulator root then append (no rollback needed — peek first). */
  private commit(held: HeldAccount, block: Block): ApplyResult {
    if (held.accumulator.rootWithHex(block.hash) !== block.accumulatorRoot) {
      return { ok: false, reason: 'accumulator root mismatch' };
    }
    held.accumulator.append(block.hash);
    held.blocks.push(block);
    return { ok: true };
  }
}
