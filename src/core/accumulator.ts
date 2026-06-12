import { hash, bytesToHex, hexToBytes, type Hex } from './hash.js';

/**
 * Per-account Merkle accumulator — the keystone primitive for light verification.
 *
 * Each account is an append-only chain of blocks. The accumulator commits to that
 * whole history in a single root (carried in each block header). A light client
 * that holds only an account's *head* can then verify that any given block is
 * part of that account's history with an O(log n) inclusion proof — it never has
 * to replay or store the chain. That is what makes per-node cost O(own + followed)
 * instead of O(network).
 *
 * Construction is RFC 6962 (Certificate Transparency): domain-separated leaf
 * (0x00) and node (0x01) hashes, prevent second-preimage attacks.
 *
 * This reference implementation recomputes from the full leaf list (O(n) append,
 * O(n) proof). It is intentionally simple and obviously correct for Phase 0; a
 * production node swaps in an MMR / CT history-tree for O(log n) appends behind
 * the same interface (rootHex / proof / verifyInclusion).
 */

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function leafHash(data: Uint8Array): Uint8Array {
  return hash(LEAF_PREFIX, data);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return hash(NODE_PREFIX, left, right);
}

/** Largest power of two strictly less than n (n > 1). */
function splitPoint(n: number): number {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
}

/** RFC 6962 Merkle Tree Hash over a list of leaf byte-strings. */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  const n = leaves.length;
  if (n === 0) return hash(new Uint8Array(0));
  if (n === 1) return leafHash(leaves[0]!);
  const k = splitPoint(n);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** RFC 6962 audit path proving membership of leaf `index` in `leaves`. */
export function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  const n = leaves.length;
  if (index < 0 || index >= n) throw new RangeError(`index ${index} out of range [0, ${n})`);
  if (n === 1) return [];
  const k = splitPoint(n);
  if (index < k) {
    return [...merkleProof(leaves.slice(0, k), index), merkleRoot(leaves.slice(k))];
  }
  return [...merkleProof(leaves.slice(k), index - k), merkleRoot(leaves.slice(0, k))];
}

/**
 * RFC 6962 §2.1.1 inclusion-proof verification. Returns true iff `leaf` at
 * `index` in a tree of `treeSize` leaves yields `root` given `proof`.
 */
export function verifyMerkleProof(
  root: Uint8Array,
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: Uint8Array[],
): boolean {
  if (index < 0 || index >= treeSize) return false;
  if (treeSize === 1) return proof.length === 0 && bytesEqual(leafHash(leaf), root);

  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) return false; // path longer than the tree is deep
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        do {
          fn >>= 1;
          sn >>= 1;
        } while ((fn & 1) === 0 && fn !== 0);
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && bytesEqual(r, root);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function toBytes(leaf: Uint8Array | Hex): Uint8Array {
  return typeof leaf === 'string' ? hexToBytes(leaf) : leaf;
}

/** Stateful append-only accumulator over a single account's leaves. */
export class AccountAccumulator {
  private readonly leaves: Uint8Array[] = [];

  get size(): number {
    return this.leaves.length;
  }

  /** Append one leaf (a block's content hash). Returns the new size. */
  append(leaf: Uint8Array | Hex): number {
    this.leaves.push(toBytes(leaf));
    return this.leaves.length;
  }

  root(): Uint8Array {
    return merkleRoot(this.leaves);
  }

  rootHex(): Hex {
    return bytesToHex(this.root());
  }

  /** Audit path (hex) for the leaf at `index`. */
  proofHex(index: number): Hex[] {
    return merkleProof(this.leaves, index).map(bytesToHex);
  }
}

/** Hex-friendly inclusion check for callers working with serialised proofs. */
export function verifyInclusion(
  rootHex: Hex,
  leaf: Uint8Array | Hex,
  index: number,
  treeSize: number,
  proofHex: Hex[],
): boolean {
  return verifyMerkleProof(
    hexToBytes(rootHex),
    toBytes(leaf),
    index,
    treeSize,
    proofHex.map(hexToBytes),
  );
}
