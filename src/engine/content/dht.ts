import { hash, utf8ToBytes, type Hex } from '../core/hash.js';
import type { Cid } from './cid.js';

/**
 * Provider-record DHT (Chord) — replaces the global gossiped file index.
 *
 * In the old design every node held a record for every file → O(total files) per
 * node, which breaks at scale. Here, a (cid → providers) record lives only on the
 * `k` nodes whose ids are closest to the cid's key on the ring. So:
 *   - per-node index size is O(total files · k / N) — i.e. independent of the
 *     total file count for a fixed files-per-node ratio (the scale fix), and
 *   - discovery routes in O(log N) hops via Chord finger tables.
 *
 * This is a simulation of the routing/storage distribution (production uses
 * libp2p's Kademlia). The ring is 32-bit; ids and cids map onto it by hashing.
 */

const RING_BITS = 32;

interface RingNode {
  id: Hex;
  key: number;
  index: number;
  fingers: number[]; // finger[i] → index of successor((key + 2^i) mod 2^32)
}

function ringKey(s: string): number {
  const h = hash(utf8ToBytes(s));
  return ((h[0]! << 24) | (h[1]! << 16) | (h[2]! << 8) | h[3]!) >>> 0;
}

/** x ∈ (a, b] on the modular ring. */
function inOpenClosed(x: number, a: number, b: number): boolean {
  if (a === b) return true;
  return a < b ? x > a && x <= b : x > a || x <= b;
}

/** x ∈ (a, b) on the modular ring. */
function inOpenOpen(x: number, a: number, b: number): boolean {
  if (a === b) return x !== a;
  return a < b ? x > a && x < b : x > a || x < b;
}

export interface FindResult {
  providers: Hex[];
  hops: number;
}

export class ChordDht {
  private nodes: RingNode[] = [];
  private built = false;
  private readonly providers = new Map<Cid, Set<Hex>>();
  private readonly nodeIndex = new Map<Hex, Set<Cid>>();

  constructor(private readonly k = 8) {}

  addNode(id: Hex): void {
    if (this.built) throw new Error('cannot add nodes after build()');
    this.nodes.push({ id, key: ringKey(id), index: -1, fingers: [] });
  }

  /** Sort the ring and precompute finger tables. Call once after adding nodes. */
  build(): void {
    this.nodes.sort((a, b) => a.key - b.key);
    this.nodes.forEach((n, i) => (n.index = i));
    for (const n of this.nodes) {
      n.fingers = [];
      for (let i = 0; i < RING_BITS; i++) {
        n.fingers.push(this.successorIndex((n.key + 2 ** i) >>> 0));
      }
      this.nodeIndex.set(n.id, new Set());
    }
    this.built = true;
  }

  get size(): number {
    return this.nodes.length;
  }

  nodeIds(): Hex[] {
    return this.nodes.map((n) => n.id);
  }

  private successorIndex(target: number): number {
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.nodes[mid]!.key >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo % this.nodes.length;
  }

  private successorOf(n: RingNode): RingNode {
    return this.nodes[(n.index + 1) % this.nodes.length]!;
  }

  private closestPreceding(n: RingNode, target: number): RingNode {
    for (let i = RING_BITS - 1; i >= 0; i--) {
      const f = this.nodes[n.fingers[i]!]!;
      if (inOpenOpen(f.key, n.key, target)) return f;
    }
    return n;
  }

  private findSuccessor(start: RingNode, target: number): { node: RingNode; hops: number } {
    let n = start;
    let hops = 0;
    let guard = 0;
    while (!inOpenClosed(target, n.key, this.successorOf(n).key)) {
      const c = this.closestPreceding(n, target);
      if (c.index === n.index) break;
      n = c;
      hops++;
      if (++guard > 2 * this.nodes.length + 2) break;
    }
    return { node: this.successorOf(n), hops };
  }

  /** The k nodes responsible for `key`: successor(key) and the next k-1 clockwise. */
  private responsibleNodes(key: number): RingNode[] {
    const start = this.successorIndex(key);
    const k = Math.min(this.k, this.nodes.length);
    const out: RingNode[] = [];
    for (let i = 0; i < k; i++) out.push(this.nodes[(start + i) % this.nodes.length]!);
    return out;
  }

  /** Announce that `providerId` holds `cid`. The record lands on k responsible nodes. */
  provide(cid: Cid, providerId: Hex): void {
    if (!this.built) throw new Error('call build() first');
    let set = this.providers.get(cid);
    if (!set) this.providers.set(cid, (set = new Set()));
    set.add(providerId);
    for (const n of this.responsibleNodes(ringKey(cid))) this.nodeIndex.get(n.id)!.add(cid);
  }

  /** Discover providers of `cid`, routing from `fromId`. Returns providers + hop count. */
  findProviders(cid: Cid, fromId: Hex): FindResult {
    if (!this.built) throw new Error('call build() first');
    const start = this.nodes.find((n) => n.id === fromId) ?? this.nodes[0]!;
    const { hops } = this.findSuccessor(start, ringKey(cid));
    return { providers: [...(this.providers.get(cid) ?? [])], hops };
  }

  /** Number of provider records a node is responsible for holding. */
  indexSize(nodeId: Hex): number {
    return this.nodeIndex.get(nodeId)?.size ?? 0;
  }
}
