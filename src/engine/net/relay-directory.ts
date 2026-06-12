import { hashHex, utf8ToBytes, type Hex } from '../core/hash.js';

/**
 * Relay federation via Rendezvous (HRW) hashing.
 *
 * Replaces the old env-var relay list and the hard 1024-reservation ceiling. Each
 * peer deterministically maps to its `replication` highest-scoring relays out of
 * the federated set, where score = H(relayId ‖ peerId). Properties:
 *   - DETERMINISTIC + DISCOVERABLE: any node computes a peer's relays from the
 *     (gossiped/DHT-published) relay set — no central coordinator.
 *   - BALANCED: each relay serves ≈ peers · replication / relays.
 *   - MINIMAL RESHUFFLE: adding/removing one relay reassigns only ≈ 1/relays of
 *     peers (consistent-hashing property), so the federation can grow smoothly.
 *   - SCALES BY ADDING RELAYS, not by raising any single relay's cap: to serve P
 *     peers you provision ⌈P · replication / perRelayCap⌉ relays.
 */
export class RelayDirectory {
  private readonly relays = new Set<Hex>();

  add(relayId: Hex): this {
    this.relays.add(relayId);
    return this;
  }

  remove(relayId: Hex): this {
    this.relays.delete(relayId);
    return this;
  }

  size(): number {
    return this.relays.size;
  }

  list(): Hex[] {
    return [...this.relays];
  }

  /** The `replication` relays a peer should reserve on, highest HRW score first. */
  assign(peerId: Hex, replication = 2): Hex[] {
    const scored: { relay: Hex; score: Hex }[] = [];
    for (const relay of this.relays) {
      scored.push({ relay, score: hashHex(utf8ToBytes(`${relay}:${peerId}`)) });
    }
    scored.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : 0));
    return scored.slice(0, Math.min(replication, scored.length)).map((s) => s.relay);
  }

  /** Relays needed to serve `peers` at `replication` given a per-relay capacity. */
  static relaysNeeded(peers: number, replication: number, perRelayCap: number): number {
    return Math.ceil((peers * replication) / perRelayCap);
  }
}
