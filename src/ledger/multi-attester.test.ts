import { describe, it, expect } from 'vitest';

import { EngineLedger } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';

/**
 * Multi-attester quorum at the ledger open path (attester #2).
 *
 * The consensus security keystone (age-weighted personhood) reduces to the
 * integrity of the proof-of-personhood layer, so a single attester is a SPOF. The
 * quorum logic (checkQuorum, k-of-N distinct attesters) is engine-ready; this proves
 * EngineLedger.openAccount actually ENFORCES a 2-of-2 policy end-to-end. The only
 * remaining work is the client collecting attestations from both relays during
 * account creation — that lands with the UI/API refactor (Bucket B).
 */

const relayA = generateKeyPair(); // e.g. neuronweb.org attester key
const relayB = generateKeyPair(); // e.g. akashicrecords.dev attester key

describe('multi-attester quorum (attester #2)', () => {
  it('accepts an open carrying 2 independent personhood attestations under min:2', async () => {
    const ledger = new EngineLedger('testnet', undefined, { min: 2, requiredTypes: ['personhood'] });
    const alice = generateKeyPair();
    const commitment = deriveCommitment('human-alice', alice.pub);

    const open = await ledger.openAccount(alice.pub, alice, {
      nullifier: 'human-alice',
      attestations: [
        createAttestation('personhood', commitment, relayA),
        createAttestation('personhood', commitment, relayB),
      ],
    });
    expect(open.type).toBe('open');
    expect(ledger.getAccountBalance(alice.pub)).toBeGreaterThan(0);
  });

  it('rejects an open with only ONE attestation when 2 are required', async () => {
    const ledger = new EngineLedger('testnet', undefined, { min: 2, requiredTypes: ['personhood'] });
    const bob = generateKeyPair();
    const commitment = deriveCommitment('human-bob', bob.pub);

    await expect(
      ledger.openAccount(bob.pub, bob, {
        nullifier: 'human-bob',
        attestations: [createAttestation('personhood', commitment, relayA)],
      }),
    ).rejects.toThrow(/quorum/i);
  });

  it('does not count the same attester twice toward the quorum', async () => {
    const ledger = new EngineLedger('testnet', undefined, { min: 2, requiredTypes: ['personhood'] });
    const carol = generateKeyPair();
    const commitment = deriveCommitment('human-carol', carol.pub);

    // Two attestations, but both from relayA — only one distinct attester.
    await expect(
      ledger.openAccount(carol.pub, carol, {
        nullifier: 'human-carol',
        attestations: [
          createAttestation('personhood', commitment, relayA),
          createAttestation('personhood', commitment, relayA),
        ],
      }),
    ).rejects.toThrow(/quorum/i);
  });
});
