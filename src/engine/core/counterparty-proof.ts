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

/**
 * Proof that an NFT's MINT record is genuinely on the minter's chain.
 *
 * A transfer packet proves "this account sent you this token"; it cannot prove
 * what the token IS. `contentRef` + metadata live in the `nft-mint` block on
 * the MINTER's chain — a different account from the sender after the first
 * hop — so a recipient that holds neither chain needs a second, independently
 * verified proof. Without it the claim succeeds but the token has no content
 * to render (`getNftsOwnedBy` skips tokens with no info), which is why NFT
 * claims stayed on the whole-chain pull until this existed.
 */
export interface MintProof {
  /** Minter's genesis — carries the identity commitment + attestation quorum. */
  openBlock: Block;
  /** Minter's current head — its accumulatorRoot commits the whole history. */
  headBlock: Block;
  /** Audit path: openBlock is leaf 0 under headBlock.accumulatorRoot. */
  openInclusionProof: Hex[];
  /** The nft-mint block that defines the token. */
  mintBlock: Block;
  /** Audit path: mintBlock is leaf `mintBlock.index` under the same root. */
  mintInclusionProof: Hex[];
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
 * Build a mint proof from a holder's copy of the MINTER's chain. Same shape as
 * a transfer packet, anchored on the `nft-mint` block for `tokenId`.
 */
export function buildMintProofFromChain(blocks: readonly Block[], tokenId: Hex): MintProof | null {
  if (blocks.length === 0) return null;
  const mintIndex = blocks.findIndex((b) => b.type === 'nft-mint' && b.tokenId === tokenId);
  if (mintIndex < 0) return null;
  const acc = new AccountAccumulator();
  for (const b of blocks) acc.append(b.hash);
  return {
    openBlock: blocks[0]!,
    headBlock: blocks[blocks.length - 1]!,
    openInclusionProof: acc.proofHex(0),
    mintBlock: blocks[mintIndex]!,
    mintInclusionProof: acc.proofHex(mintIndex),
  };
}

/**
 * The half both proof shapes share: the head is authentic (well-formed genesis
 * with a satisfied attestation quorum, correctly-signed head) and `block` is
 * genuinely committed by that head's accumulator root. Everything specific to
 * WHAT is being proven — a transfer to me, a token's mint — is layered on by
 * the callers below, so neither can accidentally skip the chain check.
 */
function verifyChainInclusion(
  openBlock: Block,
  headBlock: Block,
  openInclusionProof: Hex[],
  block: Block,
  blockInclusionProof: Hex[],
  identityPolicy: QuorumPolicy,
): PacketVerification {
  const head = verifyAccountHead({ openBlock, headBlock, openInclusionProof }, identityPolicy);
  if (!head.ok) return { ok: false, reason: `head: ${head.reason}` };

  if (block.accountId !== headBlock.accountId) {
    return { ok: false, reason: 'block belongs to a different account' };
  }
  if (!verifyBlock(block)) return { ok: false, reason: 'block failed signature/hash check' };

  const included = verifyInclusion(
    headBlock.accumulatorRoot,
    block.hash,
    block.index,
    headBlock.index + 1,
    blockInclusionProof,
  );
  if (!included) return { ok: false, reason: 'block is not committed by the head accumulator root' };
  return { ok: true };
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
  const send = packet.sendBlock;
  if (send.type !== 'send' && send.type !== 'nft-send') {
    return { ok: false, reason: 'packet block is not a send' };
  }
  if (send.recipient !== recipient) return { ok: false, reason: 'send is not addressed to this recipient' };
  return verifyChainInclusion(
    packet.openBlock, packet.headBlock, packet.openInclusionProof,
    send, packet.sendInclusionProof, identityPolicy,
  );
}

/**
 * Verify a token's mint record against the minter's own chain, holding none of
 * it: the token id must match the one being claimed, and the mint block must be
 * committed by a head whose genesis proves a verified human. A relay can serve
 * this but cannot invent a token, re-point one at other content, or attribute
 * someone else's mint to itself.
 */
export function verifyMintProof(
  proof: MintProof,
  tokenId: Hex,
  identityPolicy: QuorumPolicy,
): PacketVerification {
  const mint = proof.mintBlock;
  if (mint.type !== 'nft-mint') return { ok: false, reason: 'proof block is not an nft-mint' };
  if (mint.tokenId !== tokenId) return { ok: false, reason: 'mint block is for a different token' };
  if (!mint.contentRef) return { ok: false, reason: 'mint block has no content reference' };
  return verifyChainInclusion(
    proof.openBlock, proof.headBlock, proof.openInclusionProof,
    mint, proof.mintInclusionProof, identityPolicy,
  );
}
