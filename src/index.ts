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
