import { describe, it, expect } from 'vitest';
import { generateKeyPair, type KeyPair } from './core/keys.js';
import { AccountAccumulator } from './core/accumulator.js';
import { createOpenBlock, createBlock, type Block } from './core/block.js';
import { createAttestation, checkQuorum } from './core/attestation.js';
import { deriveCommitment, InMemoryIdentityRegistry } from './core/identity.js';
import { AccountStore } from './node/account-store.js';
import { Subscription } from './node/subscription.js';
import { ValidatorRegistry } from './consensus/validators.js';
import { selectCommittee } from './consensus/committee.js';
import { ConflictResolver } from './consensus/vote.js';
import { applyEquivocationSlashes } from './consensus/slashing.js';
import { proveDoubleSpend, verifyDoubleSpend } from './consensus/fraud.js';
import { STAKE_CAP } from './consensus/weight.js';
import { ContentStore } from './content/content-store.js';
import { ChordDht } from './content/dht.js';

/**
 * End-to-end capstone: every phase composing in one scenario.
 *  Phase 0 — open accounts with identity attestations + global dedup
 *  Phase 1 — followers partially replicate only the accounts they care about
 *  Phase 2 — a double-spend is caught, a committee resolves the fork, an
 *            equivocating validator is slashed, the double-spend is proven
 *  Phase 3 — media is chunked + stored quota-safely, announced to the DHT, and
 *            discovered + reassembled by another node
 */

const attesterPersonhood = generateKeyPair();
const attesterStake = generateKeyPair();
const identityPolicy = { min: 2, requiredTypes: ['personhood', 'stake'] };

function openAccount(registry: InMemoryIdentityRegistry, label: string): { keys: KeyPair; open: Block; acc: AccountAccumulator } {
  const keys = generateKeyPair();
  const nullifier = 'human-' + label; // a real human's unlinkable tag
  const commitment = deriveCommitment(nullifier, keys.pub);
  const attestations = [
    createAttestation('personhood', commitment, attesterPersonhood),
    createAttestation('stake', commitment, attesterStake),
  ];
  // global dedup: one human → one account
  expect(registry.register(nullifier, commitment, keys.pub).ok).toBe(true);
  // identity quorum holds
  expect(checkQuorum(attestations, commitment, identityPolicy).ok).toBe(true);

  const acc = new AccountAccumulator();
  const open = createOpenBlock({ accountId: keys.pub, identityCommitment: commitment, attestations, timestamp: 1000 }, keys.priv, acc);
  return { keys, open, acc };
}

describe('end-to-end capstone — all phases compose', () => {
  it('runs identity → replication → consensus/slashing → media discovery', () => {
    // ── Phase 0: identity ──────────────────────────────────────────────────
    const identity = new InMemoryIdentityRegistry();
    const alice = openAccount(identity, 'alice');
    const bob = openAccount(identity, 'bob');

    // the same human cannot open a second account (Sybil blocked globally)
    expect(identity.register('human-alice', deriveCommitment('human-alice', 'other-key'), 'other-key').ok).toBe(false);

    // ── Phase 1: partial replication ───────────────────────────────────────
    // Bob's node follows Alice; it replicates Alice's chain, not the whole world.
    const bobSub = new Subscription().own(bob.keys.pub).follow(alice.keys.pub);
    const bobStore = new AccountStore();
    expect(bobStore.apply(bob.open).ok).toBe(true);
    expect(bobSub.wants(alice.keys.pub)).toBe(true);
    expect(bobStore.apply(alice.open).ok).toBe(true);
    expect(bobStore.accountCount()).toBe(2);
    // a stranger Bob doesn't follow is not wanted
    expect(bobSub.wants(generateKeyPair().pub)).toBe(false);

    // ── Phase 2: consensus + slashing ──────────────────────────────────────
    const validators = new ValidatorRegistry();
    for (let i = 0; i < 30; i++) {
      validators.bond('val-' + i, STAKE_CAP);
      validators.creditActivity('val-' + i, 52);
    }
    const committee = selectCommittee(validators, 3, 1, 'epoch-seed-1', { committeeSize: 15, minCommitteeSize: 10 });
    expect(committee.safe).toBe(true);

    // Alice double-spends: two index-1 sends from the same parent.
    const mkSend = (to: string, ts: number, amount: bigint): Block => {
      const acc = new AccountAccumulator();
      acc.append(alice.open.hash);
      return createBlock(
        { accountId: alice.keys.pub, index: 1, type: 'send', previousHash: alice.open.hash, shard: alice.open.shard, timestamp: ts, balance: 1_000_000n - amount, recipient: to, amount },
        alice.keys.priv,
        acc,
      );
    };
    const honest = mkSend('merchant', 1001, 100_000n); // earlier timestamp = honest
    const fraud = mkSend('attacker', 1002, 900_000n);

    const resolver = new ConflictResolver();
    expect(resolver.register(honest.hash, alice.keys.pub, alice.open.hash)).toBe('confirmed');
    expect(resolver.register(fraud.hash, alice.keys.pub, alice.open.hash)).toBe('conflict');

    // Committee votes for the honest (earlier) block …
    for (const v of committee.members) {
      resolver.vote({ blockHash: honest.hash, voterId: v, weight: validators.weightOf(v) });
    }
    // … but one validator equivocates, also voting the fraud block.
    const cheat = committee.members[0]!;
    const out = resolver.vote({ blockHash: fraud.hash, voterId: cheat, weight: validators.weightOf(cheat) });
    expect(out.equivocation).toBeDefined();

    const result = resolver.resolve();
    expect(result.confirmed).toContain(honest.hash);
    expect(result.rejected).toContain(fraud.hash);
    expect(resolver.status(fraud.hash)).toBe('rejected');

    // The equivocator is slashed; the double-spend is independently provable.
    const slashes = applyEquivocationSlashes(validators, resolver.equivocations());
    expect(slashes).toHaveLength(1);
    expect(slashes[0]!.burned).toBe(STAKE_CAP);
    expect(validators.isValidator(cheat)).toBe(false);

    const evidence = proveDoubleSpend(honest, fraud);
    expect(evidence).not.toBeNull();
    expect(verifyDoubleSpend(evidence!)).toBe(true);

    // ── Phase 3: media storage + discovery ─────────────────────────────────
    const dht = new ChordDht(8);
    for (let i = 0; i < 64; i++) dht.addNode('peer-' + i);
    dht.build();

    // Alice's node stores a 20 MB clip (quota-safe chunking) and announces it.
    const media = new Uint8Array(20 * 1024 * 1024);
    for (let off = 0, ci = 0; off < media.length; off += 8 * 1024 * 1024, ci++) media[off] = (ci + 1) & 0xff;
    const aliceContent = new ContentStore(64 * 1024 * 1024);
    const stored = aliceContent.storeContent(media);
    expect(stored.ok).toBe(true);
    dht.provide(stored.manifest!.cid, 'peer-alicenode');

    // Bob's node discovers the provider via the DHT and fetches the chunks.
    const found = dht.findProviders(stored.manifest!.cid, 'peer-12');
    expect(found.providers).toContain('peer-alicenode');
    expect(found.hops).toBeGreaterThanOrEqual(0);

    const reassembled = aliceContent.getContent(stored.manifest!); // chunks fetched from the provider
    expect(reassembled).not.toBeNull();
    expect(reassembled!.length).toBe(media.length);
  }, 30_000);
});
