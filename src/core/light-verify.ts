import type { Block } from './block.js';
import { verifyBlock, GENESIS_PREV } from './block.js';
import { verifyInclusion } from './accumulator.js';
import { checkQuorum, type QuorumPolicy } from './attestation.js';
import type { Hex } from './hash.js';

/**
 * Light-client verification — the Phase 0 keystone.
 *
 * A light client that follows an account does NOT replay or store that account's
 * chain. It is handed a compact proof and decides whether to trust the head:
 *
 *   1. the genesis OPEN block (carries the identity commitment + attestation
 *      quorum that prove a unique verified human), and
 *   2. the current HEAD block (carries the accumulator root over the whole
 *      history, signed by the account), and
 *   3. an inclusion proof that the OPEN block is leaf 0 of the history the HEAD's
 *      accumulator root commits to.
 *
 * If all three check out, the client knows: this head is the tip of an account
 * chain, signed throughout by `accountId`, whose genesis proves a unique verified
 * human — verified from O(log n) data, never the full chain. (Confirming the head
 * is the *latest* head and that its balance is canonical is the shard committee's
 * job — Phase 2; this establishes chain authenticity, which is the prerequisite.)
 */

export interface AccountHeadProof {
  /** Genesis open block of the account. */
  openBlock: Block;
  /** Current head block of the account. */
  headBlock: Block;
  /** Audit path proving openBlock.hash is leaf 0 under headBlock.accumulatorRoot. */
  openInclusionProof: Hex[];
}

export interface HeadVerification {
  ok: boolean;
  reason?: string;
  accountId?: Hex;
  /** Balance claimed by the verified head (authenticity proven; recency is Phase 2). */
  balance?: bigint;
}

export function verifyAccountHead(proof: AccountHeadProof, identityPolicy: QuorumPolicy): HeadVerification {
  const { openBlock, headBlock, openInclusionProof } = proof;

  // 1. The open block must be a well-formed, correctly-signed genesis block.
  if (openBlock.type !== 'open' || openBlock.index !== 0 || openBlock.previousHash !== GENESIS_PREV) {
    return { ok: false, reason: 'open block is not a valid genesis block' };
  }
  if (!verifyBlock(openBlock)) {
    return { ok: false, reason: 'open block failed signature/hash check' };
  }

  // 2. Identity: the open block's attestation quorum must vouch for its commitment.
  if (!openBlock.identityCommitment || !openBlock.attestations) {
    return { ok: false, reason: 'open block missing identity commitment or attestations' };
  }
  const quorum = checkQuorum(openBlock.attestations, openBlock.identityCommitment, identityPolicy);
  if (!quorum.ok) {
    return { ok: false, reason: `identity quorum failed: ${quorum.reason}` };
  }

  // 3. The head must be a well-formed, correctly-signed block for the same account.
  if (!verifyBlock(headBlock)) {
    return { ok: false, reason: 'head block failed signature/hash check' };
  }
  if (headBlock.accountId !== openBlock.accountId) {
    return { ok: false, reason: 'head and open block belong to different accounts' };
  }

  // 4. The head's accumulator root must commit to a history whose leaf 0 is the
  //    open block — proving the head descends from this verified genesis.
  const treeSize = headBlock.index + 1;
  const included = verifyInclusion(
    headBlock.accumulatorRoot,
    openBlock.hash,
    0,
    treeSize,
    openInclusionProof,
  );
  if (!included) {
    return { ok: false, reason: 'open block is not committed by the head accumulator root' };
  }

  return { ok: true, accountId: headBlock.accountId, balance: headBlock.balance };
}
