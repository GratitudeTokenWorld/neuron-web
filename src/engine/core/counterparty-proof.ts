import { type Block, verifyBlock } from './block.js';
import { AccountAccumulator, verifyInclusion } from './accumulator.js';
import { verifyAccountHead } from './light-verify.js';
import type { QuorumPolicy } from './attestation.js';
import type { Hex } from './hash.js';

/**
 * Counterparty proof packet — the G2 fix, promoted from the sim harness
 * (`sim/counterparty.ts` measured it: ~3.4 KB flat vs an O(chain) pull).
 *
 * A recipient verifies a payment WITHOUT holding the sender's chain:
 *
 *   { openBlock, headBlock, openInclusionProof }  → verifyAccountHead: the head
 *     is the tip of a chain whose genesis proves a verified human (O(log n))
 *   { sendBlock, sendInclusionProof }             → the payment is committed by
 *     that same signed head (O(log n))
 *
 * Any chain holder can build a packet (a super-node archive, or a peer that
 * still holds the chain); nobody has to be TRUSTED to build one — every field
 * is verified against the sender's own signatures. After verifying, the
 * recipient keeps its own receive block and drops everything else.
 */

export interface CounterpartyPacket {
  /** Sender's genesis — carries the identity commitment + attestation quorum. */
  openBlock: Block;
  /** Sender's current head — its accumulatorRoot commits the whole history. */
  headBlock: Block;
  /** Audit path: openBlock is leaf 0 under headBlock.accumulatorRoot. */
  openInclusionProof: Hex[];
  /** The transfer being claimed (send or nft-send). */
  sendBlock: Block;
  /** Audit path: sendBlock is leaf `sendBlock.index` under the same root. */
  sendInclusionProof: Hex[];
}

export interface PacketVerification {
  ok: boolean;
  reason?: string;
}

/**
 * Build a packet from a full, in-order chain (a holder's view — super-node
 * archive rows or a held chain). Recomputes the accumulator from the block
 * hashes, so the caller needs only the ordered blocks.
 */
export function buildPacketFromChain(blocks: readonly Block[], sendHash: Hex): CounterpartyPacket | null {
  if (blocks.length === 0) return null;
  const sendIndex = blocks.findIndex((b) => b.hash === sendHash);
  if (sendIndex < 0) return null;
  const acc = new AccountAccumulator();
  for (const b of blocks) acc.append(b.hash);
  return {
    openBlock: blocks[0]!,
    headBlock: blocks[blocks.length - 1]!,
    openInclusionProof: acc.proofHex(0),
    sendBlock: blocks[sendIndex]!,
    sendInclusionProof: acc.proofHex(sendIndex),
  };
}

/**
 * The recipient's full check, holding NOTHING of the sender beforehand:
 * chain authenticity + verified-human genesis + the transfer's inclusion +
 * that the transfer is addressed to `recipient`.
 */
export function verifyPacket(
  packet: CounterpartyPacket,
  recipient: Hex,
  identityPolicy: QuorumPolicy,
): PacketVerification {
  const head = verifyAccountHead(
    {
      openBlock: packet.openBlock,
      headBlock: packet.headBlock,
      openInclusionProof: packet.openInclusionProof,
    },
    identityPolicy,
  );
  if (!head.ok) return { ok: false, reason: `head: ${head.reason}` };

  const send = packet.sendBlock;
  if (send.type !== 'send' && send.type !== 'nft-send') {
    return { ok: false, reason: 'packet block is not a send' };
  }
  if (send.accountId !== packet.headBlock.accountId) {
    return { ok: false, reason: 'send block belongs to a different account' };
  }
  if (send.recipient !== recipient) return { ok: false, reason: 'send is not addressed to this recipient' };
  if (!verifyBlock(send)) return { ok: false, reason: 'send block failed signature/hash check' };

  const treeSize = packet.headBlock.index + 1;
  const included = verifyInclusion(
    packet.headBlock.accumulatorRoot,
    send.hash,
    send.index,
    treeSize,
    packet.sendInclusionProof,
  );
  if (!included) return { ok: false, reason: 'send block is not committed by the head accumulator root' };
  return { ok: true };
}
