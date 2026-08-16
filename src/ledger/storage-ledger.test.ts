import { describe, it, expect, vi, afterEach } from 'vitest';

import { EngineLedger, type SignerKeys } from './engine-ledger.js';
import { generateKeyPair } from '../engine/core/keys.js';
import { createAttestation } from '../engine/core/attestation.js';
import { deriveCommitment } from '../engine/core/identity.js';
import { createBlock, type Block, type StoragePayload } from '../engine/core/block.js';
import { AccountAccumulator } from '../engine/core/accumulator.js';
import {
  REWARD_EPOCH_MS, HEARTBEAT_INTERVAL_MS, MAX_HEARTBEATS_PER_EPOCH,
  BASE_STORAGE_RATE_MILLI, MAX_OFFLINE_MS, GB_BYTES,
} from '../engine/content/provider-ledger.js';

/**
 * The storage economy on the engine (Phase 3 parity): register / deregister /
 * heartbeat / reward as signed account-chain blocks.
 *
 * Two things are load-bearing here and neither is covered by the layers above:
 *
 *   1. **The reward block mints.** Hash, signature, index linkage and accumulator
 *      root all pass for a self-signed block, and the chain stays single and
 *      valid — so fraud proofs and committees never look at it. The only thing
 *      between a provider and infinite UNIT is the arithmetic in `addBlock` plus
 *      the on-chain evidence ceiling. Tested adversarially below.
 *   2. **The heartbeat is the custody lease renewal.** Content survives because
 *      repair outruns churn, and "is this holder still live?" is answered by the
 *      lease, not by whether it once registered.
 */

const attester = generateKeyPair();
const MINT = 1_000_000_000n;

async function openAcct(ledger: EngineLedger, keys: SignerKeys, nullifier: string): Promise<Block> {
  const commitment = deriveCommitment(nullifier, keys.pub);
  return ledger.openAccount(keys.pub, keys, {
    nullifier,
    attestations: [createAttestation('personhood', commitment, attester)],
  });
}

/**
 * Builds a provider's chain block by block with full control of timestamps — the
 * view a PEER has: it never calls `create*`, it only validates what arrives. This
 * is where the security rules actually have to hold.
 */
class Chain {
  /** Committed leaf hashes. A rejected block must not advance the accumulator, and
   *  `createBlock` appends to whatever it is handed — so each candidate gets a
   *  throwaway accumulator rebuilt from what has actually been committed. */
  private readonly committed: string[] = [];
  private head: Block;
  constructor(private readonly keys: SignerKeys, open: Block) {
    this.committed.push(open.hash);
    this.head = open;
  }
  /** Sign the next block without applying it anywhere. `patch` can forge anything. */
  next(type: Block['type'], timestamp: number, storage: StoragePayload, patch: Partial<Block> = {}): Block {
    const acc = new AccountAccumulator();
    for (const h of this.committed) acc.append(h);
    return createBlock(
      {
        accountId: this.keys.pub, index: this.head.index + 1, type,
        previousHash: this.head.hash, shard: this.head.shard,
        timestamp, balance: this.head.balance, storage, ...patch,
      } as Block,
      this.keys.priv,
      acc,
    );
  }
  /** Commit a block the builder produced, so later blocks chain off it. */
  commit(block: Block): Block {
    this.committed.push(block.hash);
    this.head = block;
    return block;
  }
  /** next() + commit() + hand it to the ledger, asserting nothing. */
  push(ledger: EngineLedger, type: Block['type'], timestamp: number, storage: StoragePayload, patch: Partial<Block> = {}) {
    const block = this.next(type, timestamp, storage, patch);
    const result = ledger.addBlock(block);
    if (result.success) this.commit(block);
    return { block, result };
  }
  get balance(): bigint { return this.head.balance; }
}

/** Three whole days in the past, so every crafted timestamp is historical. */
const TODAY = Math.floor(Date.now() / REWARD_EPOCH_MS);
const DAY0 = (TODAY - 3) * REWARD_EPOCH_MS;
const DAY1 = (TODAY - 2) * REWARD_EPOCH_MS;

async function provider(capacityGB = 10) {
  const ledger = new EngineLedger('testnet');
  const keys = generateKeyPair();
  const open = await openAcct(ledger, keys, 'human-provider');
  const chain = new Chain(keys, open);
  chain.push(ledger, 'storage-register', DAY0, { capacityGB, deviceId: 'dev-1' });
  return { ledger, keys, chain };
}

/** A full day of heartbeats on epoch `TODAY - 2`, each reporting `storedGB` held. */
function fullDayOfHeartbeats(ledger: EngineLedger, chain: Chain, storedGB: number): void {
  for (let i = 0; i < MAX_HEARTBEATS_PER_EPOCH; i++) {
    const { result } = chain.push(
      ledger, 'storage-heartbeat', DAY1 + i * HEARTBEAT_INTERVAL_MS,
      { storedBytes: storedGB * GB_BYTES, smokeAddr: 'p1.example' },
    );
    expect(result.success).toBe(true);
  }
}

