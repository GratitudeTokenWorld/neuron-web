import { describe, it, expect } from 'vitest';
import { generateKeyPair } from './keys.js';
import { createAttestation, verifyAttestation, checkQuorum } from './attestation.js';

const CLAIM = 'deadbeefdeadbeef';

describe('attestation', () => {
  it('verifies a single attestation and rejects tampering', () => {
    const a = generateKeyPair();
    const att = createAttestation('personhood', CLAIM, a);
    expect(verifyAttestation(att, CLAIM)).toBe(true);
    expect(verifyAttestation(att, 'other-claim')).toBe(false);
    // type is bound into the signature, so swapping it invalidates the attestation
    expect(verifyAttestation({ ...att, type: 'stake' }, CLAIM)).toBe(false);
  });

  it('enforces a minimum count over distinct attesters', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const atts = [createAttestation('personhood', CLAIM, a), createAttestation('personhood', CLAIM, b)];
    expect(checkQuorum(atts, CLAIM, { min: 2 }).ok).toBe(true);
    expect(checkQuorum(atts, CLAIM, { min: 3 }).ok).toBe(false);
  });

  it('does not double-count one attester', () => {
    const a = generateKeyPair();
    const atts = [createAttestation('personhood', CLAIM, a), createAttestation('social', CLAIM, a)];
    expect(checkQuorum(atts, CLAIM, { min: 2 }).validCount).toBe(1);
  });

  it('enforces required types', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const atts = [createAttestation('personhood', CLAIM, a), createAttestation('stake', CLAIM, b)];
    expect(checkQuorum(atts, CLAIM, { min: 2, requiredTypes: ['personhood', 'stake'] }).ok).toBe(true);
    expect(checkQuorum(atts, CLAIM, { min: 2, requiredTypes: ['personhood', 'social'] }).ok).toBe(false);
  });

  it('honours a trusted-attester allowlist', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const atts = [createAttestation('personhood', CLAIM, a), createAttestation('personhood', CLAIM, b)];
    expect(checkQuorum(atts, CLAIM, { min: 1, trustedAttesters: new Set([a.pub]) }).validCount).toBe(1);
    expect(checkQuorum(atts, CLAIM, { min: 2, trustedAttesters: new Set([a.pub]) }).ok).toBe(false);
  });
});
