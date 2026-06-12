/**
 * neuron-web — scalable account-chain core (Phase 0 foundations).
 *
 * Phase 0 establishes the primitives every later phase builds on:
 *   - content hashing + P-256 keys
 *   - data partitioning (shards)
 *   - per-account Merkle accumulator (light-verifiable history)
 *   - typed pluggable attestations + k-of-N quorum
 *   - global identity dedup (one human, one account)
 *   - the account-chain block model
 *   - light-client head verification from a proof alone
 */
export * from './core/hash.js';
export * from './core/keys.js';
export * from './core/partition.js';
export * from './core/accumulator.js';
export * from './core/attestation.js';
export * from './core/identity.js';
export * from './core/block.js';
export * from './core/light-verify.js';

// Phase 1 — partial replication
export * from './node/account-store.js';
export * from './node/subscription.js';
export * from './node/delta-sync.js';
export * from './node/archive.js';
export * from './node/archiving-store.js';
export * from './node/snapshot.js';

// Phase 2 — consensus
export * from './consensus/weight.js';
export * from './consensus/validators.js';
export * from './consensus/committee.js';
export * from './consensus/vote.js';
export * from './consensus/slashing.js';
export * from './consensus/fraud.js';
export * from './consensus/rate-limit.js';

// Phase 3 — content & discovery
export * from './content/cid.js';
export * from './content/chunking.js';
export * from './content/content-store.js';
export * from './content/dht.js';
export * from './content/replication.js';

// Phase 4 — economy & relay federation
export * from './economy/rewards.js';
export * from './net/relay-directory.js';
