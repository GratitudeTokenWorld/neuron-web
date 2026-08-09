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
import { accountRecordPayload, resolveAccountFromRelays, verifyAccountRecordSig, type AccountRecord } from '../src/network/account-resolver.js';

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

await node.stop();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