afterEach(() => { vi.useRealTimers(); });

describe('storage blocks on the engine', () => {
  it('registers a provider with its declared capacity, without moving the balance', async () => {
    const { ledger, keys } = await provider(25);
    const p = ledger.storageProviders.get(keys.pub)!;
    expect(p.capacityGB).toBe(25);
    expect(p.deviceId).toBe('dev-1');
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT));
    expect(ledger.getStorageProviders().map(x => x.pub)).toEqual([keys.pub]);
  });

  it('renews the lease on a heartbeat and reports address, geo and bytes held', async () => {
    const { ledger, keys, chain } = await provider();
    chain.push(ledger, 'storage-heartbeat', DAY1, {
      smokeAddr: 'p1.example', storedBytes: 3 * GB_BYTES, countryCode: 'DE',
    });
    const p = ledger.storageProviders.get(keys.pub)!;
    expect(p.smokeAddr).toBe('p1.example');
    expect(p.countryCode).toBe('DE');
    expect(p.lastActualStoredBytes).toBe(3 * GB_BYTES);
    expect(ledger.isProviderLive(keys.pub, DAY1 + MAX_OFFLINE_MS - 1)).toBe(true);
    expect(ledger.isProviderLive(keys.pub, DAY1 + MAX_OFFLINE_MS)).toBe(false);
  });

  it('drops the provider on deregister', async () => {
    const { ledger, keys, chain } = await provider();
    const { result } = chain.push(ledger, 'storage-deregister', DAY1, {});
    expect(result.success).toBe(true);
    expect(ledger.storageProviders.has(keys.pub)).toBe(false);
    expect(ledger.getStorageProviders()).toHaveLength(0);
    // A second deregister has nothing to release.
    expect(chain.push(ledger, 'storage-deregister', DAY1 + 1, {}).result.error).toMatch(/not a registered/);
  });

  it('rejects storage blocks from an account that never registered', async () => {
    const ledger = new EngineLedger('testnet');
    const keys = generateKeyPair();
    const open = await openAcct(ledger, keys, 'human-x');
    const chain = new Chain(keys, open);
    expect(chain.push(ledger, 'storage-heartbeat', DAY0, {}).result.error).toMatch(/not a registered/);
    expect(chain.push(ledger, 'storage-register', DAY0, { capacityGB: 0 }).result.error).toMatch(/positive/);
  });
});

