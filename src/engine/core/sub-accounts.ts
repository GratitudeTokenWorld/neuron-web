/**
 * Sub-accounts and domain accounts — many keys, one human.
 *
 * Lucian's planned feature for Web3 IoT: a person runs a phone, a laptop, a
 * fleet of sensors, and a domain-scoped identity, each needing its own signing
 * key because they are physically separate and one cannot hold another's
 * secret.
 *
 * The danger is precise and was found while screening the payment design
 * (CUSTODY-PROOFS.md → B6): **every Sybil defence in this system is priced in
 * humans.** The per-reader attestation cap, the distinct-reader floor, and
 * consensus weight all assume one key ≈ one person. Sub-accounts break that
 * assumption by construction, so unless they are collapsed to their human
 * everywhere it matters, this feature silently converts a
 * one-human-one-account network into one where identity is free.
 *
 * Hence the two rules this module exists to enforce:
 *
 * 1. **`rootOf` collapses a key to its human**, and every cap, floor or weight
 *    is counted against that root — never against the key that signed.
 * 2. **Depth is exactly one.** A sub-account may not issue sub-accounts.
 *    Without that, a compromised device mints an unbounded tree its owner never
 *    authorised, and the parent cannot even enumerate what exists in its name.
 *
 * What sub-accounts legitimately get: their own keys, their own storage
 * custody, their own reputation for routing, and their own device calibration.
 * What they never get: their own personhood, their own attestation budget, or a
 * vote.
 */

export type SubAccountKind = 'device' | 'domain';

export interface Delegation {
  /** The human's root account. */
  parent: string;
  /** The delegated key. */
  child: string;
  kind: SubAccountKind;
  issuedAt: number;
  /** Optional expiry. A delegation with none lives until revoked. */
  expiresAt?: number;
}

/** Verifies that `parent` really signed this delegation. */
export type DelegationVerifier = (d: Delegation) => boolean;

/**
 * Registry of delegations, collapsing keys to humans.
 *
 * Bounded by the delegations actually issued, and `revoke` removes them. A
 * parent may hold many children; a child has exactly one parent, which is what
 * makes `rootOf` total and cheap.
 */
export class SubAccountRegistry {
  private readonly parentOf = new Map<string, Delegation>();
  private readonly childrenOf = new Map<string, Set<string>>();

  /**
   * Record a delegation. Returns why it was refused, or null.
   *
   * Every rejection says why — a silent refusal here would look identical to a
   * delegation that never arrived (SCREENING.md → 2).
   */
  register(d: Delegation, verify: DelegationVerifier, now: number = Date.now()): string | null {
    if (d.parent === d.child) return 'a key cannot delegate to itself';
    if (!verify(d)) return 'delegation is not signed by the parent';
    if (d.expiresAt !== undefined && d.expiresAt <= now) return 'delegation is already expired';

    // Depth exactly one: a sub-account may not issue sub-accounts. A deeper
    // tree is unbounded, unenumerable by the human at its root, and mintable by
    // whoever compromises any device in it.
    if (this.parentOf.has(d.parent)) return 'a sub-account may not issue sub-accounts';

    const existing = this.parentOf.get(d.child);
    if (existing && existing.parent !== d.parent) {
      // Two humans claiming one key would make `rootOf` ambiguous, and an
      // ambiguous root is a cap that can be counted twice.
      return 'child is already delegated to a different parent';
    }
    // A key that is itself a parent cannot become somebody's child, for the
    // same depth reason read from the other end.
    if (this.childrenOf.get(d.child)?.size) return 'a parent may not become a sub-account';

    this.parentOf.set(d.child, d);
    let set = this.childrenOf.get(d.parent);
    if (!set) { set = new Set(); this.childrenOf.set(d.parent, set); }
    set.add(d.child);
    return null;
  }

  revoke(child: string): boolean {
    const d = this.parentOf.get(child);
    if (!d) return false;
    this.parentOf.delete(child);
    this.childrenOf.get(d.parent)?.delete(child);
    if (this.childrenOf.get(d.parent)?.size === 0) this.childrenOf.delete(d.parent);
    return true;
  }

  /**
   * The human behind a key. Returns the key itself when it is not delegated,
   * so callers can use it unconditionally and cannot forget the collapse.
   */
  rootOf(id: string, now: number = Date.now()): string {
    const d = this.parentOf.get(id);
    if (!d) return id;
    if (d.expiresAt !== undefined && d.expiresAt <= now) return id;
    return d.parent;
  }

  isSubAccount(id: string, now: number = Date.now()): boolean {
    return this.rootOf(id, now) !== id;
  }

  children(parent: string): string[] {
    return [...(this.childrenOf.get(parent) ?? [])];
  }

  /**
   * How many distinct HUMANS are represented by a set of keys.
   *
   * The security-critical function. The distinct-reader floor, the per-reader
   * attestation cap and any quorum of "independent" parties must call this
   * rather than counting keys, or one person with three devices satisfies a
   * three-person threshold alone.
   */
  distinctHumans(ids: Iterable<string>, now: number = Date.now()): number {
    const roots = new Set<string>();
    for (const id of ids) roots.add(this.rootOf(id, now));
    return roots.size;
  }

  /**
   * Who owns the budget a key spends from.
   *
   * Identical to `rootOf`, named separately because the payment code should
   * read as what it means: a device does not have an allowance, its human does.
   */
  budgetOwner(id: string, now: number = Date.now()): string {
    return this.rootOf(id, now);
  }

  /**
   * Consensus weight contributed by a key.
   *
   * Always 0 for a sub-account. Consensus weight is age-weighted PERSONHOOD, so
   * a device that added weight would let one human buy votes with hardware —
   * the precise failure the nullifier exists to prevent.
   */
  consensusWeightFactor(id: string, now: number = Date.now()): number {
    return this.isSubAccount(id, now) ? 0 : 1;
  }

  /** Delegations held. */
  size(): number {
    return this.parentOf.size;
  }

  /** Drop expired delegations. Returns how many went. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [child, d] of [...this.parentOf]) {
      if (d.expiresAt !== undefined && d.expiresAt <= now) {
        this.revoke(child);
        removed++;
      }
    }
    return removed;
  }
}

/**
 * Split a per-human budget across the keys spending from it.
 *
 * The rule from the payment screen: a sub-account draws on its parent's
 * allowance and never receives its own. Returns what remains for this key after
 * its siblings' spending, never more than the human's total.
 */
export function remainingBudget(args: {
  perHumanBudget: number;
  spentByRoot: number;
}): number {
  return Math.max(0, args.perHumanBudget - args.spentByRoot);
}
