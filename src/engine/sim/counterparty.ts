import { generateKeyPair, type KeyPair } from '../core/keys.js';
import { AccountAccumulator, verifyInclusion } from '../core/accumulator.js';
import { createOpenBlock, createBlock, verifyBlock, MINT_AMOUNT, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import type { QuorumPolicy } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { verifyAccountHead } from '../core/light-verify.js';
import { canonicalJson, utf8ToBytes, type Hex } from '../core/hash.js';

/**
 * G2 measured: counterparty verification by PROOF instead of chain replication.
 *
 * Today (the G2 violation) a recipient pulls the sender's ENTIRE chain to verify
 * one payment and keeps it — O(chain length) bytes per counterparty, unbounded
 * for a high-counterparty account (a merchant paid by 100k people holds 100k
 * chains). The designed fix (ARCHITECTURE.md Subsystem 1, "verify without
 * holding") is a compact packet a super-node can serve:
 *
 *   { openBlock, headBlock, openInclusionProof,   ← verifyAccountHead: the head
 *                                                    is the tip of a chain whose
 *                                                    genesis proves a verified
 *                                                    human (O(log n))
 *     sendBlock, sendInclusionProof }             ← the payment is committed by
 *                                                    that same head (O(log n))
 *
 * The recipient verifies the packet, writes its own receive block, and DROPS the
 * sender's chain — per-payment cost is O(log n), per-counterparty steady state is
 * O(1). This module builds real signed chains, real RFC-6962 proofs, and measures
 * both paths so the gap is a number, not an argument.
 */

export interface CounterpartyPacket {
  /** Sender's genesis — carries the identity commitment + attestation quorum. */
  openBlock: Block;
  /** Sender's current head — its accumulatorRoot commits the whole history. */
  headBlock: Block;
  /** Audit path: openBlock is leaf 0 under headBlock.accumulatorRoot. */
  openInclusionProof: Hex[];
  /** The payment being claimed. */
  sendBlock: Block;
  /** Audit path: sendBlock is leaf `sendBlock.index` under the same root. */
  sendInclusionProof: Hex[];
}

export interface SenderChain {
  keys: KeyPair;
  blocks: Block[];
  accumulator: AccountAccumulator;
  attester: KeyPair;
}

/** Build a real signed sender chain of `length` blocks with a send at `sendIndex`. */
export function buildSenderChain(length: number, sendIndex: number, recipient: Hex = '00'): SenderChain {
  if (length < 2 || sendIndex < 1 || sendIndex >= length) {
    throw new RangeError(`need length ≥ 2 and 1 ≤ sendIndex < length (got ${length}, ${sendIndex})`);
  }
  const keys = generateKeyPair();
  const attester = generateKeyPair();
  const nullifier = keys.pub.slice(0, 16);
  const commitment = deriveCommitment(nullifier, keys.pub);
  const accumulator = new AccountAccumulator();
  const blocks: Block[] = [];
  blocks.push(
    createOpenBlock(
      {
        accountId: keys.pub,
        identityCommitment: commitment,
        attestations: [createAttestation('personhood', commitment, attester)],
        timestamp: 1000,
      },
      keys.priv,
      accumulator,
    ),
  );
  let balance = MINT_AMOUNT;
  for (let i = 1; i < length; i++) {
    balance -= 1n;
    blocks.push(
      createBlock(
        {
          accountId: keys.pub,
          index: i,
          type: 'send',
          previousHash: blocks[i - 1]!.hash,
          shard: blocks[0]!.shard,
          timestamp: 1000 + i,
          balance,
          recipient: i === sendIndex ? recipient : '00',
          amount: 1n,
        },
        keys.priv,
        accumulator,
      ),
    );
  }
  return { keys, blocks, accumulator, attester };
}

/** What a super-node holding the sender's chain would serve to the recipient. */
export function buildPacket(chain: SenderChain, sendIndex: number): CounterpartyPacket {
  return {
    openBlock: chain.blocks[0]!,
    headBlock: chain.blocks[chain.blocks.length - 1]!,
    openInclusionProof: chain.accumulator.proofHex(0),
    sendBlock: chain.blocks[sendIndex]!,
    sendInclusionProof: chain.accumulator.proofHex(sendIndex),
  };
}

export interface PacketVerification {
  ok: boolean;
  reason?: string;
}

/**
 * The recipient's full check, holding NOTHING of the sender beforehand:
 * chain authenticity + verified-human genesis + the payment's inclusion.
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
  if (send.type !== 'send') return { ok: false, reason: 'packet block is not a send' };
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

/** Canonical on-wire size of any JSON-able value (bigint-safe via canonicalJson). */
export function wireBytes(value: unknown): number {
  return utf8ToBytes(canonicalJson(value)).length;
}

export interface CounterpartyCost {
  chainLength: number;
  /** Today's path (G2): pull + keep the whole sender chain. */
  fullChainBytes: number;
  /** Fixed path: the compact packet, then drop everything but own receive. */
  packetBytes: number;
  /** Hashes in the two inclusion proofs — the O(log n) part, explicitly. */
  proofHashes: number;
}

/** Sweep chain lengths and measure both verification paths on real chains. */
export function measureCounterparty(chainLengths: number[]): CounterpartyCost[] {
  return chainLengths.map((length) => {
    const sendIndex = length >> 1;
    const chain = buildSenderChain(length, sendIndex);
    const packet = buildPacket(chain, sendIndex);
    return {
      chainLength: length,
      fullChainBytes: chain.blocks.reduce((sum, b) => sum + wireBytes(b), 0),
      packetBytes: wireBytes(packet),
      proofHashes: packet.openInclusionProof.length + packet.sendInclusionProof.length,
    };
  });
}
