import { generateKeyPair, type KeyPair } from '../core/keys.js';
import { AccountAccumulator } from '../core/accumulator.js';
import { createOpenBlock, createBlock, MINT_AMOUNT, type Block } from '../core/block.js';
import { createAttestation } from '../core/attestation.js';
import { deriveCommitment } from '../core/identity.js';
import { Subscription } from '../node/subscription.js';
import { SimNode, SimNetwork } from './network.js';

/**
 * Scale-invariant scenario.
 *
 * Builds `totalAccounts` accounts, each also a light-client node that follows a
 * fixed `followPerNode` other accounts. Every account publishes a chain of
 * `blocksPerAccount` blocks through an interest-routed network. We then measure
 * per-node cost and compare it against:
 *   - the theoretical follow bound  (followPerNode + 1) * blocksPerAccount, and
 *   - the broadcast baseline        totalAccounts * blocksPerAccount  (what the
 *     old "every node sees every block" gossip would cost).
 *
 * The point: per-node cost tracks the follow bound (constant in N), while the
 * broadcast baseline grows linearly in N. That is the scale invariant, measured.
 */

export interface ScenarioConfig {
  totalAccounts: number;
  followPerNode: number;
  blocksPerAccount: number;
  numShards?: number;
}

export interface ScenarioStats {
  config: Required<ScenarioConfig>;
  /** Constant follow bound: (followPerNode + 1) * blocksPerAccount. */
  followBound: number;
  /** What broadcast gossip would deliver per node: totalAccounts * blocksPerAccount. */
  broadcastBaseline: number;
  perNode: {
    maxReceived: number;
    avgReceived: number;
    maxStored: number;
    avgStored: number;
    maxBytes: number;
  };
}

interface BuiltAccount {
  keys: KeyPair;
  blocks: Block[];
}

function buildAccountChain(keys: KeyPair, attester: KeyPair, blocksPerAccount: number, numShards: number): Block[] {
  const nullifier = keys.pub.slice(0, 16);
  const commitment = deriveCommitment(nullifier, keys.pub);
  const attestations = [createAttestation('personhood', commitment, attester)];
  const acc = new AccountAccumulator();
  const blocks: Block[] = [];
  const open = createOpenBlock(
    { accountId: keys.pub, identityCommitment: commitment, attestations, timestamp: 1000, numShards },
    keys.priv,
    acc,
  );
  blocks.push(open);
  let balance = MINT_AMOUNT;
  for (let r = 1; r < blocksPerAccount; r++) {
    balance -= 1n;
    blocks.push(
      createBlock(
        {
          accountId: keys.pub,
          index: r,
          type: 'send',
          previousHash: blocks[r - 1]!.hash,
          shard: open.shard,
          timestamp: 1000 + r,
          balance,
          recipient: '00',
          amount: 1n,
        },
        keys.priv,
        acc,
      ),
    );
  }
  return blocks;
}

export function runScenario(config: ScenarioConfig): ScenarioStats {
  const { totalAccounts, followPerNode, blocksPerAccount, numShards = 4096 } = config;
  if (followPerNode >= totalAccounts) {
    throw new RangeError('followPerNode must be < totalAccounts');
  }

  const attester = generateKeyPair();
  const accounts: BuiltAccount[] = [];
  for (let i = 0; i < totalAccounts; i++) {
    const keys = generateKeyPair();
    accounts.push({ keys, blocks: buildAccountChain(keys, attester, blocksPerAccount, numShards) });
  }

  // Each account is a light-client node following the next `followPerNode` accounts (deterministic).
  const net = new SimNetwork();
  const nodes: SimNode[] = [];
  for (let i = 0; i < totalAccounts; i++) {
    const sub = new Subscription(numShards).own(accounts[i]!.keys.pub);
    for (let j = 1; j <= followPerNode; j++) {
      sub.follow(accounts[(i + j) % totalAccounts]!.keys.pub);
    }
    const node = new SimNode(sub);
    net.register(node);
    nodes.push(node);
  }

  // Publish round by round so genesis (round 0) reaches followers before later blocks.
  for (let r = 0; r < blocksPerAccount; r++) {
    for (let i = 0; i < totalAccounts; i++) {
      net.publish(accounts[i]!.blocks[r]!);
    }
  }

  let maxReceived = 0;
  let sumReceived = 0;
  let maxStored = 0;
  let sumStored = 0;
  let maxBytes = 0;
  for (const n of nodes) {
    maxReceived = Math.max(maxReceived, n.metrics.received);
    sumReceived += n.metrics.received;
    const stored = n.stored();
    maxStored = Math.max(maxStored, stored);
    sumStored += stored;
    maxBytes = Math.max(maxBytes, n.metrics.bytesReceived);
  }

  return {
    config: { totalAccounts, followPerNode, blocksPerAccount, numShards },
    followBound: (followPerNode + 1) * blocksPerAccount,
    broadcastBaseline: totalAccounts * blocksPerAccount,
    perNode: {
      maxReceived,
      avgReceived: sumReceived / nodes.length,
      maxStored,
      avgStored: sumStored / nodes.length,
      maxBytes,
    },
  };
}
