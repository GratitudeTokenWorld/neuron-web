import type { Cid } from './cid.js';
import type { Hex } from '../core/hash.js';

/**
 * Replication, repair, and garbage collection for stored content.
 *
 * Tracks which providers hold each CID, detects under-replication when providers
 * churn, repairs back to the redundancy target from available candidates, and
 * garbage-collects content that is unpinned and past its TTL — so per-node storage
 * stays bounded. (Models the durability machinery that real spot-checks / receipts
 * drive; the policy here is the part worth specifying and testing.)
 */
export class ReplicationManager {
  private readonly providers = new Map<Cid, Set<Hex>>();
  private readonly pins = new Map<Cid, number>();
  private readonly ttl = new Map<Cid, number>();

  constructor(private readonly redundancy = 3) {}

  /** Record that `provider` holds `cid`. */
  announce(cid: Cid, provider: Hex): void {
    let set = this.providers.get(cid);
    if (!set) this.providers.set(cid, (set = new Set()));
    set.add(provider);
  }

  providersFor(cid: Cid): Hex[] {
    return [...(this.providers.get(cid) ?? [])];
  }

  replicationOf(cid: Cid): number {
    return this.providers.get(cid)?.size ?? 0;
  }

  underReplicated(cid: Cid): boolean {
    return this.replicationOf(cid) < this.redundancy;
  }

  /** Provider churn: drop a provider from every CID it held. Returns CIDs now under-replicated. */
  removeProvider(provider: Hex): Cid[] {
    const affected: Cid[] = [];
    for (const [cid, set] of this.providers) {
      if (set.delete(provider) && set.size < this.redundancy) affected.push(cid);
    }
    return affected;
  }

  /** Repair `cid` up to the redundancy target using fresh candidates. Returns those added. */
  repair(cid: Cid, candidates: readonly Hex[]): Hex[] {
    let set = this.providers.get(cid);
    if (!set) this.providers.set(cid, (set = new Set()));
    const added: Hex[] = [];
    for (const c of candidates) {
      if (set.size >= this.redundancy) break;
      if (!set.has(c)) {
        set.add(c);
        added.push(c);
      }
    }
    return added;
  }

  /** Pin content (refcount) and optionally set a TTL deadline. */
  pin(cid: Cid, ttlDeadline?: number): void {
    this.pins.set(cid, (this.pins.get(cid) ?? 0) + 1);
    if (ttlDeadline !== undefined) this.ttl.set(cid, ttlDeadline);
  }

  unpin(cid: Cid): void {
    const n = (this.pins.get(cid) ?? 0) - 1;
    if (n <= 0) this.pins.delete(cid);
    else this.pins.set(cid, n);
  }

  pinCount(cid: Cid): number {
    return this.pins.get(cid) ?? 0;
  }

  /**
   * Collect content that is unpinned AND past its TTL (TTL-less content is kept
   * until explicitly unpinned-and-expired by policy). Returns the collected CIDs;
   * they are dropped from all tracking.
   */
  collectGarbage(now: number): Cid[] {
    const collected: Cid[] = [];
    for (const cid of this.providers.keys()) {
      const pinned = (this.pins.get(cid) ?? 0) > 0;
      const deadline = this.ttl.get(cid);
      const expired = deadline !== undefined && deadline <= now;
      if (!pinned && expired) collected.push(cid);
    }
    for (const cid of collected) {
      this.providers.delete(cid);
      this.pins.delete(cid);
      this.ttl.delete(cid);
    }
    return collected;
  }
}
