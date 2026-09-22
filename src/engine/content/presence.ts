/**
 * Where a provider can be reached — announced off-chain, never on it.
 *
 * The heartbeat block did three jobs. Two are gone: it stopped metering payment
 * when service moved to reader-signed receipts, and it stopped renewing the
 * lease when liveness moved to observed service. The third is real and still
 * needed — **peers have to learn a provider's smoke address**, because a
 * provider nobody can dial is a provider nobody can read from.
 *
 * That job never needed a block. A block is permanent, replicated to everyone
 * holding the shard, and validated forever; an address is ephemeral, useful
 * only to whoever wants to dial right now, and wrong the moment the provider
 * reconnects. Putting it on the chain cost 2,555 blocks per provider per year
 * — growth driven by the clock rather than by anything a user did — to
 * distribute a string that changes.
 *
 * So presence is a **signed, off-chain beacon**: same information, same
 * message cost, zero chain growth. That is the whole of "un-chain the
 * heartbeat".
 *
 * ## What it is not
 *
 * - **Not evidence of custody.** A beacon says "I am reachable", which is
 *   exactly what a provider holding nothing would also say. Custody is decided
 *   by observed service (`custody-sampling.ts` → `CustodyLiveness`), and
 *   nothing here may feed it.
 * - **Not authoritative about capacity.** `capacityGB` and `storedBytes` ride
 *   along for display and routing hints. They are self-reported, so they must
 *   never meter a payout — the defect this whole redesign removed.
 * - **Not a reason to trust the sender.** Every beacon carries the provider's
 *   own signature over its own fields, rebuilt by the verifier from the record
 *   rather than trusted from the message (SCREENING.md → 3).
 */

/** How a provider says where it is. */
export interface PresenceBeacon {
  /** The provider's account id. Also the signer. */
  pub: string;
  /** Smoke/WebRTC address peers dial to fetch blocks. */
  smokeAddr?: string;
  /** ISO 3166-1 alpha-2, self-reported; feeds geographic diversity in selection. */
  countryCode?: string;
  /** Declared capacity, for display and placement hints only. */
  capacityGB?: number;
  /** Bytes held, self-reported — display only, never a payout input. */
  storedBytes?: number;
  ts: number;
}

/**
 * The exact bytes a provider signs.
 *
 * Rebuilt by the verifier from the fields it will actually read, never taken
 * from the message. A signature over attacker-chosen bytes proves nothing
 * about the fields you then use.
 */
export function presencePayload(b: PresenceBeacon): string {
  return [
    'presence-v1',
    b.pub,
    b.smokeAddr ?? '',
    b.countryCode ?? '',
    String(b.capacityGB ?? 0),
    String(b.storedBytes ?? 0),
    String(b.ts),
  ].join('|');
}

export interface SignedPresence {
  beacon: PresenceBeacon;
  signature: string;
}

/**
 * The freshest beacon per provider.
 *
 * One record per provider, replaced rather than appended — the same shape as
 * everything else in this subsystem, for the same reason. A provider that
 * reconnects a thousand times still occupies one slot.
 */
export class PresenceStore {
  private readonly latest = new Map<string, PresenceBeacon>();

  /**
   * Accept a beacon if it verifies and is newer than what we hold. Returns why
   * not, or null — a silent rejection is indistinguishable from a beacon that
   * never arrived (SCREENING.md → 2).
   */
  record(
    env: SignedPresence,
    verify: (payload: string, signature: string, pub: string) => boolean,
    now: number,
    maxSkewMs: number,
  ): string | null {
    const b = env.beacon;
    if (!b?.pub) return 'presence: missing pub';
    if (!Number.isFinite(b.ts)) return 'presence: missing timestamp';
    // A beacon dated in the future would win every comparison forever, which
    // is a cheap way to pin a stale address in place.
    if (b.ts > now + maxSkewMs) return `presence: timestamp ${b.ts} is too far ahead`;
    if (!verify(presencePayload(b), env.signature, b.pub)) return 'presence: signature does not verify';

    const prev = this.latest.get(b.pub);
    if (prev && prev.ts >= b.ts) return `presence: stale (${b.ts} <= ${prev.ts})`;
    this.latest.set(b.pub, b);
    return null;
  }

  /** The freshest beacon for a provider, if it is still fresh enough to dial. */
  get(pub: string, now: number, maxAgeMs: number): PresenceBeacon | undefined {
    const b = this.latest.get(pub);
    if (!b) return undefined;
    return now - b.ts <= maxAgeMs ? b : undefined;
  }

  /**
   * Drop beacons too old to dial. Keyed by a provider an outsider chooses, so
   * it needs a remover (SCREENING.md → 1).
   */
  sweep(now: number, maxAgeMs: number): number {
    let removed = 0;
    for (const [pub, b] of [...this.latest]) {
      if (now - b.ts > maxAgeMs) { this.latest.delete(pub); removed++; }
    }
    return removed;
  }

  size(): number { return this.latest.size; }
}
