import { describe, it, expect } from 'vitest';
import {
  SubAccountRegistry, remainingBudget, subAccountName, parseName,
  isValidRootName, isValidLabel, isUnderRoot, MAX_ROOT_LENGTH, MAX_LABEL_LENGTH,
  type Delegation,
} from './sub-accounts.js';

/**
 * The claim under test: sub-accounts give a human many keys without giving them
 * many identities.
 *
 * Disproved by any path where N keys held by one person count as N people —
 * because every Sybil defence in this system (attestation caps, distinct-reader
 * floors, consensus weight) is priced in humans.
 */

const ok = () => true;
const d = (parent: string, child: string, extra: Partial<Delegation> = {}): Delegation => ({
  parent, child, kind: 'device', issuedAt: 1_000, ...extra,
});

describe('one human, many keys', () => {
  it('collapses every device to its owner', () => {
    const r = new SubAccountRegistry();
    expect(r.register(d('alice', 'phone'), ok)).toBeNull();
    expect(r.register(d('alice', 'laptop'), ok)).toBeNull();
    expect(r.rootOf('phone')).toBe('alice');
    expect(r.rootOf('laptop')).toBe('alice');
    // An undelegated key is its own root, so callers cannot forget to collapse.
    expect(r.rootOf('bob')).toBe('bob');
  });

  it('counts HUMANS, not keys — the security-critical function', () => {
    // The attack this stops: one person with three devices satisfying a
    // three-person threshold alone.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    r.register(d('alice', 'laptop'), ok);
    r.register(d('alice', 'sensor'), ok);
    expect(r.distinctHumans(['phone', 'laptop', 'sensor'])).toBe(1);
    expect(r.distinctHumans(['phone', 'laptop', 'sensor', 'bob'])).toBe(2);
  });

  it('spends one allowance across all of a human keys', () => {
    // A device does not have a budget; its human does.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    r.register(d('alice', 'laptop'), ok);
    expect(r.budgetOwner('phone')).toBe(r.budgetOwner('laptop'));
    expect(remainingBudget({ perHumanBudget: 100, spentByRoot: 80 })).toBe(20);
    expect(remainingBudget({ perHumanBudget: 100, spentByRoot: 250 })).toBe(0);
  });

  it('gives a sub-account no consensus weight at all', () => {
    // Consensus weight is age-weighted PERSONHOOD. A device that added weight
    // would let one human buy votes with hardware.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    expect(r.consensusWeightFactor('phone')).toBe(0);
    expect(r.consensusWeightFactor('alice')).toBe(1);
  });
});

describe('depth is exactly one', () => {
  it('refuses a sub-account issuing sub-accounts', () => {
    // A deeper tree is unbounded, unenumerable by the human at its root, and
    // mintable by whoever compromises any device in it.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    expect(r.register(d('phone', 'watch'), ok)).toContain('may not issue sub-accounts');
    expect(r.rootOf('watch')).toBe('watch');
  });

  it('refuses turning an existing parent into somebody child', () => {
    // The same depth rule read from the other end: alice already has children,
    // so making her bob's device would create a two-level tree.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    expect(r.register(d('bob', 'alice'), ok)).toContain('may not become a sub-account');
  });

  it('refuses self-delegation', () => {
    const r = new SubAccountRegistry();
    expect(r.register(d('alice', 'alice'), ok)).toContain('cannot delegate to itself');
  });
});

describe('adversarial cases', () => {
  it('refuses a delegation the parent did not sign', () => {
    // Otherwise anyone adopts anyone, and `distinctHumans` can be driven to 1
    // for a set of genuinely independent people — which would break every
    // quorum that relies on it.
    const r = new SubAccountRegistry();
    expect(r.register(d('alice', 'phone'), () => false)).toContain('not signed');
    expect(r.rootOf('phone')).toBe('phone');
  });

  it('refuses two humans claiming the same key', () => {
    // An ambiguous root is a cap that can be counted twice.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'shared'), ok);
    expect(r.register(d('bob', 'shared'), ok)).toContain('already delegated');
    expect(r.rootOf('shared')).toBe('alice');
  });

  it('cannot inflate distinct humans by hijacking a stranger key', () => {
    // The mirror attack: claiming someone else's key as your device to make
    // two people look like one. Unsigned delegations are refused, so it fails.
    const r = new SubAccountRegistry();
    expect(r.register(d('attacker', 'victim'), () => false)).not.toBeNull();
    expect(r.distinctHumans(['attacker', 'victim'])).toBe(2);
  });

  it('stops counting a revoked device against its former owner', () => {
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    expect(r.distinctHumans(['phone', 'alice'])).toBe(1);
    expect(r.revoke('phone')).toBe(true);
    // Now a separate key again — a sold or lost device must not keep drawing
    // on its old owner, nor keep being collapsed into them.
    expect(r.distinctHumans(['phone', 'alice'])).toBe(2);
    expect(r.rootOf('phone')).toBe('phone');
  });

  it('treats an expired delegation as revoked without needing a sweep', () => {
    // Expiry must bite on READ, not only when a timer happens to run: a
    // delegation that stays effective until a sweep is a window.
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone', { expiresAt: 5_000 }), ok, 1_000);
    expect(r.rootOf('phone', 4_999)).toBe('alice');
    expect(r.rootOf('phone', 5_001)).toBe('phone');
    expect(r.distinctHumans(['phone', 'alice'], 5_001)).toBe(2);
  });

  it('refuses a delegation that is already expired when registered', () => {
    const r = new SubAccountRegistry();
    expect(r.register(d('alice', 'phone', { expiresAt: 500 }), ok, 1_000))
      .toContain('already expired');
  });
});

