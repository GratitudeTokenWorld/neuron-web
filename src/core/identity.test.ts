import { describe, it, expect } from 'vitest';
import { InMemoryIdentityRegistry, deriveCommitment } from './identity.js';

describe('identity registry (one human, one account)', () => {
  it('registers a fresh nullifier and rejects a second use', () => {
    const reg = new InMemoryIdentityRegistry();
    const nullifier = 'aa11bb22';
    const accountPub = 'cc33dd44';
    const commitment = deriveCommitment(nullifier, accountPub);

    expect(reg.register(nullifier, commitment, accountPub).ok).toBe(true);
    expect(reg.has(nullifier)).toBe(true);
    expect(reg.commitmentOf(nullifier)).toBe(commitment);

    // same human (nullifier) cannot open a second account
    const second = reg.register(nullifier, deriveCommitment(nullifier, 'ee55'), 'ee55');
    expect(second.ok).toBe(false);
  });

  it('rejects a commitment that does not bind the nullifier to the account', () => {
    const reg = new InMemoryIdentityRegistry();
    const nullifier = 'aa11bb22';
    const wrongCommitment = deriveCommitment(nullifier, 'someone-else');
    expect(reg.register(nullifier, wrongCommitment, 'cc33dd44').ok).toBe(false);
  });
});
