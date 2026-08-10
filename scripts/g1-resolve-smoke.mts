/**
 * G1 deploy smoke test — run after deploying the relay update:
 *
 *   npx tsx scripts/g1-resolve-smoke.mts
 *
 * Acts as a headless client: connects to both cloud relays over raw TCP
 * (port 9091), publishes an ENGINE-SIGNED account record on the global
 * `accounts` topic (exactly what a browser's publish tick does), then
 * exercises the full G1 resolution path:
 *
 *   1. both relays archive the record (`[Archive] Stored account record …`)
 *   2. cross-relay federation carries it to the relay we did NOT publish to
 *   3. GET /resolve serves it, and the client-side verifier accepts it
 *   4. a FORGED record (bad signature, higher _version) must NOT evict it
 *
 * Leaves one throwaway `g1smoke…` record in the relays' account archive —
 * dev-mode data, wiped with the next reset.
 */
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { multiaddr } from '@multiformats/multiaddr';
import { applyGossipsubCompat } from '../src/network/gossipsub-compat.js';
import { generateKeyPair, sign } from '../src/engine/core/keys.js';
import { encodeBlock } from '../src/engine/core/block.js';
import { bytesToHex } from '../src/engine/core/hash.js';
import { buildSenderChain } from '../src/engine/sim/counterparty.js';
import { accountRecordPayload, resolveAccountFromRelays, verifyAccountRecordSig, fetchPendingSends, fetchHeadProof, fetchMintProof, type AccountRecord } from '../src/network/account-resolver.js';
import { verifyPacket, verifyMintProof } from '../src/engine/core/counterparty-proof.js';
import { createBlock } from '../src/engine/core/block.js';
import { hashHex, utf8ToBytes } from '../src/engine/core/hash.js';

const RELAYS = [
  { name: 'relay-1', dial: '/ip4/80.97.27.224/tcp/9091/p2p/12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh', http: 'http://80.97.27.224:9092' },
  { name: 'relay-2', dial: '/ip4/80.97.27.112/tcp/9091/p2p/12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU', http: 'http://80.97.27.112:9092' },
];
const TOPIC = 'neuronchain/v1/testnet/accounts';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// ── The record a browser's publish tick would emit, engine-signed ────────────
const keys = generateKeyPair();
const username = `g1smoke${Date.now().toString(36)}`;
const record: AccountRecord = {
  username, pub: keys.pub, balance: 1_000_000, nonce: 0,
  createdAt: Date.now(), faceMapHash: 'a'.repeat(64),
  _gen: 0, _version: 1,
};
record._sig = sign(accountRecordPayload(record), keys.priv);

// A forgery a malicious peer might gossip: same username, higher version,
// attacker-controlled fields — but it cannot produce the owner's signature.
const forged = { ...record, pinSalt: 'evil', _version: 99, _sig: 'ab'.repeat(32) };

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

// Dial ONLY relay-1: relay-2 must get the record via PEER_RELAYS federation.
await node.dial(multiaddr(RELAYS[0]!.dial));
console.log(`connected to ${RELAYS[0]!.name}`);
pubsub.subscribe(TOPIC);
await sleep(4000); // let the gossipsub mesh form (1–3 heartbeats)

await pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(record)));
console.log(`published signed record username=${username}`);
await pubsub.publish(TOPIC, new TextEncoder().encode(JSON.stringify(forged)));
console.log('published forged record (must be dropped by relays)');
await sleep(3000); // relay ingest + federation hop

// ── Resolve from each relay directly ─────────────────────────────────────────
for (const r of RELAYS) {
  const viaName = await resolveAccountFromRelays([r.http], { username }, 'testnet');
  check(!!viaName && viaName.pub === keys.pub, `${r.name} resolves username → verified record`);
  check(!!viaName && viaName._version === 1 && viaName.pinSalt === undefined,
    `${r.name} kept the real record (forgery with _version=99 did not evict it)`);
  const viaPub = await resolveAccountFromRelays([r.http], { pub: keys.pub }, 'testnet');
  check(!!viaPub && viaPub.username === username, `${r.name} resolves pub → verified record`);
}

// ── The client path as node.resolveAccount uses it: all bases in parallel ────
const best = await resolveAccountFromRelays(RELAYS.map((r) => r.http), { username }, 'testnet');
check(!!best && verifyAccountRecordSig(best), 'multi-relay resolve returns a signature-valid record');

// Unknown names still 404 → null.
const missing = await resolveAccountFromRelays(RELAYS.map((r) => r.http), { username: 'no-such-user' }, 'testnet');
check(missing === null, 'unknown username resolves to null');