describe('reward minting — the adversarial surface', () => {
  it('mints exactly what the on-chain evidence supports', async () => {
    const { ledger, keys, chain } = await provider(10);
    fullDayOfHeartbeats(ledger, chain, 4);
    const expected = BASE_STORAGE_RATE_MILLI * 4;   // 4GB held × full uptime

    const { result } = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS,
      { epochDay: TODAY - 2, storedGB: 4, heartbeatCount: MAX_HEARTBEATS_PER_EPOCH },
      { amount: BigInt(expected), balance: MINT + BigInt(expected) },
    );
    expect(result.success).toBe(true);
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT) + expected);
    expect(ledger.storageProviders.get(keys.pub)!.totalEarned).toBe(expected);
  });

  it('rejects a reward that claims more than the evidence allows', async () => {
    const { ledger, keys, chain } = await provider(10);
    fullDayOfHeartbeats(ledger, chain, 4);
    const inflated = BigInt(BASE_STORAGE_RATE_MILLI * 4 * 1000);

    // Internally consistent: the balance delta EQUALS the amount, so the
    // conservation check passes. Only the evidence ceiling stops it.
    const { result } = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS,
      { epochDay: TODAY - 2, storedGB: 4 },
      { amount: inflated, balance: MINT + inflated },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds maximum/);
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT));
  });

  it('rejects a reward whose balance delta does not equal its amount', async () => {
    const { ledger, keys, chain } = await provider(10);
    fullDayOfHeartbeats(ledger, chain, 4);
    const legit = BigInt(BASE_STORAGE_RATE_MILLI * 4);

    // The classic self-mint: claim a modest, defensible amount while writing a
    // balance a million times larger. The evidence ceiling would pass this.
    const { result } = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS,
      { epochDay: TODAY - 2, storedGB: 4 },
      { amount: legit, balance: MINT + legit * 1_000_000n },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('storage-reward balance inconsistent');
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT));
  });

  it('rejects a reward for an epoch with no heartbeats at all', async () => {
    const { ledger, chain } = await provider(10);
    // Capacity was declared on day -3, so day -2 prices fine — but the provider
    // never proved it was there for it.
    const { result } = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS, { epochDay: TODAY - 2 },
      { amount: 1_000n, balance: MINT + 1_000n },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no heartbeats/);
  });

  it('rejects a reward for the day the provider registered — no capacity at epoch start', async () => {
    const { ledger, chain } = await provider(10);
    chain.push(ledger, 'storage-heartbeat', DAY0 + HEARTBEAT_INTERVAL_MS, { storedBytes: GB_BYTES });
    const { result } = chain.push(
      ledger, 'storage-reward', DAY1, { epochDay: TODAY - 3 },
      { amount: 1_000n, balance: MINT + 1_000n },
    );
    expect(result.error).toMatch(/not registered at epoch start/);
  });

  it('rejects a second reward for the same epoch', async () => {
    const { ledger, chain } = await provider(10);
    fullDayOfHeartbeats(ledger, chain, 4);
    const amount = BigInt(BASE_STORAGE_RATE_MILLI * 4);
    const claim = (ts: number) => chain.push(
      ledger, 'storage-reward', ts, { epochDay: TODAY - 2, storedGB: 4 },
      { amount, balance: chain.balance + amount },
    );
    expect(claim(DAY1 + REWARD_EPOCH_MS).result.success).toBe(true);
    expect(claim(DAY1 + REWARD_EPOCH_MS + 1).result.error).toMatch(/already rewarded/);
  });

  it('rejects a reward that bills any day but the one before its own block', async () => {
    const { ledger, keys, chain } = await provider(10);
    fullDayOfHeartbeats(ledger, chain, 4);
    const amount = BigInt(BASE_STORAGE_RATE_MILLI * 4);
    // Dated day -1, so it may bill day -2 and nothing else. Billing the running
    // day is refused even though the provider genuinely has evidence for it.
    const { result } = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS, { epochDay: TODAY - 1, storedGB: 4 },
      { amount, balance: MINT + amount },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/may only claim epoch/);
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT));
  });

  it('rejects a balance change on register, deregister or heartbeat', async () => {
    const { ledger, chain } = await provider(10);
    for (const type of ['storage-register', 'storage-heartbeat', 'storage-deregister'] as const) {
      const { result } = chain.push(ledger, type, DAY1, { capacityGB: 10 }, { balance: MINT + 1n });
      expect(result.success).toBe(false);
      expect(result.error).toBe(`${type} must preserve balance`);
    }
  });
});

describe('an early heartbeat must not truncate the chain', () => {
  it('accepts it, does not count it, and keeps accepting later blocks', async () => {
    const { ledger, keys, chain } = await provider(10);
    chain.push(ledger, 'storage-heartbeat', DAY1, { storedBytes: GB_BYTES });

    // A provider spamming heartbeats a minute apart: every one is a valid,
    // signed, correctly-linked block. Rejecting them would strand the rest of
    // the chain as non-sequential — the failure that once made NFTs vanish on
    // reload. So they apply, and earn nothing.
    for (let i = 1; i <= 10; i++) {
      const { result } = chain.push(ledger, 'storage-heartbeat', DAY1 + i * 60_000, {});
      expect(result.success).toBe(true);
    }
    expect(ledger.countHeartbeatsLast24h(keys.pub, DAY1 + 60_000 * 11)).toBe(1);

    // The chain is intact: the next legitimate block still applies.
    const { result } = chain.push(ledger, 'storage-heartbeat', DAY1 + HEARTBEAT_INTERVAL_MS, {});
    expect(result.success).toBe(true);
    expect(ledger.countHeartbeatsLast24h(keys.pub, DAY1 + HEARTBEAT_INTERVAL_MS)).toBe(2);

    // And the spam bought nothing: a reward still prices at 2/6 uptime.
    const amount = BigInt(Math.floor(BASE_STORAGE_RATE_MILLI * 1 * (2 / MAX_HEARTBEATS_PER_EPOCH)));
    const claim = chain.push(
      ledger, 'storage-reward', DAY1 + REWARD_EPOCH_MS, { epochDay: TODAY - 2, storedGB: 1 },
      { amount, balance: chain.balance + amount },
    );
    expect(claim.result.success).toBe(true);
    const overclaim = BigInt(BASE_STORAGE_RATE_MILLI);   // what a full day would have paid
    expect(overclaim).toBeGreaterThan(amount);
  });
});

