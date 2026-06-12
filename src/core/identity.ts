import { hashHex, utf8ToBytes, type Hex } from './hash.js';

/**
 * Global identity dedup — the basis of "one human, one account".
 *
 * Each verified human yields:
 *   - a NULLIFIER: a deterministic, unlinkable tag derived from the human's
 *     unique attestation (e.g. a hash of the biometric/credential). The same
 *     human always produces the same nullifier, so the registry can reject a
 *     second account for an already-seen human — globally, not per-relay.
 *   - a COMMITMENT: binds that human to the specific account public key they are
 *     opening, so an attestation for human X cannot be replayed to open an
 *     account for a different key.
 *
 * This is the schema + an in-memory reference registry. Production replaces the
 * registry with an on-chain, shardable commitment/nullifier set (optionally a
 * zero-knowledge set so the raw biometric never leaves the device); the
 * interface below is what consensus and the open-block validator depend on.
 *
 * SECURITY: in the capped age-weighted-personhood model, consensus security
 * reduces to the integrity of this layer — keep the nullifier derivation and the
 * dedup set adversarially audited (see roadmap "Defense-in-depth", Layer 2:
 * multi-provider attestations).
 */

/** Deterministic per-human tag. Same human → same nullifier (enables dedup). */
export type Nullifier = Hex;
/** Per-account commitment binding a human's nullifier to an account key. */
export type IdentityCommitment = Hex;

/**
 * Derive the commitment that an open block carries. Binds the human's nullifier
 * to the account public key, so attestations are non-transferable across keys.
 */
export function deriveCommitment(nullifier: Nullifier, accountPub: Hex): IdentityCommitment {
  return hashHex(utf8ToBytes(`identity ${nullifier} ${accountPub}`));
}

export interface RegisterResult {
  ok: boolean;
  reason?: string;
}

/** Append-only registry of consumed nullifiers + their commitments. */
export interface IdentityRegistry {
  /** True if this human (nullifier) has already opened an account. */
  has(nullifier: Nullifier): boolean;
  /** Look up the commitment a nullifier was registered with, if any. */
  commitmentOf(nullifier: Nullifier): IdentityCommitment | undefined;
  /**
   * Register a (nullifier, commitment) pair. Fails if the nullifier was already
   * used (the dedup guarantee) or if the commitment does not bind the nullifier
   * to `accountPub`.
   */
  register(nullifier: Nullifier, commitment: IdentityCommitment, accountPub: Hex): RegisterResult;
}

/** In-memory reference implementation. */
export class InMemoryIdentityRegistry implements IdentityRegistry {
  private readonly used = new Map<Nullifier, IdentityCommitment>();

  has(nullifier: Nullifier): boolean {
    return this.used.has(nullifier);
  }

  commitmentOf(nullifier: Nullifier): IdentityCommitment | undefined {
    return this.used.get(nullifier);
  }

  register(nullifier: Nullifier, commitment: IdentityCommitment, accountPub: Hex): RegisterResult {
    if (this.used.has(nullifier)) {
      return { ok: false, reason: 'nullifier already used (one human, one account)' };
    }
    if (deriveCommitment(nullifier, accountPub) !== commitment) {
      return { ok: false, reason: 'commitment does not bind nullifier to account key' };
    }
    this.used.set(nullifier, commitment);
    return { ok: true };
  }
}