// ── Offline-transfer discovery (/pending-sends) ──────────────────────────────
// Publish a real signed sender chain whose send is addressed to a recipient
// that is NOT online: the relays must archive the blocks and then answer
// "what is addressed to <recipient>?" — the query a wiped-and-recovered
// device uses to find transfers it slept through.
const recipient = generateKeyPair().pub;
const chain = buildSenderChain(4, 2, recipient); // open + 3 sends, index 2 → recipient
const blockTopic = `neuronchain/v1/testnet/engine-blocks/${chain.blocks[0]!.shard}`;
pubsub.subscribe(blockTopic);
await sleep(2000);
for (const b of chain.blocks) {
  await pubsub.publish(blockTopic, new TextEncoder().encode(JSON.stringify({ blockHex: bytesToHex(encodeBlock(b)) })));
}
console.log(`published ${chain.blocks.length}-block sender chain (send @2 → offline recipient)`);
await sleep(3000); // relay ingest + federation

for (const r of RELAYS) {
  const { headIndex, sends } = await fetchPendingSends([r.http], recipient, 'testnet');
  check(
    sends.length === 1 && sends[0]!.sender === chain.blocks[0]!.accountId && sends[0]!.blockHash === chain.blocks[2]!.hash,
    `${r.name} reports exactly the pending send addressed to the offline recipient`,
  );
  // The recipient has no chain, so the claim safety gate must see headIndex −1
  // for them (nothing to be behind of).
  check(headIndex === -1, `${r.name} reports headIndex −1 for a chainless recipient`);
}
const none = await fetchPendingSends(RELAYS.map((r) => r.http), generateKeyPair().pub, 'testnet');
check(none.sends.length === 0, 'an account with no inbound sends gets an empty pending list');
// The claim safety gate's other half: the archive's head index for the SENDER
// must match its real chain head (a recovering sender must sync to here
// before it may claim anything).
const senderView = await fetchPendingSends(RELAYS.map((r) => r.http), chain.blocks[0]!.accountId, 'testnet');
check(senderView.headIndex === chain.blocks.length - 1, 'archive reports the sender chain head index');

// ── G2: counterparty proof packet (/head-proof) ─────────────────────────────
// The recipient claims from a compact packet the archive builds — verified
// end-to-end here exactly as the client ledger verifies it. No chain pull.
const senderId = chain.blocks[0]!.accountId;
const sendHash = chain.blocks[2]!.hash;
for (const r of RELAYS) {
  const packet = await fetchHeadProof([r.http], senderId, sendHash, 'testnet');
  const verdict = packet ? verifyPacket(packet, recipient, { min: 1, requiredTypes: ['personhood'] }) : { ok: false, reason: 'no packet' };
  check(verdict.ok === true, `${r.name} serves a proof packet that verifies for the recipient (${verdict.reason ?? 'ok'})`);
  if (packet) {
    check(
      packet.headBlock.index === chain.blocks.length - 1 && packet.sendBlock.hash === sendHash,
      `${r.name} packet spans the full chain head and the exact send`,
    );
  }
}
// Unknown send hash → no packet.
check(
  (await fetchHeadProof(RELAYS.map((r) => r.http), senderId, 'ab'.repeat(32), 'testnet')) === null,
  'unknown send hash yields no packet',
);

// ── G2 for NFTs: mint proof (/token) ────────────────────────────────────────
// Extend the same chain with a mint so the archive can prove what a token IS —
// the half a transfer packet cannot carry (the mint lives on the MINTER's
// chain, a different account once the token has moved).
const mintTokenId = hashHex(utf8ToBytes(`smoke-token-${username}`));
const mintBlock = createBlock(
  {
    accountId: senderId, index: chain.blocks.length, type: 'nft-mint',
    previousHash: chain.blocks[chain.blocks.length - 1]!.hash, shard: chain.blocks[0]!.shard,
    timestamp: 2000, balance: chain.blocks[chain.blocks.length - 1]!.balance,
    tokenId: mintTokenId, contentRef: 'cid-smoke', nftMeta: { name: 'Smoke' },
  },
  chain.keys.priv,
  chain.accumulator,
);
await pubsub.publish(blockTopic, new TextEncoder().encode(JSON.stringify({ blockHex: bytesToHex(encodeBlock(mintBlock)) })));
console.log('published an nft-mint block');
await sleep(3000);

for (const r of RELAYS) {
  const proof = await fetchMintProof([r.http], mintTokenId, 'testnet');
  const verdict = proof ? verifyMintProof(proof, mintTokenId, { min: 1, requiredTypes: ['personhood'] }) : { ok: false, reason: 'no proof' };
  check(verdict.ok === true, `${r.name} serves a mint proof that verifies (${verdict.reason ?? 'ok'})`);
  check(
    !!proof && proof.mintBlock.contentRef === 'cid-smoke' && proof.mintBlock.accountId === senderId,
    `${r.name} mint proof carries the token's content ref + minter`,
  );
}
check(
  (await fetchMintProof(RELAYS.map((r) => r.http), 'cd'.repeat(32), 'testnet')) === null,
  'unknown token id yields no mint proof',
);

await node.stop();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
