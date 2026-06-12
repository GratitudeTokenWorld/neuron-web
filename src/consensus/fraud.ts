import { type Block, verifyBlock } from '../core/block.js';
import type { Hex } from '../core/hash.js';

/**
 * Double-spend fraud proof — the basis of recipient-witnessed cross-shard finality.
 *
 * An account double-spends by signing two different blocks at the same height
 * (same `accountId`, same `index`, same `previousHash`, different `hash`). Both
 * blocks carry the account's own signature, so the pair is self-incriminating: any
 * node — crucially, a RECIPIENT in another shard who is asked to accept one of the
 * spends — can present the two blocks as a compact, independently-verifiable proof
 * to reject the transfer and (if the account is a validator) trigger slashing.
 *
 * This is why a captured sender-shard committee cannot quietly defraud a recipient
 * in another shard: the evidence travels with the conflicting blocks and is
 * checkable without any shard's cooperation.
 */

export interface DoubleSpendEvidence {
  accountId: Hex;
  index: number;
  previousHash: Hex;
  a: Block;
  b: Block;
}

/** Build evidence iff `a` and `b` are a genuine double-spend by one account. */
export function proveDoubleSpend(a: Block, b: Block): DoubleSpendEvidence | null {
  if (a.accountId !== b.accountId) return null;
  if (a.hash === b.hash) return null;
  if (a.index !== b.index || a.previousHash !== b.previousHash) return null;
  return { accountId: a.accountId, index: a.index, previousHash: a.previousHash, a, b };
}

/** Independently verify double-spend evidence: both blocks valid + genuinely conflicting. */
export function verifyDoubleSpend(ev: DoubleSpendEvidence): boolean {
  const { a, b } = ev;
  return (
    a.accountId === b.accountId &&
    a.hash !== b.hash &&
    a.index === b.index &&
    a.previousHash === b.previousHash &&
    verifyBlock(a) &&
    verifyBlock(b)
  );
}
