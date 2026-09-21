/**
 * Archive-backfill deploy probe — run after deploying a relay update:
 *
 *   npx tsx scripts/backfill-smoke.mts
 *
 * Proves the thing the G1 probe cannot: that a relay which MISSED a gossip
 * message later heals itself by asking its peers.
 *
 * Reproducing a real gap is the whole difficulty. Relays federate — they dial
 * each other via PEER_RELAYS and their gossip meshes merge — so anything
 * published to one reaches the other within a second, and no divergence exists
 * to heal. A genuine gap only appears when a relay is DOWN while the network is
 * talking, which is exactly the outage window ARCHITECTURE.md describes. So
 * this probe creates one:
 *
 *   1. stop the target relay
 *   2. publish a signed sender chain to the other one
 *   3. start the target again — it now has a hole nothing will ever fill,
 *      because the publisher is long gone and gossip is not replayed
 *   4. ask the target for a /head-proof over that chain: it must MISS, and that
 *      miss is what triggers the backfill request
 *   5. ask again a moment later: it must now SUCCEED, served from blocks its
 *      peer handed over — every one hash- and signature-checked on ingest
 *
 * Step 5 failing while step 4 logs `[Backfill] asked peers` means the ask works
 * and the answer does not, which is a different bug from no ask at all. Keep
 * them as separate checks for that reason.
 *
 * ⚠ This STOPS AND STARTS a relay over ssh. It is a dev-network tool: the
 * outage is a few seconds and the federation keeps serving from the other box,
 * but do not point it at anything anyone depends on.
 *
 * Leaves one throwaway chain in both archives — dev-mode data.
 */
import { execFileSync } from 'node:child_process';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { applyGossipsubCompat } from '../src/network/gossipsub-compat.js';
import { encodeBlock } from '../src/engine/core/block.js';
import { bytesToHex } from '../src/engine/core/hash.js';
import { buildSenderChain } from '../src/engine/sim/counterparty.js';
import { generateKeyPair } from '../src/engine/core/keys.js';
import { fetchHeadProof } from '../src/network/account-resolver.js';

const RELAYS = {
  keep: {
    name: 'relay-1',
    ip: '80.97.27.224',
    dial: '/ip4/80.97.27.224/tcp/9091/p2p/12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh',
    http: 'http://80.97.27.224:9092',
  },
  // The one we take down, so it is the one with the hole.
  target: {
    name: 'relay-2',
    ip: '80.97.27.112',
    dial: '/ip4/80.97.27.112/tcp/9091/p2p/12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU',
    http: 'http://80.97.27.112:9092',
  },
};

const SSH_KEY = process.env.NEURON_SSH_KEY || `${process.env.HOME || process.env.USERPROFILE}/.ssh/neuron-ops`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, label: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

function ssh(ip: string, cmd: string): string {
  return execFileSync('ssh', [
    '-i', SSH_KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20', `ubuntu@${ip}`, cmd,
  ], { encoding: 'utf8', timeout: 60_000 });
}

async function httpUp(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/relay-info`, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch { return false; }
}

async function waitFor(fn: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(2_000);
  }
  return false;
}

// ── 1. Open the gap ──────────────────────────────────────────────────────────
console.log(`stopping ${RELAYS.target.name} to create a real outage window…`);
ssh(RELAYS.target.ip, 'pm2 stop neuron-relay >/dev/null 2>&1; true');
check(await waitFor(async () => !(await httpUp(RELAYS.target.http)), 60_000),
  `${RELAYS.target.name} is down (the outage window is real, not simulated)`);

// ── 2. Publish a chain only the surviving relay can hear ────────────────────
applyGossipsubCompat();
const node = await createLibp2p({
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  services: {
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
    identify: identify(),
  },
});
const pubsub = node.services.pubsub as { subscribe(t: string): void; publish(t: string, d: Uint8Array): Promise<unknown> };

await node.dial(multiaddr(RELAYS.keep.dial));
const recipient = generateKeyPair().pub;
const chain = buildSenderChain(4, 2, recipient);
const senderId = chain.blocks[0]!.accountId;
const sendHash = chain.blocks[2]!.hash;
const blockTopic = `neuronchain/v1/testnet/engine-blocks/${chain.blocks[0]!.shard}`;
pubsub.subscribe(blockTopic);
await sleep(4_000);                      // let the mesh form (1–3 heartbeats)
for (const b of chain.blocks) {
  await pubsub.publish(blockTopic, new TextEncoder().encode(JSON.stringify({ blockHex: bytesToHex(encodeBlock(b)) })));
}
console.log(`published a ${chain.blocks.length}-block chain for ${senderId.slice(0, 12)}… to ${RELAYS.keep.name} only`);
await sleep(3_000);

const keepPacket = await fetchHeadProof([RELAYS.keep.http], senderId, sendHash, 'testnet');
check(!!keepPacket, `${RELAYS.keep.name} has the chain (it was listening)`);

// ── 3. Bring the target back, with its hole ─────────────────────────────────
console.log(`starting ${RELAYS.target.name} again…`);
ssh(RELAYS.target.ip, 'pm2 start neuron-relay >/dev/null 2>&1; true');
check(await waitFor(() => httpUp(RELAYS.target.http), 120_000), `${RELAYS.target.name} is back up`);
await sleep(5_000);   // let it finish loading its archive

// ── 4. The miss, which is the trigger ───────────────────────────────────────
const beforeHeal = await fetchHeadProof([RELAYS.target.http], senderId, sendHash, 'testnet');
check(beforeHeal === null,
  `${RELAYS.target.name} MISSES the chain it slept through (this is the gap, and the trigger)`);

// ── 5. The heal ─────────────────────────────────────────────────────────────
// Generous, because it is a gossip round trip: ask → peer serves each block →
// ingest + verify. The failure that matters is "never", not "slow".
const healed = await waitFor(
  async () => (await fetchHeadProof([RELAYS.target.http], senderId, sendHash, 'testnet')) !== null,
  60_000,
);
check(healed, `${RELAYS.target.name} healed itself from its peer, with no client republish`);

if (healed) {
  // The healed packet must verify, not merely exist: a backfill that accepted
  // unverified blocks would be a hole rather than a repair.
  const packet = await fetchHeadProof([RELAYS.target.http], senderId, sendHash, 'testnet');
  check(!!packet && packet.sendBlock.hash === sendHash && packet.openBlock.accountId === senderId,
    'the healed packet is the chain it was asked for, not a different one');
  check(!!packet && packet.openInclusionProof.length > 0 && packet.sendInclusionProof.length > 0,
    'the healed packet carries audit paths — the archive rebuilt the accumulator, not just the rows');
}

await node.stop();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