describe('local issuance (the create* path)', () => {
  it('registers, heartbeats once, then refuses a second heartbeat until it is due', async () => {
    const ledger = new EngineLedger('testnet');
    const keys = generateKeyPair();
    await openAcct(ledger, keys, 'human-local');

    const reg = await ledger.createStorageRegister(keys.pub, 50, keys, 'dev-local');
    expect(reg.block?.type).toBe('storage-register');
    expect(ledger.storageProviders.get(keys.pub)!.capacityGB).toBe(50);

    const hb = await ledger.createStorageHeartbeat(keys.pub, keys, 'local.example', 2 * GB_BYTES, 'RO');
    expect(hb.block?.type).toBe('storage-heartbeat');
    expect(ledger.storageProviders.get(keys.pub)!.smokeAddr).toBe('local.example');

    const early = await ledger.createStorageHeartbeat(keys.pub, keys);
    expect(early.block).toBeUndefined();
    expect(early.error).toMatch(/interval not reached/);

    // Registering is not a reward: one heartbeat on the day of registration
    // means no capacity was declared at epoch start.
    const reward = await ledger.createStorageReward(keys.pub, keys);
    expect(reward.error).toMatch(/not registered at epoch start/);

    const dereg = await ledger.createStorageDeregister(keys.pub, keys);
    expect(dereg.block?.type).toBe('storage-deregister');
    expect(ledger.storageProviders.has(keys.pub)).toBe(false);
  });

  it('issues a reward the ledger itself then accepts, over a full simulated day', async () => {
    const ledger = new EngineLedger('testnet');
    const keys = generateKeyPair();
    await openAcct(ledger, keys, 'human-earner');

    vi.useFakeTimers();
    vi.setSystemTime(DAY0);
    await ledger.createStorageRegister(keys.pub, 10, keys, 'dev-earner');

    for (let i = 0; i < MAX_HEARTBEATS_PER_EPOCH; i++) {
      vi.setSystemTime(DAY1 + i * HEARTBEAT_INTERVAL_MS);
      const hb = await ledger.createStorageHeartbeat(keys.pub, keys, 'e.example', 6 * GB_BYTES);
      expect(hb.block).toBeDefined();
    }

    vi.setSystemTime(DAY1 + REWARD_EPOCH_MS);   // next day: yesterday is claimable
    const reward = await ledger.createStorageReward(keys.pub, keys);
    expect(reward.error).toBeUndefined();
    const expected = BASE_STORAGE_RATE_MILLI * 6;
    expect(Number(reward.block!.amount)).toBe(expected);
    expect(ledger.getAccountBalance(keys.pub)).toBe(Number(MINT) + expected);

    // A peer holding the same chain accepts every block and derives the same
    // balance — issuance and validation agree.
    const peer = new EngineLedger('testnet');
    for (const block of ledger.getAccountChain(keys.pub)) {
      expect(peer.addBlock(block).success).toBe(true);
    }
    expect(peer.getAccountBalance(keys.pub)).toBe(Number(MINT) + expected);
    expect(peer.storageProviders.get(keys.pub)!.totalEarned).toBe(expected);

    // Claiming the same day twice is refused locally too.
    const again = await ledger.createStorageReward(keys.pub, keys);
    expect(again.error).toMatch(/already rewarded/);
  });
});

describe('publish feasibility follows the lease, not the declaration', () => {
  it('counts only providers whose lease is live and who have the space', async () => {
    const { ledger, chain } = await provider(10);
    // Register a second provider on the same ledger so `minCopies` is reachable.
    const ledger2Keys = generateKeyPair();
    const open2 = await openAcct(ledger, ledger2Keys, 'human-provider-2');
    const chain2 = new Chain(ledger2Keys, open2);
    chain2.push(ledger, 'storage-register', DAY0, { capacityGB: 10, deviceId: 'dev-2' });

    vi.useFakeTimers();
    // Both just registered: leases run from registration, so both are live.
    vi.setSystemTime(DAY0 + 1_000);
    expect(ledger.checkPublishFeasibility(GB_BYTES, 2).feasible).toBe(true);

    // Only one keeps renewing. The other's lease lapses and it stops counting —
    // its 10GB declaration is still on-chain and still worthless for custody.
    // (The clock moves first: a heartbeat dated in the future is refused.)
    vi.setSystemTime(DAY0 + HEARTBEAT_INTERVAL_MS);
    const renew = chain.push(ledger, 'storage-heartbeat', DAY0 + HEARTBEAT_INTERVAL_MS, { storedBytes: 0 });
    expect(renew.result.success).toBe(true);
    vi.setSystemTime(DAY0 + MAX_OFFLINE_MS + 1);
    const verdict = ledger.checkPublishFeasibility(GB_BYTES, 2);
    expect(verdict.feasible).toBe(false);
    expect(verdict.activeProviders).toBe(1);
    expect(verdict.providersWithCapacity).toBe(1);
    expect(verdict.warning).toMatch(/1 live provider/);
    expect(ledger.checkPublishFeasibility(GB_BYTES, 1).feasible).toBe(true);

    // A file larger than anyone's free space is infeasible regardless of leases.
    expect(ledger.checkPublishFeasibility(500 * GB_BYTES, 1).feasible).toBe(false);
  });
});