describe('state is bounded', () => {
  it('sweeps expired delegations', () => {
    const r = new SubAccountRegistry();
    r.register(d('alice', 'a', { expiresAt: 5_000 }), ok, 1_000);
    r.register(d('alice', 'b'), ok, 1_000);
    expect(r.size()).toBe(2);
    expect(r.sweep(6_000)).toBe(1);
    expect(r.size()).toBe(1);
    expect(r.children('alice')).toEqual(['b']);
  });

  it('forgets a parent entirely once its last child goes', () => {
    const r = new SubAccountRegistry();
    r.register(d('alice', 'phone'), ok);
    r.revoke('phone');
    expect(r.children('alice')).toEqual([]);
    expect(r.size()).toBe(0);
  });
});

describe('domain-shaped names (Lucian, 2026-09-22)', () => {
  it('builds lucian.sensor1 from a root and a label', () => {
    expect(subAccountName('lucian', 'sensor1')).toBe('lucian.sensor1');
    expect(parseName('lucian.sensor1')).toEqual({ root: 'lucian', label: 'sensor1' });
    expect(parseName('lucian')).toEqual({ root: 'lucian' });
  });

  it('scopes labels to their parent, so two people can both have a phone', () => {
    // The namespace win: adding a device never competes for a global name.
    expect(subAccountName('lucian', 'phone')).toBe('lucian.phone');
    expect(subAccountName('maria', 'phone')).toBe('maria.phone');
  });

  it('FORBIDS a dot in a root username — the impersonation rule', () => {
    // Without this, someone registers the top-level name `lucian.support` and
    // is indistinguishable from Lucian's sub-account. No forgery needed; the
    // namespaces would simply overlap.
    expect(isValidRootName('lucian.support')).toBe(false);
    expect(subAccountName('lucian.support', 'x')).toBeNull();
    expect(isValidRootName('lucian')).toBe(true);
  });

  it('rejects anything that is not lowercase ASCII, digits or hyphen', () => {
    // Unicode would let a Cyrillic homograph sit beside the real name and read
    // identically, defeating every visual check a human can make. Case is
    // excluded so `Lucian` and `lucian` cannot be two accounts.
    expect(isValidRootName('luci\u0430n')).toBe(false); // Cyrillic a
    expect(isValidRootName('Lucian')).toBe(false);
    expect(isValidRootName('luci an')).toBe(false);
    expect(isValidLabel('sensor_1')).toBe(false);
    expect(isValidLabel('sensor-1')).toBe(true);
  });

  it('refuses malformed names rather than salvaging them', () => {
    // A parser that repairs input is how `lucian..support` resolves to
    // something nobody intended.
    expect(parseName('lucian..support')).toBeNull();
    expect(parseName('lucian.')).toBeNull();
    expect(parseName('.support')).toBeNull();
    expect(parseName('a.b.c')).toBeNull();
    expect(parseName('')).toBeNull();
    expect(parseName('-lucian')).toBeNull();
    expect(parseName('lucian-')).toBeNull();
  });

  it('enforces exactly two levels, matching the delegation depth rule', () => {
    // The namespace and the delegation graph must agree, or one permits what
    // the other forbids.
    expect(parseName('lucian.phone.watch')).toBeNull();
    expect(subAccountName('lucian.phone', 'watch')).toBeNull();
  });

  it('identifies which names belong to a given human', () => {
    expect(isUnderRoot('lucian.sensor1', 'lucian')).toBe(true);
    expect(isUnderRoot('maria.sensor1', 'lucian')).toBe(false);
    // A root name is not under itself: it IS the human, not a device.
    expect(isUnderRoot('lucian', 'lucian')).toBe(false);
  });

  it('bounds name length', () => {
    expect(isValidRootName('a'.repeat(MAX_ROOT_LENGTH))).toBe(true);
    expect(isValidRootName('a'.repeat(MAX_ROOT_LENGTH + 1))).toBe(false);
    expect(isValidLabel('a'.repeat(MAX_LABEL_LENGTH + 1))).toBe(false);
  });
});
