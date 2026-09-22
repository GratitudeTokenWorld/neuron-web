import { hashJson, canonicalJson, utf8ToBytes, type Hex } from './hash.js';
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

export type BlockType =
  | 'open'
  | 'send'
  | 'receive'
  | 'update'
  // Native NFTs (Bucket B): an NFT is a small ownership key on the account-chain —
  // mint binds a token to content (CID) + metadata; send/receive transfer ownership
  // exactly like a payment (block-lattice, claim-on-receive); burn destroys it.
  | 'nft-mint'
  | 'nft-send'
  | 'nft-receive'
  | 'nft-burn'
  // Storage economy (Phase 3): a provider declares capacity, proves liveness on a
  // ~4h cadence (the heartbeat IS the custody lease renewal), and self-issues a
  // daily reward metered by that evidence. See engine/content/provider-ledger.
  | 'storage-register'
  | 'storage-deregister'
  | 'storage-settle';

/**
 * Payload for the four `storage-*` block types. One optional object rather than
 * six flat fields, so the storage economy stays legible next to the payment and
 * NFT fields — `canonicalJson` sorts nested keys, so hashing stays deterministic.
 */
/** The receipt shape as it appears on the wire (mirrors `content/read-receipts.ts`). */
export interface ReadReceiptWire {
  reader: string;
  provider: string;
  counter: number;
  bytesTotal: number;
  readsTotal: number;
  lastLatencyMs: number;
  ts: number;
}

export interface StoragePayload {
  /** register: declared capacity in GB — an upper bound offered, not usage. */
  capacityGB?: number;
  /** register: stable device id. Custody is per-device, not per-account. */
  deviceId?: string;
  /**
   * register: what kind of device this is, and how many concurrent reads it
   * offers to serve. Both are DECLARATIONS and neither is trusted on its own —
   * they seed a measurement (`content/calibration.ts`), and the network plans
   * bandwidth against what probers observed rather than against these.
   */
  deviceClass?: string;
  declaredConcurrency?: number;
  /**
   * settle: the reader-signed receipts the payout is derived from.
   *
   * They travel IN the block because validation may not depend on state a
   * particular node happens to hold — a peer that had not seen the same
   * receipts would reject a correctly-issued block and strand every block
   * behind it. Carrying them makes the settlement self-contained: any node
   * re-derives the same number from the same bytes.
   *
   * Bounded by `MAX_RECEIPTS_PER_SETTLEMENT`; readers that do not fit roll over
   * to the next settlement, because their baselines only move when they are
   * actually settled.
   */
  receipts?: ReadonlyArray<{ receipt: ReadReceiptWire; signature: string }>;
  /** settle: the settlement period, strictly increasing per account. */
  periodIndex?: number;
  /** settle: roots of the off-chain publish and service records. */
  publishRoot?: string;
  serviceRoot?: string;
}

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
  // update-only: a signed metadata patch (username, profile fields, linkedAnchor,
  // pqPub, …) applied to the account record. String→string keeps the canonical
  // encoding deterministic and balance-free.
  updates?: Record<string, string>;
  // nft-*: token id (all), the content reference (CID) + metadata (mint only).
  // `recipient` (send) and `sourceHash` (receive) are reused from payments.
  tokenId?: Hex;
  contentRef?: string;
  nftMeta?: Record<string, string>;
  // Denormalized counterparty for display WITHOUT holding the counterparty's chain
  // (a recipient discards the sender's chain after claiming — scale invariant). The
  // pub enables a fresh username lookup when the account record is held; the name is
  // a point-in-time snapshot fallback (a later rename won't change a past tx record,
  // like a bank statement). `recipientName` on send/nft-send; `senderPub`+
  // `senderName` on receive/nft-receive.
  recipientName?: string;
  senderPub?: Hex;
  senderName?: string;
  // storage-*: the provider payload. `amount` (above) carries the minted
  // milli-UNIT on a storage-reward, exactly as it carries value on a send.
  storage?: StoragePayload;
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
    out.recipientName = c.recipientName;
  } else if (c.type === 'receive') {
    out.sourceHash = c.sourceHash;
    out.amount = c.amount?.toString();
    out.senderPub = c.senderPub;
    out.senderName = c.senderName;
  } else if (c.type === 'update') {
    out.updates = c.updates;
  } else if (c.type === 'nft-mint') {
    out.tokenId = c.tokenId;
    out.contentRef = c.contentRef;
    out.nftMeta = c.nftMeta;
  } else if (c.type === 'nft-send') {
    out.tokenId = c.tokenId;
    out.recipient = c.recipient;
    out.recipientName = c.recipientName;
  } else if (c.type === 'nft-receive') {
    out.tokenId = c.tokenId;
    out.sourceHash = c.sourceHash;
    out.senderPub = c.senderPub;
    out.senderName = c.senderName;
  } else if (c.type === 'nft-burn') {
    out.tokenId = c.tokenId;
  } else if (
    c.type === 'storage-register' || c.type === 'storage-deregister'
  ) {
    out.storage = c.storage;
  } else if (c.type === 'storage-settle') {
    // The receipts AND the minted amount are both signed. The settlement's
    // whole security argument is that any node can re-derive the amount from
    // the receipts carried here and compare it with what the signer committed
    // to — so both have to be inside the signature.
    out.storage = c.storage;
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
  return verifyBlockSignature(block);
}

/** Signature-only check (assumes/!\ does not re-derive the content hash). */
export function verifyBlockSignature(block: Block): boolean {
  return verify(block.signature, blockSigningMessage(block.hash, block.accumulatorRoot), block.accountId);
}

/** Serialize a block to bytes (canonical, bigint-safe) for storage/archival. */
export function encodeBlock(block: Block): Uint8Array {
  return utf8ToBytes(canonicalJson(block));
}

/** Deserialize a block produced by {@link encodeBlock}, reviving bigint fields. */
export function decodeBlock(bytes: Uint8Array): Block {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  const block = { ...raw, balance: BigInt(raw.balance as string) } as unknown as Block;
  if (raw.amount !== undefined) block.amount = BigInt(raw.amount as string);
  return block;
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
