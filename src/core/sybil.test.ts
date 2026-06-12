import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './keys.js';
import { createAttestation, checkQuorum } from './attestation.js';
import { deriveCommitment, InMemoryIdentityRegistry } from './identity.js';

/**
 * Invariant #6 (adversarial): a single human cannot mint a second account even by
 * finding a fresh set of willing attesters. The nullifier (derived from the human,
 * not the attesters) is the global gate — so more attesters do not help an attacker.
 */
describe('Sybil resistance across attesters', () => {
  it('blocks a second account for the same human despite a different, fully-valid attester set', () => {
    const registry = new InMemoryIdentityRegistry();
    const nullifier = 'human-mallory';

    // Account 1, attested by A + B.
    const acct1 = generateKeyPair();
    const c1 = deriveCommitment(nullifier, acct1.pub);
    const A = generateKeyPair();
    const B = generateKeyPair();
    expect(checkQuorum([createAttestation('personhood', c1, A), createAttestation('stake', c1, B)], c1, { min: 2 }).ok).toBe(true);
    expect(registry.register(nullifier, c1, acct1.pub).ok).toBe(true);

    // Account 2, different key, DIFFERENT attesters C + D — the attestations all verify …
    const acct2 = generateKeyPair();
    const c2 = deriveCommitment(nullifier, acct2.pub);
    const C = generateKeyPair();
    const D = generateKeyPair();
    expect(checkQuorum([createAttestation('personhood', c2, C), createAttestation('stake', c2, D)], c2, { min: 2 }).ok).toBe(true);

    // … but the human's nullifier is already spent, so it is rejected globally.
    const r = registry.register(nullifier, c2, acct2.pub);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/already used/);
  });
});
