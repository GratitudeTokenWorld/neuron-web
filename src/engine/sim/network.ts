import type { Block } from '../core/block.js';
import { canonicalJson, utf8ToBytes, type Hex } from '../core/hash.js';
import { AccountStore } from '../node/account-store.js';
import { Subscription } from '../node/subscription.js';

/**
 * In-memory simulation substrate for validating the scale invariant.
 *
 * This is NOT production networking (that's libp2p gossipsub + DHT). It models
 * the one property that matters for scaling: INTEREST-BASED routing — a block is
 * delivered only to nodes that `want` its account (i.e. follow it or hold its
 * shard), the way per-account/per-follow gossip topics would. It records what
 * each node receives and stores so a harness can assert per-node cost is
 * O(own + followed), not O(network).
 */

/** Approximate on-wire size of a block (bytes of its canonical encoding). */
export function blockSizeBytes(block: Block): number {
  return utf8ToBytes(canonicalJson(block)).length;
}

export interface NodeMetrics {
  /** Messages delivered to this node (interest-filtered). */
  received: number;
  /** Bytes delivered to this node. */
  bytesReceived: number;
  /** Blocks successfully applied to local state. */
  applied: number;
}

export class SimNode {
  readonly store: AccountStore;
  readonly metrics: NodeMetrics = { received: 0, bytesReceived: 0, applied: 0 };

  /** @param verifySignatures sim blocks are honestly generated, so signature
   *  re-verification (the dominant cost when one block is routed to many nodes) is
   *  off by default; all structural validation still runs. Set true to benchmark
   *  realistic per-node CPU. */
  constructor(readonly sub: Subscription, verifySignatures = false) {
    this.store = new AccountStore(verifySignatures);
  }

  /** Called by the network when a wanted block is routed to this node. */
  deliver(block: Block, bytes: number): void {
    this.metrics.received++;
    this.metrics.bytesReceived += bytes;
    if (this.store.apply(block).ok) this.metrics.applied++;
  }

  /** Memory footprint proxy: blocks held in local state. */
  stored(): number {
    return this.store.blockCount();
  }
}

export class SimNetwork {
  /** accountId → nodes that want it via own/followed (exact interest index). */
  private readonly interest = new Map<Hex, SimNode[]>();
  /** Nodes carrying shard subscriptions, checked per publish (super-nodes). */
  private readonly shardNodes: SimNode[] = [];
  private readonly all: SimNode[] = [];

  register(node: SimNode): void {
    this.all.push(node);
    for (const id of [...node.sub.ownAccounts, ...node.sub.followed]) {
      let list = this.interest.get(id);
      if (!list) this.interest.set(id, (list = []));
      list.push(node);
    }
    if (node.sub.shards.size > 0) this.shardNodes.push(node);
  }

  get nodes(): readonly SimNode[] {
    return this.all;
  }

  /** Route a block to exactly the nodes interested in its account. Returns bytes sent per recipient. */
  publish(block: Block): number {
    const bytes = blockSizeBytes(block);
    const direct = this.interest.get(block.accountId);
    if (direct) for (const n of direct) n.deliver(block, bytes);
    for (const n of this.shardNodes) {
      if (direct && direct.includes(n)) continue; // already delivered via interest index
      if (n.sub.wants(block.accountId)) n.deliver(block, bytes);
    }
    return bytes;
  }
}
