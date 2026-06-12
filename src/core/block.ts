import { hashJson, type Hex } from './hash.js';
import { sign, verify } from './keys.js';
import { getShard, DEFAULT_NUM_SHARDS } from './partition.js';
import { AccountAccumulator } from './accumulator.js';
import type { TypedAttestation } from './attestation.js';
import type { IdentityCommitment } from './identity.js';

/**
 * The account-chain block model.
 *
 * Each account is its own append-only chain (open → send/receive → …). Two things
 * make the chain light-verifiable and shardable:
 *   - every block carries the `accumulatorRoot` of the account's history up to and
 *     including itself, so a holder of the head commits to the whole past;
 *   - every block carries its `shard`, so routing/holding decisions need only the
 *     header.
 *
 * The genesis `open` block additionally carries the identity commitment and the
 * attestation quorum that prove the account belongs to a unique verified human.
 */

export const GENESIS_PREV: Hex = '0'.repeat(64);

/** Free mint granted to each verified human on account open (see roadmap economics). */
export const MINT_AMOUNT = 1_000_000n;

export type BlockType = 'open' | 'send' | 'receive';

/** The signed content of a block (everything except the derived root/hash/sig). */
export interface BlockContent {
  accountId: Hex;
  index: number;
  type: BlockType;
  previousHash: Hex;
  shard: number;
  timestamp: number;
  balance: bigint;
  // open-only
  identityCommitment?: IdentityCommitment;
  attestations?: TypedAttestation[];
  // send-only
  recipient?: Hex;
  // receive-only
  sourceHash?: Hex;
  // send/receive
  amount?: bigint;
}

export interface Block extends BlockContent {
  /** Merkle accumulator root over the account's history including this block. */
  accumulatorRoot: Hex;
  /** Content hash — the block's canonical id; the next block's `previousHash`. */
  hash: Hex;
  /** Signature by `accountId` over (hash, accumulatorRoot). */
  signature: Hex;
}

/** Build the canonical content object that gets hashed (stable across nodes). */
function canonicalContent(c: BlockContent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    accountId: c.accountId,
    index: c.index,
    type: c.type,
    previousHash: c.previousHash,
    shard: c.shard,
    timestamp: c.timestamp,
    balance: c.balance.toString(),
  };
  if (c.type === 'open') {
    out.identityCommitment = c.identityCommitment;
    out.attestations = c.attestations;
  } else if (c.type === 'send') {
    out.recipient = c.recipient;
    out.amount = c.amount?.toString();
  } else if (c.type === 'receive') {
    out.sourceHash = c.sourceHash;
    out.amount = c.amount?.toString();
  }
  return out;
}

export function computeContentHash(content: BlockContent): Hex {
  return hashJson(canonicalContent(content));
}

/** Canonical message signed by the account over a block. */
function blockSigningMessage(hash: Hex, accumulatorRoot: Hex): string {
  return `block ${hash} ${accumulatorRoot}`;
}

/**
 * Finalise a block: derive its content hash, append it to the account's
 * accumulator, capture the new root, and sign. Mutates `accumulator` (appends one
 * leaf). The caller owns one `AccountAccumulator` per account.
 */
export function createBlock(
  content: BlockContent,
  signerPriv: Hex,
  accumulator: AccountAccumulator,
): Block {
  const hash = computeContentHash(content);
  accumulator.append(hash);
  const accumulatorRoot = accumulator.rootHex();
  const signature = sign(blockSigningMessage(hash, accumulatorRoot), signerPriv);
  return { ...content, accumulatorRoot, hash, signature };
}

/**
 * Verify a block in isolation: its content hash is consistent and its signature
 * is valid under `accountId`. (This does NOT prove the accumulator root matches
 * the full chain — that is what inclusion proofs against the head are for; see
 * light-verify.)
 */
export function verifyBlock(block: Block): boolean {
  if (computeContentHash(block) !== block.hash) return false;
  return verify(block.signature, blockSigningMessage(block.hash, block.accumulatorRoot), block.accountId);
}

export interface OpenAccountParams {
  accountId: Hex;
  identityCommitment: IdentityCommitment;
  attestations: TypedAttestation[];
  timestamp: number;
  balance?: bigint;
  numShards?: number;
}

/** Convenience builder for the genesis open block. */
export function createOpenBlock(
  params: OpenAccountParams,
  signerPriv: Hex,
  accumulator: AccountAccumulator,
): Block {
  const content: BlockContent = {
    accountId: params.accountId,
    index: 0,
    type: 'open',
    previousHash: GENESIS_PREV,
    shard: getShard(params.accountId, params.numShards ?? DEFAULT_NUM_SHARDS),
    timestamp: params.timestamp,
    balance: params.balance ?? MINT_AMOUNT,
    identityCommitment: params.identityCommitment,
    attestations: params.attestations,
  };
  return createBlock(content, signerPriv, accumulator);
}
