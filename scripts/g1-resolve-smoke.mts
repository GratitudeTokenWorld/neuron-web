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
 * Also covers /pending-sends, /head-proof, /token, the v3 key-blob and
 * recovery-share gates, and (2026-08-16) /files — the file index that replaced
 * the global `files` topic, including the inflated-size and wrong-CID records
 * its client-side fold must reject.
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
import { generateKeyPair, sign, verify as engineVerifySig } from '../src/engine/core/keys.js';
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

// ── v3 custody endpoints (2026-08-15): targeted key-blob path + share gates ──
// The keyblobs gossip topic is gone; these HTTP endpoints replaced it. The
// probe leaves one throwaway blob per run (dev-mode data, wiped on reset).
{
  const { storeKeyBlobOnRelays, fetchKeyBlobFromRelays } = await import('../src/network/recovery-share.js');
  const bases = RELAYS.map((r) => r.http);
  const blobUser = `g3smoke${Date.now().toString(36)}`;
  const fakeBlob = {
    pub: keys.pub, username: blobUser, encryptedKeys: 'ff'.repeat(24),
    faceMapHash: 'a'.repeat(64), createdAt: Date.now(), updatedAt: Date.now(), pinVersion: 3,
  };
  const stored = await storeKeyBlobOnRelays(bases, fakeBlob, 'testnet');
  check(stored === RELAYS.length, `POST /keyblob accepted by ${stored}/${RELAYS.length} relays`);
  const fetched = await fetchKeyBlobFromRelays(bases, { username: blobUser }, 'testnet');
  check(!!fetched && fetched.pub === keys.pub && fetched.encryptedKeys === fakeBlob.encryptedKeys,
    'GET /keyblob round-trips the stored blob');
  check((await fetchKeyBlobFromRelays(bases, { username: `nosuch${Date.now().toString(36)}` }, 'testnet')) === null,
    'GET /keyblob for an unknown username yields null');

  for (const r of RELAYS) {
    // Share store without an attested identity must be refused (this throwaway
    // account never went through face attestation on the relays).
    const ts = Date.now();
    const payload = `recovery-share:${keys.pub}:testnet:${'ab'.repeat(32)}:${ts}`;
    const res = await fetch(`${r.http}/recovery-share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' },
      body: JSON.stringify({ accountId: keys.pub, share: 'ab'.repeat(32), ts, sig: sign(payload, keys.priv) }),
    });
    check(res.status === 409, `${r.name} refuses a share for an un-attested account (409, got ${res.status})`);
    // A forged store signature must be refused outright.
    const badSig = await fetch(`${r.http}/recovery-share`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' },
      body: JSON.stringify({ accountId: keys.pub, share: 'ab'.repeat(32), ts: ts + 1, sig: 'cd'.repeat(32) }),
    });
    check(badSig.status === 403, `${r.name} refuses a forged share-store signature (403, got ${badSig.status})`);
    // Release without a valid challenge session must be refused.
    const rel = await fetch(`${r.http}/recovery-share/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' },
      body: JSON.stringify({ accountId: keys.pub, challengeId: 'bogus', proof: {}, ephPub: '04' + 'ab'.repeat(64) }),
    });
    check(rel.status === 400, `${r.name} refuses a release without a valid challenge (400, got ${rel.status})`);

    // Share status: reports holding without leaking secret material, and must
    // answer for an unknown account (the client's refresh planner treats an
    // error as "unreachable", which would wrongly suppress a repair).
    const stRes = await fetch(`${r.http}/recovery-share/status?accountId=${keys.pub}&network=testnet`);
    const st = stRes.ok ? await stRes.json() as Record<string, unknown> : {};
    check(
      stRes.status === 200 && st.has === false && st.shareHex === undefined,
      `${r.name} reports share status for an unknown account without leaking material`,
    );

    // A recovery challenge must be drawn server-side, ordered and distinct.
    const chRes = await fetch(`${r.http}/recovery-share/challenge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' }, body: '{}',
    });
    const ch = chRes.ok ? await chRes.json() as { challengeId?: string; sequence?: string[] } : {};
    check(
      !!ch.challengeId && Array.isArray(ch.sequence) && ch.sequence.length === 3 && new Set(ch.sequence).size === 3,
      `${r.name} draws a 3-action recovery challenge (${ch.sequence?.join('→') ?? 'none'})`,
    );
    // A recovery challenge must NOT be spendable on the attestation endpoint
    // (it is issued without the enrolment IP cap — an unmetered side door).
    const misuse = await fetch(`${r.http}/face-verify/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' },
      body: JSON.stringify({ accountId: keys.pub, challengeId: ch.challengeId, descriptor: new Array(128).fill(0.01), faceMapHash: 'x' }),
    });
    check(misuse.status === 400, `${r.name} refuses a recovery challenge for attestation (400, got ${misuse.status})`);
    // A photo-style proof (no expression movement) must be refused by the
    // trajectory gate — this is the attack the challenge sequence closes.
    if (ch.challengeId && ch.sequence) {
      const flat = new Array(128).fill(0).map((_, i) => Math.sin(i) * 0.08);
      const photo = await fetch(`${r.http}/recovery-share/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-network': 'testnet' },
        body: JSON.stringify({
          accountId: keys.pub, challengeId: ch.challengeId, ephPub: '04' + 'ab'.repeat(64),
          proof: {
            neutralDescriptor: flat,
            actions: ch.sequence.map((action, i) => ({ action, ratio: 0.03, t: Date.now() + i * 1200, descriptor: flat })),
          },
        }),
      });
      // 404 (no share for this throwaway account) or 403 (gate refused) — both
      // mean no share came out; what must never happen is a 200.
      check(photo.status !== 200, `${r.name} refuses a motionless (photo) trajectory proof (got ${photo.status})`);
    }
  }
}

// ── File index (2026-08-16): GET /files replaced the global `files` topic ────
// The last O(N) in storage. Announcements still gossip — that is how archives
// learn them — but no client keeps another account's, so this endpoint is the
// only way a node sees a file it does not own. relay/ is typechecked by nothing
// and tested by nothing, so this is the only automated coverage its ingest path
// (verify → newest-wins → tombstone) has.
{
  const { fileAnnouncePayload, fileRemovePayload, foldFileRecords } = await import('../src/engine/content/file-index.js');
  const { fetchFileRecords } = await import('../src/network/account-resolver.js');
  const bases = RELAYS.map((r) => r.http);
  // Signed with the ENGINE key against the engine id, exactly as a real client
  // does. The probe previously used the app's JWK signer, which is what let the
  // whole /files path pass here while failing for every actual upload: the probe
  // was the only participant whose pub matched its signer.
  const verify = (payload: string, pk: string, sig: string) => {
    try { return engineVerifySig(sig, payload, pk); } catch { return false; }
  };
  const filesTopic = 'neuronchain/v1/testnet/files';
  pubsub.subscribe(filesTopic);

  // File records are signed with the APP's WebCrypto key, not the engine's.
  const fileKeys = generateKeyPair();
  const cid = 'f' + hashHex(utf8ToBytes(`smoke-file-${username}`)).slice(1);
  const meta = { cid, sizeBytes: 4096, mimeType: 'image/png', timestamp: Date.now(), uploaderPub: fileKeys.pub };
  const announce = { ...meta, signature: sign(fileAnnouncePayload(meta), fileKeys.priv) };

  // An INFLATED record: the signature is honest, the size is not. A verifier
  // that trusted the signed envelope's own string, instead of rebuilding the
  // payload from the record's fields, would accept this.
  const inflated = { ...announce, cid: cid.slice(0, -1) + '0', sizeBytes: 1_073_741_824 };
  // And one whose signature belongs to a different CID entirely.
  const forgedFile = { ...meta, cid: cid.slice(0, -2) + 'ab', signature: announce.signature };

  const pubFile = (r: unknown) => pubsub.publish(filesTopic, new TextEncoder().encode(JSON.stringify(r)));
  await pubFile(announce); await pubFile(inflated); await pubFile(forgedFile);
  console.log('published a signed file record (+ an inflated and a forged one)');
  await sleep(4000);

  for (const r of RELAYS) {
    const res = await fetch(`${r.http}/files?network=testnet&cid=${encodeURIComponent(cid)}`);
    const body = await res.json() as { records?: unknown[]; total?: number };
    check(res.ok && Array.isArray(body.records) && body.records.length === 1,
      `${r.name} serves the signed file record via /files?cid=`);
    check(typeof body.total === 'number',
      `${r.name} reports its own archive total (never a network figure)`);
  }

  // The two bad records must die at the RELAY, not merely at the client. Both
  // checks below would pass either way if we only tested the fold, so ask the
  // archive for them directly — this is the only automated coverage the relay's
  // own verifier has.
  for (const r of RELAYS) {
    for (const [label, badCid] of [['inflated size', inflated.cid], ['wrong-CID signature', forgedFile.cid]] as const) {
      const res = await fetch(`${r.http}/files?network=testnet&cid=${encodeURIComponent(badCid)}`);
      const body = await res.json() as { records?: unknown[] };
      check((body.records ?? []).length === 0,
        `${r.name} refuses to ARCHIVE a record with a ${label}`);
    }
  }

  const { records } = await fetchFileRecords(bases, 'testnet', { limit: 50 });
  const folded = await foldFileRecords(records, verify);
  check(folded.has(cid), 'the honest file record survives client-side verification');
  check(!folded.has(inflated.cid),
    'an INFLATED size is rejected — the payload is rebuilt from the record, not trusted');
  check(!folded.has(forgedFile.cid), 'a record carrying another CID\'s signature is rejected');

  // A withdrawal must be served as a TOMBSTONE, not as an absence: a node that
  // already holds the file has to be able to LEARN it was withdrawn.
  const tombTs = Date.now() + 1;
  const tomb = { cid, sizeBytes: 0, timestamp: tombTs, uploaderPub: fileKeys.pub, removed: true,
    signature: sign(fileRemovePayload(cid, fileKeys.pub, tombTs), fileKeys.priv) };
  await pubFile(tomb);
  await sleep(4000);
  const after = await fetchFileRecords(bases, 'testnet', { cid, limit: 50 });
  check(after.records.some((r) => r.cid === cid && r.removed === true),
    'a withdrawal is served as a tombstone, not as an absent row');
  check(!(await foldFileRecords(after.records, verify)).has(cid),
    'and the fold drops the withdrawn file rather than listing it');

  const unknownCid = await fetchFileRecords(bases, 'testnet', { cid: 'ab'.repeat(32) });
  check(unknownCid.records.length === 0, 'an unknown cid yields no file records');
}

await node.stop();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
