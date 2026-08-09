/**
 * NeuronChain libp2p relay server
 *
 * Run with:  npm run relay   (tsx relay/server.ts)
 *
 * This server provides three services:
 *   1. WebSocket listener at /p2p on port 9090 - browser entry point
 *   2. Circuit Relay v2 - lets browser peers reach each other through NAT
 *   3. Kademlia DHT server mode - peer routing for the network
 *
 * This relay is NOT on the data path:
 *   - Application messages (blocks, votes, accounts) pass peer-to-peer via GossipSub
 *   - Only circuit relay tunnels pass through here, only for NAT traversal
 *   - Once two browser peers discover each other, they upgrade to direct WebRTC
 *
 * Deploy multiple independent community relays to eliminate single-operator control.
 *
 * Environment variables:
 *   PORT         - WebSocket port (default: 9090)
 *   PEER_ID_FILE - path to persist peer ID across restarts (default: .relay-peer-id.json)
 */

import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { WebSockets as WsMatcher, WebSocketsSecure as WssMatcher } from '@multiformats/multiaddr-matcher';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { kadDHT } from '@libp2p/kad-dht';
import { ping } from '@libp2p/ping';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { promises as fs } from 'fs';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { applyGossipsubCompat } from '../src/network/gossipsub-compat.js';
import { randomBytes, randomUUID } from 'crypto';
// Engine identity: this server is the ATTESTER — it signs engine attestations
// (imported directly, run via tsx) instead of old face-hash credentials.
import { createAttestation } from '../src/engine/core/attestation.js';
import { deriveCommitment } from '../src/engine/core/identity.js';
import { publicKeyFromPrivate as enginePublicKeyFromPrivate, verify as engineVerify } from '../src/engine/core/keys.js';
import { bytesToHex, hexToBytes } from '../src/engine/core/hash.js';
// Super-node archival (Slice 4a): the relay persists every engine block it sees
// (via topic mirroring) and serves delta requests, so account chains are durably
// held even when light clients holding a shard go offline.
import { decodeBlock, verifyBlock } from '../src/engine/core/block.js';
import { AccountAccumulator } from '../src/engine/core/accumulator.js';

// gossipsub 14.x ↔ libp2p 3.x interop shims (fixes A/B/C) — now shared with the
// BROWSER build, which needs them just as much (clients could send but never
// receive without them). See src/network/gossipsub-compat.ts for the details.
applyGossipsubCompat();

const PORT = parseInt(process.env.PORT || '9090', 10);
// All runtime state (identity keys, face DB, archives, logs) lives under one
// gitignored directory instead of littering the repo root. Filenames are
// unchanged so explicit *_FILE env overrides keep working, and migrateDataDir()
// moves any pre-existing root-level files here on startup (identity preserved).
const DATA_DIR = process.env.RELAY_DATA_DIR || '.relay-data';
const inData = (name: string) => `${DATA_DIR}/${name}`;
const PEER_ID_FILE = process.env.PEER_ID_FILE || inData('.relay-peer-id.json');
// Comma-separated list of peer relay multiaddrs (must include /p2p/<peerId> suffix).
// Example: PEER_RELAYS=/dns4/relay2.example.com/tcp/9090/ws/p2p/<peerId2>
const PEER_RELAYS = (process.env.PEER_RELAYS || '').split(',').filter(Boolean);
const SIGNING_KEY_FILE = process.env.SIGNING_KEY_FILE || inData('.relay-signing-key.json');
const FACE_DB_FILE = process.env.FACE_DB_FILE || inData('.relay-face-db.json');
const ATTESTER_KEY_FILE = process.env.ATTESTER_KEY_FILE || inData('.relay-attester-key.json');
// Slice 4a: super-node archival store of engine blocks. ARCHIVE=0 disables it
// (pure relay). NOTE: JSON file is fine for the first super-node / testing; swap
// for LevelDB/SQLite when chains grow (see docs/SUPERNODE.md).
const ENGINE_BLOCKS_FILE = process.env.ENGINE_BLOCKS_FILE || inData('.relay-engine-blocks.json');
// Key-blob archive: lets a fully-wiped device recover without any peer online
// (the blob is face+PIN-encrypted, so storing it is safe — both factors required).
const KEYBLOBS_FILE = process.env.KEYBLOBS_FILE || inData('.relay-keyblobs.json');
// Account-record archive (G1): the relay is the directory tier now that clients
// no longer subscribe to the global `accounts` topic — they resolve a username/
// pub on demand via HTTP `/resolve` and cache the result. Records here are
// self-certifying (signed by the account's engine key), so serving them is
// untrusted: the client re-verifies every record it accepts.
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE || inData('.relay-accounts.json');
// Username uniqueness registry (attester-enforced, Phase 3): the first account
// attested for a username owns it; a later different-account claim is rejected.
const USERNAMES_FILE = process.env.USERNAMES_FILE || inData('.relay-usernames.json');
// The first OPERATOR_COUNT accounts attested become "operators" — the only
// accounts allowed to wipe this relay's archive (a signed network reset). All
// other accounts' resets are ignored. Survives wipes (kept like identity keys).
const OPERATORS_FILE = process.env.OPERATORS_FILE || inData('.relay-operators.json');
const RELOAD_LOG_FILE = process.env.RELOAD_LOG_FILE || inData('reload.log');
const OPERATOR_COUNT = 3;
const ARCHIVE_ENABLED = process.env.ARCHIVE !== '0';
// Per-block/per-request archive logs are verbose; gate them behind DEBUG_ARCHIVE=1.
// Startup ("Loaded N") and reset lines stay unconditional.
const DEBUG_ARCHIVE = process.env.DEBUG_ARCHIVE === '1';
const dlog = (...args: unknown[]) => { if (DEBUG_ARCHIVE) console.log(...args); };

// Must match PROTOCOL_VERSION in src/network/libp2p-network.ts
const PROTOCOL_VERSION = 'v1';

// ── Face-verify session store ─────────────────────────────────────────────────
// The client performs ALL of blink + smile + a head turn, in a random order, per
// enrollment; this list only decides which DIRECTION the turn is asked in (and
// serves as the per-attestation nonce). 'blink' stays out so the draw is always
// a turn direction — the client adds blink and smile itself.
const CHALLENGE_TYPES = ['look-left', 'look-right'];
// 15 minutes, not 5. The challenge is issued BEFORE the capture flow, which now
// runs a framing gate, a three-leg depth sweep, five held actions and three
// samples — a careful or retried run passes 5 minutes easily, and the attestation
// then fails with an opaque HTTP 400 after the user has done all the work.
const CHALLENGE_TTL_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 24 * 60 * 60 * 1000;
// Per-IP verification cap per 24h, by network. Local/loopback IPs are exempt
// entirely (see checkIpLimit), so local dev testing is never throttled.
// NOTE: the counter is in-memory on the RELAY (per IP) — a browser reload does
// NOT reset it; restarting the relay does.
const IP_MAX_PER_DAY = { testnet: 24, mainnet: 12 };
// Max accounts per face. Mainnet = 1 (true one-human-one-account); testnet = 3
// so one tester can hold a couple of accounts without weakening the model.
//
// This was briefly 25: abandoned attempts used to burn a slot forever, so real
// testing hit the cap without ever creating that many accounts. Slots are now
// provisional and released after FACE_USE_TTL_MS, so the inflated cap is no
// longer needed. FACE_MAX_TESTNET still overrides it — set it to 2 to make the
// limit testable in 3 enrollments instead of 4.
const FACE_MAX = { testnet: Number(process.env.FACE_MAX_TESTNET) || 3, mainnet: 1 };
/**
 * Euclidean distance threshold for "same face" — must match client MATCH_THRESHOLD.
 * Below this distance = same person; above = different person.
 */
const FACE_MATCH_THRESHOLD = 0.45;
/** challengeId → { type, createdAt, ip, used } */
const challengeSessions = new Map();
/** ip → { count, windowStart } */
const ipVerifyLog = new Map();
/**
 * Persistent face descriptor database.
 * Each entry: { descriptor: number[128], count: number, network: string }
 * Matching uses Euclidean distance < FACE_MATCH_THRESHOLD (same as client).
 * This is the only reliable Sybil check — hash-based counting fails because
 * face descriptors vary slightly between sessions and hash differently each time.
 */
let faceDescriptorDB = [];

/**
 * Crash-safe atomic file write (data hardening, Tier 1). Writes to a temp file,
 * fsyncs it, snapshots the previous good copy to `.bak`, then `rename()`s over the
 * target — rename is atomic, so a reader (or a crash) never sees a half-written
 * file. `mode` defaults to 0o644; key material passes 0o600. Failures are logged
 * loudly instead of being silently swallowed, so a full disk can't lose data quietly.
 */
async function atomicWrite(file, data, mode = 0o644) {
  const tmp = `${file}.tmp`;
  try {
    const fh = await fs.open(tmp, 'w', mode);
    try {
      await fh.writeFile(data);
      await fh.chmod(mode);   // enforce perms even if tmp pre-existed from a prior crash
      await fh.sync();        // fsync: durably flush before the rename
    } finally {
      await fh.close();
    }
    await fs.copyFile(file, `${file}.bak`).catch(() => {}); // rollback point (best-effort; absent on first write)
    await fs.rename(tmp, file);
  } catch (e) {
    console.error(`[Relay] FAILED to persist ${file}: ${e?.message ?? e}`);
  }
}

async function loadFaceDB() {
  try {
    faceDescriptorDB = JSON.parse(await fs.readFile(FACE_DB_FILE, 'utf8'));
    console.log(`[FaceVerify] Loaded face DB: ${faceDescriptorDB.length} enrolled face(s)`);
  } catch { faceDescriptorDB = []; }
}

async function saveFaceDB() {
  await atomicWrite(FACE_DB_FILE, JSON.stringify(faceDescriptorDB));
}

// ── Engine-block archival (Slice 4a) ──────────────────────────────────────────
// hash → { accountId, index, shard, network, blockHex }. The relay sees every
// engine block via topic mirroring; persisting them makes it a durable shard
// holder so accounts recover even if every light client holding a shard is gone.
const engineBlockStore = new Map();
let engineStoreDirty = false;
// `${network}:${accountId}:${index}` → hash. Two DIFFERENT hashes at one height
// = a double-spend. With G2 proof-claims, recipients no longer hold sender
// chains, so the archive tier (which does) is where forks get noticed — on
// detection the relay gossips both blocks on the shard's conflict topic and
// every client freezes the equivocator via its own verification (fraud.ts).
const engineHeightIndex = new Map();
// Set in main() once pubsub exists: (network, shard, aHex, bHex) => void.
let publishConflict = null;

// Heights whose conflict was already announced — one evidence publish per
// (network, account, index) fork, not one per sibling variant (a looping
// client can mint dozens of siblings; the first pair freezes the account
// everywhere, the rest is noise).
const conflictAnnounced = new Set();

/** Height-index a stored row; publish conflict evidence if a sibling exists. */
function indexEngineRow(row) {
  const hkey = `${row.network}:${row.accountId}:${row.index}`;
  const prior = engineHeightIndex.get(hkey);
  if (prior && prior !== row.hash) {
    if (conflictAnnounced.has(hkey)) return;
    conflictAnnounced.add(hkey);
    const sibling = engineBlockStore.get(prior);
    console.log(`[Archive] CONFLICT acct=${row.accountId.slice(0, 12)}… idx=${row.index} — publishing evidence`);
    if (sibling && publishConflict) publishConflict(row.network, row.shard, sibling.blockHex, row.blockHex);
    return;
  }
  engineHeightIndex.set(hkey, row.hash);
}

async function loadEngineBlocks() {
  try {
    const rows = JSON.parse(await fs.readFile(ENGINE_BLOCKS_FILE, 'utf8'));
    let dropped = 0;
    for (const r of rows) {
      // Verify on load (data hardening): re-derive + re-verify each block so a
      // tampered or corrupted archive entry is dropped, never loaded or served.
      try {
        const block = decodeBlock(hexToBytes(r.blockHex));
        if (block.hash !== r.hash || !verifyBlock(block)) { dropped++; continue; }
      } catch { dropped++; continue; }
      engineBlockStore.set(r.hash, r);
      indexEngineRow(r);
    }
    console.log(`[Archive] Loaded ${engineBlockStore.size} engine block(s)${dropped ? ` (dropped ${dropped} invalid)` : ''}`);
  } catch { /* no archive yet */ }
}

async function saveEngineBlocks() {
  if (!engineStoreDirty) return;
  engineStoreDirty = false;
  await atomicWrite(ENGINE_BLOCKS_FILE, JSON.stringify([...engineBlockStore.values()]));
}
// Flush periodically rather than on every block (archival is append-heavy).
setInterval(() => { saveEngineBlocks().catch(() => {}); }, 5_000);

/** Parse the network segment from a topic: neuronchain/{version}/{network}/... */
function networkFromTopic(topic) {
  const parts = topic.split('/');
  return parts.length > 2 ? parts[2] : 'testnet';
}

/** Archive an engine block seen on gossip (verify before storing). */
// ── Face-slot accounting (abandoned attempts must not burn a slot) ───────────
// A verify issues an attestation and consumes one of the human's face slots AND
// claims the username, but most attempts never become an account: the user
// cancels, the quorum fails, the camera dies. Both used to be spent forever —
// real testing hit "Face limit reached (25/25)" without ever creating 25
// accounts, and "luk is already registered" for an account that never existed.
// Both are now PROVISIONAL until the account's open block is actually archived;
// unclaimed ones are released after FACE_USE_TTL_MS.
const pendingFaceUses = new Map();   // accountId → { nid, username, at, network }
const FACE_USE_TTL_MS = 5 * 60 * 1000;

function releaseStaleFaceUses() {
  const now = Date.now();
  // Local flag: unlike the engine/username stores there is no module-level
  // faceDb dirty bit — saveFaceDB() writes unconditionally — so track it here.
  let faceDbDirty = false;
  for (const [accountId, use] of pendingFaceUses) {
    if (now - use.at < FACE_USE_TTL_MS) continue;
    pendingFaceUses.delete(accountId);
    const entry = faceDescriptorDB.find(e => e.nid === use.nid && e.network === use.network);
    if (entry && entry.count > 0) {
      entry.count--;
      faceDbDirty = true;
      console.log(`[Attester] released unused face slot for acct=${String(accountId).slice(0, 12)}… → ${entry.count}`);
    }
    // Only release the name if it is still held by THIS abandoned attempt.
    const claim = use.username && usernameRegistry.get(use.username);
    if (claim && claim.accountId === accountId) {
      usernameRegistry.delete(use.username);
      usernameDirty = true;
      console.log(`[Attester] released unused username "${use.username}"`);
    }
  }
  if (faceDbDirty) saveFaceDB().catch(() => {});
  if (usernameDirty) saveUsernames().catch(() => {});
}
setInterval(releaseStaleFaceUses, 60_000);

function archiveEngineBlock(blockHex, network) {
  if (!ARCHIVE_ENABLED || !blockHex) return;
  let block;
  try { block = decodeBlock(hexToBytes(blockHex)); } catch { return; }
  if (!verifyBlock(block)) return;
  if (engineBlockStore.has(block.hash)) return;
  const row = {
    hash: block.hash, accountId: block.accountId, index: block.index,
    shard: block.shard, network, blockHex,
    // Denormalized so /pending-sends can scan without decoding every row.
    // Rows archived before this landed lack them — that scan decodes on demand.
    type: block.type, recipient: block.recipient,
  };
  engineBlockStore.set(block.hash, row);
  indexEngineRow(row);
  engineStoreDirty = true;
  // The account exists — its face slot is now permanent.
  if (block.type === 'open') pendingFaceUses.delete(block.accountId);
  dlog(`[Archive] Stored ${block.type} acct=${block.accountId.slice(0, 12)}… idx=${block.index} shard=${block.shard}`);
}

// ── Key-blob archival ─────────────────────────────────────────────────────────
// pub → { ...blob, network }. The blob is face+PIN-encrypted; persisting it makes
// recovery peer-independent (a wiped device fetches it from the super-node).
const keyBlobStore = new Map();
let keyBlobDirty = false;
const blobTs = (b) => Number(b?.updatedAt ?? b?.createdAt ?? 0);

async function loadKeyBlobs() {
  try {
    for (const b of JSON.parse(await fs.readFile(KEYBLOBS_FILE, 'utf8'))) keyBlobStore.set(b.pub, b);
    console.log(`[Archive] Loaded ${keyBlobStore.size} key-blob(s)`);
  } catch { /* none yet */ }
}

async function saveKeyBlobs() {
  if (!keyBlobDirty) return;
  keyBlobDirty = false;
  await atomicWrite(KEYBLOBS_FILE, JSON.stringify([...keyBlobStore.values()]));
}
setInterval(() => { saveKeyBlobs().catch(() => {}); }, 5_000);

// ── Account-record archive (G1 directory tier) ───────────────────────────────
// `${network}:${pub}` → account record (username, pub, createdAt, pq keys, …).
// Only ENGINE-VERIFIED records are stored: the record self-signs
// `account:{pub}:{username}:{createdAt}:{faceMapHash}` with the account key, so
// an attacker cannot evict a real record by gossiping a forged one — their fake
// fails verification here and is dropped. (The freshly-created record is
// app-JWK-signed for its first ≤20 s until the owner's publish tick re-signs it
// with the engine key; clients reject those anyway, so storing them adds nothing.)
const accountStore = new Map();
let accountsDirty = false;

async function loadAccounts() {
  try {
    for (const r of JSON.parse(await fs.readFile(ACCOUNTS_FILE, 'utf8'))) {
      if (r && r.pub && r.network) accountStore.set(`${r.network}:${r.pub}`, r);
    }
    console.log(`[Archive] Loaded ${accountStore.size} account record(s)`);
  } catch { /* none yet */ }
}
async function saveAccounts() {
  if (!accountsDirty) return;
  accountsDirty = false;
  await atomicWrite(ACCOUNTS_FILE, JSON.stringify([...accountStore.values()]));
}
setInterval(() => { saveAccounts().catch(() => {}); }, 5_000);

/** Archive an account record seen on the accounts topic (verified, newest wins). */
function archiveAccountRecord(acc, network) {
  if (!ARCHIVE_ENABLED || !acc || !acc.pub || !acc.username) return;
  const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
  try {
    if (!acc._sig || !engineVerify(String(acc._sig), payload, String(acc.pub))) return;
  } catch { return; }
  const key = `${network}:${acc.pub}`;
  const existing = accountStore.get(key);
  // Owner-only publishing + per-publisher monotonic _version ⇒ newest wins.
  if (existing && Number(acc._version ?? 0) < Number(existing._version ?? 0)) return;
  accountStore.set(key, { ...acc, network });
  accountsDirty = true;
  dlog(`[Archive] Stored account record user=${acc.username} acct=${String(acc.pub).slice(0, 12)}…`);
}

// ── Username uniqueness (Phase 3, attester-enforced) ──────────────────────────
const usernameRegistry = new Map(); // username (lowercased) → accountId
let usernameDirty = false;

async function loadUsernames() {
  try {
    for (const [u, v] of JSON.parse(await fs.readFile(USERNAMES_FILE, 'utf8'))) {
      // username → { accountId, nid }. Normalize the old string-only format.
      usernameRegistry.set(u, typeof v === 'string' ? { accountId: v, nid: undefined } : v);
    }
    console.log(`[Attester] Loaded ${usernameRegistry.size} username(s)`);
  } catch { /* none yet */ }
}
async function saveUsernames() {
  if (!usernameDirty) return;
  usernameDirty = false;
  await atomicWrite(USERNAMES_FILE, JSON.stringify([...usernameRegistry.entries()]));
}
setInterval(() => { saveUsernames().catch(() => {}); }, 5_000);

// ── Operators (Phase 3): first OPERATOR_COUNT accounts attested ───────────────
let operators = []; // ordered accountIds; only these can wipe the relay
// Current reset epoch — bumped only by an operator-signed reset; served in
// /relay-info so clients (incl. late/offline ones) converge + wipe when behind.
const GENERATION_FILE = process.env.GENERATION_FILE || inData('.relay-generation.json');
let currentGeneration = 0;
async function loadGeneration() {
  try { currentGeneration = Number(JSON.parse(await fs.readFile(GENERATION_FILE, 'utf8'))) || 0; } catch { currentGeneration = 0; }
}
async function loadOperators() {
  try { operators = JSON.parse(await fs.readFile(OPERATORS_FILE, 'utf8')); console.log(`[Attester] Loaded ${operators.length} operator(s)`); } catch { operators = []; }
}
function recordOperator(accountId) {
  if (operators.length >= OPERATOR_COUNT || operators.includes(accountId)) return;
  operators.push(accountId);
  atomicWrite(OPERATORS_FILE, JSON.stringify(operators));
  console.log(`[Attester] operator #${operators.length}: ${accountId.slice(0, 12)}…`);
}

/** Archive a key-blob seen on the keyblobs topic (keep the newest per account). */
function archiveKeyBlob(blob, network) {
  if (!ARCHIVE_ENABLED || !blob || !blob.pub || !blob.username || !blob.encryptedKeys) return;
  const existing = keyBlobStore.get(blob.pub);
  if (existing && blobTs(existing) >= blobTs(blob)) return;
  keyBlobStore.set(blob.pub, { ...blob, network });
  keyBlobDirty = true;
  dlog(`[Archive] Stored key-blob user=${blob.username} acct=${String(blob.pub).slice(0, 12)}…`);
}

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

/**
 * Find the closest stored face entry for the given descriptor and network.
 * Returns the entry if within FACE_MATCH_THRESHOLD, otherwise null (= new face).
 */
function findMatchingFace(descriptor, network) {
  let best = null;
  let bestDist = Infinity;
  for (const entry of faceDescriptorDB) {
    if (entry.network !== network) continue;
    const d = euclideanDistance(descriptor, entry.descriptor);
    if (d < FACE_MATCH_THRESHOLD && d < bestDist) {
      bestDist = d;
      best = entry;
    }
  }
  return best;
}

// ── Face-verify helpers ───────────────────────────────────────────────────────

function getClientIp(req) {
  return ((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0]).trim() || 'unknown';
}

function issueChallenge(ip) {
  const challengeId = globalThis.crypto.randomUUID();
  const type = CHALLENGE_TYPES[Math.floor(Math.random() * CHALLENGE_TYPES.length)];
  const now = Date.now();
  challengeSessions.set(challengeId, { type, createdAt: now, ip, used: false });
  // Prune expired entries periodically
  if (challengeSessions.size % 200 === 0) {
    for (const [id, s] of challengeSessions) {
      if (now - s.createdAt > CHALLENGE_TTL_MS) challengeSessions.delete(id);
    }
  }
  return { challengeId, type, expiresAt: now + CHALLENGE_TTL_MS };
}

/**
 * Loopback / private-range clients are local development (browser → Vite proxy →
 * relay, all on 127.0.0.1), not public abuse. Exempt them from the per-IP rate
 * limit so local multi-account testing isn't throttled. Public clients on a
 * deployed relay still get the limit (real anti-bot signal).
 */
function isLocalIp(ip) {
  const a = ip.replace(/^::ffff:/, '');
  return ip === 'unknown' || ip === '::1' || a === '127.0.0.1'
    || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
}

function checkIpLimit(ip, network) {
  if (isLocalIp(ip)) return true; // local dev never limited
  const max = IP_MAX_PER_DAY[network] ?? IP_MAX_PER_DAY.testnet;
  const now = Date.now();
  const entry = ipVerifyLog.get(ip);
  if (!entry || now - entry.windowStart > IP_WINDOW_MS) return true;
  return entry.count < max;
}

function recordIpVerification(ip) {
  const now = Date.now();
  const entry = ipVerifyLog.get(ip);
  if (!entry || now - entry.windowStart > IP_WINDOW_MS) {
    ipVerifyLog.set(ip, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

function validateDescriptor(descriptor) {
  return Array.isArray(descriptor) &&
    descriptor.length === 128 &&
    descriptor.every(v => typeof v === 'number' && Number.isFinite(v) && v > -2.0 && v < 2.0);
}

async function computeFaceMapHash(descriptor) {
  // Must match face-verify.ts: quantize (QUANT_BIN=0.1) then hash
  const quantized = descriptor.map(v => Math.round(v / 0.1) * 0.1);
  const str = quantized.map(v => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(str);
  const buf = await globalThis.crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** The attester's engine keypair (hex). Used to sign engine personhood attestations. */
async function loadOrCreateAttesterKey() {
  try {
    const saved = JSON.parse(await fs.readFile(ATTESTER_KEY_FILE, 'utf8'));
    if (saved.priv) {
      console.log('[Attester] Loaded existing attester key');
      return { priv: saved.priv, pub: enginePublicKeyFromPrivate(saved.priv) };
    }
  } catch { /* generate below */ }
  const priv = bytesToHex(randomBytes(32));
  const pub = enginePublicKeyFromPrivate(priv);
  await atomicWrite(ATTESTER_KEY_FILE, JSON.stringify({ priv }), 0o600); // private key — owner-only
  console.log('[Attester] Generated new attester key');
  return { priv, pub };
}

async function loadOrCreateSigningKey() {
  try {
    const saved = JSON.parse(await fs.readFile(SIGNING_KEY_FILE, 'utf8'));
    const privKey = await globalThis.crypto.subtle.importKey(
      'jwk', saved.private, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
    );
    const pubKeyStr = Buffer.from(JSON.stringify(saved.public)).toString('base64');
    console.log('[FaceVerify] Loaded existing signing key');
    return { privKey, pubKeyStr };
  } catch {
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    );
    const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
    const publicJwk  = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    await atomicWrite(SIGNING_KEY_FILE, JSON.stringify({ private: privateJwk, public: publicJwk }), 0o600); // private key — owner-only
    console.log('[FaceVerify] Generated new signing key pair');
    return { privKey: pair.privateKey, pubKeyStr: Buffer.from(JSON.stringify(publicJwk)).toString('base64') };
  }
}

async function signFaceMapHash(faceMapHash, privKey) {
  const encoded = new TextEncoder().encode(faceMapHash);
  const sigBytes = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, encoded);
  const b64sig = Buffer.from(sigBytes).toString('base64');
  return JSON.stringify({ d: faceMapHash, s: b64sig });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65536) reject(new Error('Request too large'));
    });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── Persistent peer ID ────────────────────────────────────────────────────────

async function loadOrCreatePrivKey() {
  try {
    const saved = JSON.parse(await fs.readFile(PEER_ID_FILE, 'utf8'));
    return privateKeyFromRaw(Buffer.from(saved.raw, 'base64'));
  } catch {
    const key = await generateKeyPair('Ed25519');
    await atomicWrite(PEER_ID_FILE, JSON.stringify({
      raw: Buffer.from(key.raw).toString('base64'),
    }), 0o600); // private key — owner-only
    console.log(`[Relay] Generated new peer ID: ${peerIdFromPrivateKey(key).toString()}`);
    return key;
  }
}

// ── Start relay ───────────────────────────────────────────────────────────────

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const privKey = await loadOrCreatePrivKey();
  const peerId = peerIdFromPrivateKey(privKey);
  const signingKey = await loadOrCreateSigningKey();
  const attester = await loadOrCreateAttesterKey();
  console.log(`[Attester] personhood attester pub: ${attester.pub.slice(0, 16)}…`);
  await loadFaceDB();
  await loadUsernames();
  await loadOperators();
  await loadGeneration();
  if (ARCHIVE_ENABLED) { await loadEngineBlocks(); await loadKeyBlobs(); await loadAccounts(); }

  // relayAddrs is populated after node.start(); empty until then (relay-info returns [] multiaddrs)
  let relayAddrs = [];

  // ── HTTP server (started BEFORE libp2p so face-verify works even if ports conflict) ──

  const httpServer = createServer(async (req, res) => {
    // CORS preflight for face-verify endpoints
    if (req.url?.startsWith('/face-verify')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      // Must include x-network: the client sends it on /face-verify requests, so a
      // cross-origin attestation (to a SECOND relay) preflights against this list.
      // Omitting it silently blocks cross-relay face-verify → only 1 attester (B4).
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-network');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    try {
      if (req.url === '/relay-info') {
        // Always 200 so the HTTP face-verify fallback (which only needs signingPub) works
        // even before — or without — libp2p. `ready` reports whether the p2p layer is
        // dialable yet (relayAddrs populated after node.start()); p2p clients retry while
        // it's false instead of caching an empty multiaddr list, and monitoring can use it
        // to detect a relay whose p2p layer never came up.
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          ready: relayAddrs.length > 0,
          peerId: peerId.toString(),
          multiaddrs: relayAddrs,
          wsPort: PORT,
          signingPub: signingKey.pubKeyStr,
          faceVerifyUrl: '',
          operators,                    // first-N accountIds allowed to reset
          generation: currentGeneration, // current reset epoch (clients converge to it)
        }));

      } else if (req.url?.startsWith('/resolve?')) {
        // G1 on-demand directory lookup: GET /resolve?username=<u>|pub=<p>&network=<n>
        // Plain GET + query params (no custom headers) so browsers need no CORS
        // preflight against the bare-IP dev relays. The served record is
        // self-certifying — the client verifies its signature, so this endpoint
        // is untrusted and needs no auth.
        const q = new URL(req.url, 'http://localhost').searchParams;
        const network = q.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
        const pub = q.get('pub');
        const uname = q.get('username')?.trim().toLowerCase();
        let record = null;
        if (pub) {
          record = accountStore.get(`${network}:${pub}`) || null;
        } else if (uname) {
          // The attested username registry is the authoritative name→account map
          // (first-attested wins); fall back to scanning the record archive for
          // accounts this relay stored but did not itself attest.
          const claim = usernameRegistry.get(uname);
          if (claim && claim.accountId) record = accountStore.get(`${network}:${claim.accountId}`) || null;
          if (!record) {
            for (const r of accountStore.values()) {
              if (r.network === network && String(r.username).toLowerCase() === uname) { record = r; break; }
            }
          }
        }
        res.writeHead(record ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        if (record) {
          const { network: _n, ...clean } = record;
          res.end(JSON.stringify(clean));
        } else {
          res.end(JSON.stringify({ error: 'not found' }));
        }

      } else if (req.url?.startsWith('/block?')) {
        // Explorer block lookup by hash from the archive. Post-G1/G2 a node's
        // local view is interest-scoped, so a searched TX is often not held
        // locally — the archive tier answers instead. The block is
        // self-certifying (account-signed, content-hashed): the client
        // re-verifies it, so this endpoint is untrusted display data.
        const q = new URL(req.url, 'http://localhost').searchParams;
        const network = q.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
        const row = engineBlockStore.get(String(q.get('hash') || ''));
        const found = row && row.network === network;
        res.writeHead(found ? 200 : 404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(found ? { blockHex: row.blockHex } : { error: 'not found' }));

      } else if (req.url?.startsWith('/head-proof?')) {
        // G2: serve a counterparty proof packet for one transfer, built from
        // the archived chain — { open, head, send } blocks (hex) + RFC-6962
        // audit paths tying open (leaf 0) and the send into the head's
        // accumulator root. The recipient verifies everything against the
        // sender's own signatures, claims, and holds NOTHING of the chain —
        // O(log n) instead of the O(n) chain pull. Untrusted endpoint: a bad
        // packet simply fails client verification.
        const q = new URL(req.url, 'http://localhost').searchParams;
        const network = q.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
        const pub = String(q.get('pub') || '');
        const send = String(q.get('send') || '');
        const rows = [...engineBlockStore.values()]
          .filter(r => r.accountId === pub && r.network === network)
          .sort((a, b) => a.index - b.index);
        // The proof needs the FULL contiguous chain 0..head (the accumulator
        // commits every leaf). Forked/gappy archives refuse — the client falls
        // back to the chain-pull path, where conflicts surface as evidence.
        const contiguous = rows.length > 0 && rows.every((r, i) => r.index === i);
        const sendRow = rows.find(r => r.hash === send);
        if (!contiguous || !sendRow) {
          res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'chain incomplete or send unknown' }));
        } else {
          const acc = new AccountAccumulator();
          for (const r of rows) acc.append(r.hash);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            openHex: rows[0].blockHex,
            headHex: rows[rows.length - 1].blockHex,
            sendHex: sendRow.blockHex,
            openProof: acc.proofHex(0),
            sendProof: acc.proofHex(sendRow.index),
          }));
        }

      } else if (req.url?.startsWith('/pending-sends?')) {
        // G1 follow-up — offline-transfer discovery. A recipient that was
        // offline (or fully wiped + recovered) asks the archive which send /
        // nft-send blocks are addressed to it, then pulls each sender's chain
        // via the normal delta path. This replaces the accidental discovery the
        // old O(N) accounts firehose provided ("every node knew every account,
        // so the startup refresh pulled every chain"). Interest-scoped: the
        // answer is O(that account's inbound), and it is only a HINT — the
        // client fully verifies the pulled chains, so a lying relay can at
        // worst waste a delta request. Claimed sends are filtered client-side
        // (the recipient already holds those blocks).
        const q = new URL(req.url, 'http://localhost').searchParams;
        const network = q.get('network') === 'mainnet' ? 'mainnet' : 'testnet';
        const pub = q.get('pub');
        const sends = [];
        // The archive's highest index for the ASKING account. The client must
        // not claim (append to its own chain) while its local head is behind
        // this — claiming on a stale head forks the claimant's own chain into
        // self-signed equivocation evidence (bob's idx-5/6 fork, 2026-08-09:
        // a wiped-recovery claimed before its own chain finished syncing).
        let headIndex = -1;
        if (pub) {
          for (const r of engineBlockStore.values()) {
            if (r.network !== network) continue;
            if (r.accountId === pub && r.index > headIndex) headIndex = r.index;
            let type = r.type;
            let recipient = r.recipient;
            if (type === undefined) {
              // Row predates the denormalized fields — decode once and backfill.
              try {
                const b = decodeBlock(hexToBytes(r.blockHex));
                type = r.type = b.type;
                recipient = r.recipient = b.recipient;
                engineStoreDirty = true;
              } catch { continue; }
            }
            if ((type === 'send' || type === 'nft-send') && recipient === pub) {
              sends.push({ sender: r.accountId, blockHash: r.hash, shard: r.shard, type });
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ headIndex, sends }));

      } else if (req.method === 'POST' && req.url === '/log-reload') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          const line = `[${new Date().toISOString()}] ${body.trim()}\n`;
          await fs.appendFile(RELOAD_LOG_FILE, line).catch(() => {});
          res.writeHead(204);
          res.end();
        });

      } else if (req.method === 'POST' && req.url === '/face-verify/challenge') {
        const ip = getClientIp(req);
        const network = req.headers['x-network'] === 'mainnet' ? 'mainnet' : 'testnet';
        if (!checkIpLimit(ip, network)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Rate limit: max ${IP_MAX_PER_DAY[network]} verifications per IP per 24h` }));
          return;
        }
        const challenge = issueChallenge(ip);
        console.log(`[FaceVerify] Challenge issued: type=${challenge.type} ip=${ip}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(challenge));

      } else if (req.method === 'POST' && req.url === '/face-verify/verify') {
        const ip = getClientIp(req);
        let body;
        try { body = await readJsonBody(req); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message })); return;
        }
        const { descriptor, faceMapHash, accountId, challengeId } = body;
        if (!accountId || typeof accountId !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'accountId (engine pubkey) required' })); return;
        }
        // Username uniqueness is checked BY HUMAN below (after the face match gives us
        // the nid), not by throwaway accountId — so an abandoned attempt can't orphan
        // the name. Just capture it here.
        const username = String(body.username || '').trim().toLowerCase();

        // Derive the Map key once and use it for every lookup/delete so they can't diverge
        // (set/get/delete must agree, else a used or expired session leaks and survives).
        const sessionKey = String(challengeId || '');
        const session = challengeSessions.get(sessionKey);
        if (!session) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid or expired challengeId' })); return;
        }
        if (session.used) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'challengeId already used' })); return;
        }
        if (Date.now() - session.createdAt > CHALLENGE_TTL_MS) {
          challengeSessions.delete(sessionKey);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Challenge expired' })); return;
        }
        if (!validateDescriptor(descriptor)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'descriptor must be 128 finite numbers in (-2, 2)' })); return;
        }
        const expectedHash = await computeFaceMapHash(descriptor);
        if (expectedHash !== String(faceMapHash || '')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'faceMapHash does not match descriptor' })); return;
        }
        const network = req.headers['x-network'] === 'mainnet' ? 'mainnet' : 'testnet';
        if (!checkIpLimit(ip, network)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Rate limit: max ${IP_MAX_PER_DAY[network]} verifications per IP per 24h` })); return;
        }
        const faceMax = FACE_MAX[network];

        // Fuzzy face match: find the closest stored descriptor within FACE_MATCH_THRESHOLD.
        // Hash-based counting is unreliable because face descriptors shift between sessions
        // (lighting, angle) causing quantization bin flips and different hashes for the same face.
        const matchedFace = findMatchingFace(descriptor, network);
        const faceCount = matchedFace ? matchedFace.count : 0;
        if (faceCount >= faceMax) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Face limit reached (${faceCount}/${faceMax} on ${network})` })); return;
        }

        // STABLE per-human id (nid) for this face — assigned once, before any state is
        // consumed, so the username check below is by-human.
        let nid;
        if (matchedFace) {
          if (!matchedFace.nid) matchedFace.nid = randomUUID();
          nid = matchedFace.nid;
        } else {
          nid = randomUUID();
        }

        // Username uniqueness BY HUMAN: the name belongs to a face (nid), not a
        // throwaway accountId. The SAME human may (re)claim it — a retry or a new
        // account — but a DIFFERENT human is rejected. This stops an abandoned attempt
        // (e.g. one that failed the 2-attester quorum client-side) from orphaning the
        // name and permanently blocking the retry.
        if (username) {
          const existing = usernameRegistry.get(username);
          if (existing && existing.nid && existing.nid !== nid) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'username taken' })); return;
          }
        }

        // All checks passed — now consume the session + commit the face.
        session.used = true;
        recordIpVerification(ip);
        if (matchedFace) {
          matchedFace.count++;
          // Update centroid so future sessions compare against a current reference.
          for (let i = 0; i < 128; i++) {
            matchedFace.descriptor[i] = (matchedFace.descriptor[i] + descriptor[i]) / 2;
          }
        } else {
          faceDescriptorDB.push({ descriptor: Array.from(descriptor), count: 1, network, nid });
        }
        await saveFaceDB();

        // Issue an ENGINE attestation: sign a personhood claim over the identity
        // commitment that binds this human (nullifier) to this account (accountId).
        // The per-account nullifier is `<nid>#<index>`, so up to faceMax accounts per
        // face get distinct, globally-unique nullifiers (testnet=3; mainnet=1).
        //
        // Multi-attester (k-of-N): every attester has its OWN face DB, so its own nid —
        // but the engine verifies all attestations against ONE commitment derived from
        // the block's single nullifier. Attester #1's nullifier is therefore the
        // ANCHOR: the client forwards it and subsequent attesters countersign THAT
        // commitment (all face/limit/username checks above still ran against OUR db).
        // Trust note: the anchor is client-supplied, so engine-side nullifier dedup is
        // only as strong as each attester's own face limit — acceptable while the
        // global commitment registry (ARCHITECTURE.md Subsystem 5) is deferred.
        const anchor = typeof body.nullifier === 'string' && /^[0-9a-f-]{1,64}#\d{1,4}$/i.test(body.nullifier)
          ? body.nullifier : undefined;
        const nullifier = anchor ?? `${nid}#${faceCount}`;
        const commitment = deriveCommitment(nullifier, accountId);
        const attestation = createAttestation('personhood', commitment, { pub: attester.pub, priv: attester.priv });
        console.log(`[Attester] personhood attestation acct=${accountId.slice(0, 12)}… face=${faceCount + 1}/${faceMax} (${matchedFace ? 'matched' : 'new'})${anchor ? ' [countersigned anchor nullifier]' : ''}`);
        pendingFaceUses.set(accountId, { nid, username, at: Date.now(), network });   // released if no open block follows
        if (username) { usernameRegistry.set(username, { accountId, nid }); usernameDirty = true; } // claim for this human
        recordOperator(accountId); // first OPERATOR_COUNT attested accounts become operators
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nullifier, attestation, attesterPub: attester.pub }));

      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (e) {
      console.error('[FaceVerify] HTTP error:', e);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    }
  });

  // ── Smoke Hub ──────────────────────────────────────────────────────────────
  const smokeHubWss = new WebSocketServer({ noServer: true });
  const smokeHubPeers = new Map();

  smokeHubWss.on('connection', (ws) => {
    let address = null;
    const keepAlive = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 15_000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!address && msg.type === 'register' && typeof msg.address === 'string') {
          address = msg.address;
          smokeHubPeers.set(address, ws);
          console.log(`[SmokeHub] Peer registered: ${address.slice(0, 8)}...`);
          return;
        }
        if (address && typeof msg.to === 'string' && smokeHubPeers.has(msg.to)) {
          const target = smokeHubPeers.get(msg.to);
          if (target.readyState === 1) target.send(JSON.stringify({ ...msg, from: address }));
        }
      } catch { /* ignore malformed */ }
    });
    ws.on('close', () => {
      clearInterval(keepAlive);
      if (address) { smokeHubPeers.delete(address); console.log(`[SmokeHub] Peer disconnected: ${address.slice(0, 8)}...`); address = null; }
    });
  });

  httpServer.on('upgrade', (req, socket, head) => {
    if (req.url === '/smoke-hub') {
      smokeHubWss.handleUpgrade(req, socket, head, (ws) => { smokeHubWss.emit('connection', ws, req); });
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT + 2, () => console.log(`[Relay] HTTP/face-verify server listening on port ${PORT + 2}`));

  // ── Start libp2p node ────────────────────────────────────────────────────────
  // Wrapped in try/catch: if libp2p fails (e.g. EADDRINUSE) the HTTP face-verify
  // server stays alive so clients can still get relay credentials.

  let node;
  try {
    node = await createLibp2p({
      privateKey: privKey,
      addresses: {
        listen: [
          `/ip4/0.0.0.0/tcp/${PORT}/ws`,
          `/ip4/0.0.0.0/tcp/${PORT + 1}`,
        ],
      },
      transports: [
        // Patch dialFilter so the relay can DIAL another relay's nginx-fronted
        // address (`/dns4/host/tcp/443/wss/http-path/relay-ws/...`). The default
        // webSockets dialFilter uses exactMatch and rejects `http-path` multiaddrs,
        // which breaks relay-to-relay federation across separate boxes (each peer is
        // reached through nginx/TLS). Mirrors the browser transport patch.
        (() => {
          const factory = webSockets();
          return (components: Parameters<typeof factory>[0]) => {
            const t = factory(components);
            (t as unknown as Record<string, unknown>).dialFilter =
              (mas: import('@multiformats/multiaddr').Multiaddr[]) =>
                mas.filter(ma => WsMatcher.matches(ma) || WssMatcher.matches(ma));
            return t;
          };
        })(),
        tcp(),
      ],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, runOnLimitedConnection: true }),
        identify: identify(),
        ping: ping(),
        relay: circuitRelayServer({
          // Allow browsers to use this node as a relay
          reservations: {
            maxReservations: 1024,
            reservationTtl: 2 * 60 * 60 * 1000, // 2h
            // Default data limit is 128 KB per circuit - raise it so large content
            // transfers (signaling, libp2p protocol messages) can complete freely.
            defaultDataLimit: BigInt(1 << 30), // 1 GB per circuit
            // Default duration limit is 2 minutes - raise it for long-running sessions.
            // Set to 1 hour so smoke WebRTC sessions don't get cut off mid-transfer.
            defaultDurationLimit: 60 * 60 * 1000, // 1 hour in ms
          },
        }),
        dht: kadDHT({
          // Server mode - participates in DHT routing
          clientMode: false,
          kBucketSize: 20,
        }),
      },
    });

    await node.start();
  } catch (e) {
    console.error('[Relay] libp2p failed to start — HTTP/face-verify server remains available:', e.message);
    return; // main() resolves normally; httpServer keeps the process alive
  }

  // ── Server-side keepalive pings ───────────────────────────────────────────
  // Ping all connected peers every 10s so the WebSocket TCP connections stay
  // alive through NAT. Both sides must push bytes — the browser pings the relay
  // and the relay pings the browser. Without server-side pings, an idle browser
  // tab that sends no libp2p traffic loses its NAT mapping anyway.
  const pingService = node.services.ping;
  if (pingService) {
    setInterval(() => {
      for (const conn of node.getConnections()) {
        try { pingService.ping(conn.remotePeer).catch(() => {}); } catch { /* conn closed mid-loop */ }
      }
    }, 10_000);
  }

  // ── Relay-to-relay mesh ───────────────────────────────────────────────────
  // Dial each peer relay from PEER_RELAYS so their GossipSub meshes merge.
  // Without this, browsers on relay-A and browsers on relay-B are in separate
  // GossipSub islands and cannot see each other's messages.
  if (PEER_RELAYS.length > 0) {
    const { multiaddr } = await import('@multiformats/multiaddr');

    async function dialPeerRelays() {
      const connected = new Set(node.getConnections().map(c => c.remotePeer.toString()));
      for (const addr of PEER_RELAYS) {
        // Extract peer ID from the /p2p/<id> suffix to check active connections
        const peerIdMatch = addr.match(/\/p2p\/([^/]+)$/);
        const peerId = peerIdMatch?.[1];
        if (peerId && connected.has(peerId)) continue;
        try {
          await node.dial(multiaddr(addr));
          console.log(`[Relay] Connected to peer relay: ${addr}`);
        } catch (e) {
          console.warn(`[Relay] Could not reach peer relay ${addr}: ${e.message}`);
        }
      }
    }

    await dialPeerRelays();
    // Reconnect loop: re-dial dropped peer relays every 60s
    setInterval(dialPeerRelays, 60_000);
  }

  // ── GossipSub routing ─────────────────────────────────────────────────────
  // The relay participates in GossipSub so it can route messages between
  // browser peers that are only connected to the relay (not directly to each
  // other).  Without this, Browser A publishes → relay ignores it → Browser B
  // never receives it.

  const pubsub = node.services.pubsub;
  const NUM_SYNAPSES = 4;

  // G2: the archive is where same-height forks are noticed once recipients stop
  // holding sender chains — arm the conflict publisher (see indexEngineRow).
  publishConflict = (network, shard, aHex, bHex) => {
    const topic = `neuronchain/${PROTOCOL_VERSION}/${network}/engine-conflict/${shard}`;
    pubsub.publish(topic, new TextEncoder().encode(JSON.stringify({ a: aHex, b: bHex }))).catch(() => {});
  };

  // Prototype-level fix applied at module load (see top of file).
  // AbstractMessageStream.prototype now has .source and .sink so it-pipe
  // treats every stream as a duplex and gossipsub outbound streams form correctly.

  for (const network of ['testnet', 'mainnet']) {
    const pfx = `neuronchain/${PROTOCOL_VERSION}/${network}`;
    for (let i = 0; i < NUM_SYNAPSES; i++) pubsub.subscribe(`${pfx}/blocks/${i}`);
    pubsub.subscribe(`${pfx}/votes`);
    pubsub.subscribe(`${pfx}/accounts`);
    pubsub.subscribe(`${pfx}/generation`);
    pubsub.subscribe(`${pfx}/storage/cache-requests`);
    pubsub.subscribe(`${pfx}/storage/receipts`);
    pubsub.subscribe(`${pfx}/storage/delete-requests`);
    pubsub.subscribe(`${pfx}/lockouts`);
    pubsub.subscribe(`${pfx}/keyblobs`);
    pubsub.subscribe(`${pfx}/blob-requests`);
    pubsub.subscribe(`${pfx}/peer-addrs`);
    pubsub.subscribe(`${pfx}/relays`);
    pubsub.subscribe(`${pfx}/snapshots`);
  }
  // NOTE: dynamic topics (engine-blocks/{shard}, engine-delta-req/{shard},
  // inbox/{pubShort}) are forwarded by the subscription-change mirror further
  // below — the relay subscribes to whatever its peers subscribe to.

  // ── Peer-addr cache and replay ────────────────────────────────────────────
  // Problem: when Browser A publishes peer-addrs, Browser B may not be in the
  // relay's GossipSub mesh yet (mesh formation takes 1–3 gossipsub heartbeats).
  // Solution: the relay caches the latest peer-addrs per sender and replays
  // them to new subscribers + re-publishes after a short delay when received
  // so that peers who join the mesh slightly late still receive the addrs.

  // peerId → { topic, data: Uint8Array, timestamp: number }
  // Keyed by peerId (not topic:peerId) so we can filter by connection status.
  const peerAddrCache = new Map();
  // topic → setTimeout handle (debounce)
  const rebroadcastTimers = new Map();

  /** Return Set of peer ID strings currently connected to this relay. */
  function connectedPeerIds() {
    return new Set(node.getConnections().map(c => c.remotePeer.toString()));
  }

  /**
   * Re-broadcast all cached peer-addrs for `topic`, but ONLY for peers that are
   * currently connected to this relay. Stale entries from previous browser sessions
   * (which would cause NO_RESERVATION errors) are silently skipped.
   */
  function scheduleRebroadcast(topic, delayMs) {
    if (rebroadcastTimers.has(topic)) return;
    rebroadcastTimers.set(topic, setTimeout(() => {
      rebroadcastTimers.delete(topic);
      const connected = connectedPeerIds();
      const now = Date.now();
      let sent = 0;
      for (const [peerId, cached] of peerAddrCache) {
        if (cached.topic === topic &&
            now - cached.timestamp < 3 * 60 * 1000 && // 3-min TTL
            connected.has(peerId)) {
          pubsub.publish(topic, cached.data).catch(() => {});
          sent++;
        }
      }
    }, delayMs));
  }

  // Slice 4a: serve an archived account's chain tail on a delta request.
  function serveEngineDeltaFromArchive(accountId, haveIndex, shard, network) {
    if (!ARCHIVE_ENABLED) return;
    const topic = `neuronchain/${PROTOCOL_VERSION}/${network}/engine-blocks/${shard}`;
    const matches = [...engineBlockStore.values()]
      .filter(r => r.accountId === accountId && r.network === network && r.index > haveIndex)
      .sort((a, b) => a.index - b.index);
    for (const r of matches) {
      pubsub.publish(topic, new TextEncoder().encode(JSON.stringify({ blockHex: r.blockHex }))).catch(() => {});
    }
    // Log every request (even 0) so we can tell "request never arrived" from
    // "archive had nothing for this account".
    dlog(`[Archive] Delta req acct=${accountId.slice(0, 12)}… shard=${shard} have=${haveIndex} → served ${matches.length}/${engineBlockStore.size}`);
  }

  // Serve a recovery blob-request from the key-blob archive (newest per username).
  function serveKeyBlobFromArchive(username, network) {
    if (!ARCHIVE_ENABLED) return;
    let best = null;
    for (const b of keyBlobStore.values()) {
      if (b.username === username && b.network === network && (!best || blobTs(b) > blobTs(best))) best = b;
    }
    if (!best) return;
    const { network: _n, ...blob } = best;
    pubsub.publish(`neuronchain/${PROTOCOL_VERSION}/${network}/keyblobs`,
      new TextEncoder().encode(JSON.stringify(blob))).catch(() => {});
    dlog(`[Archive] Served key-blob user=${username}`);
  }

  pubsub.addEventListener('message', (evt) => {
    const msg = evt.detail;
    const topic = msg.topic;

    // Super-node archival: store every engine block we see (Slice 4a).
    if (topic.includes('/engine-blocks/')) {
      try { archiveEngineBlock(JSON.parse(new TextDecoder().decode(msg.data)).blockHex, networkFromTopic(topic)); } catch { /* malformed */ }
      return;
    }
    // G1 directory tier: archive account records so clients can resolve
    // usernames on demand (/resolve) instead of ingesting the global topic.
    if (topic.endsWith('/accounts')) {
      try { archiveAccountRecord(JSON.parse(new TextDecoder().decode(msg.data)), networkFromTopic(topic)); } catch { /* malformed */ }
      return;
    }
    // Archive key-blobs so recovery works with no peer online (face+PIN-encrypted).
    if (topic.endsWith('/keyblobs')) {
      try { archiveKeyBlob(JSON.parse(new TextDecoder().decode(msg.data)), networkFromTopic(topic)); } catch { /* malformed */ }
      return;
    }
    // Serve a recovery blob-request from the archive.
    if (topic.endsWith('/blob-requests')) {
      try {
        const d = JSON.parse(new TextDecoder().decode(msg.data));
        if (d.username) serveKeyBlobFromArchive(String(d.username), networkFromTopic(topic));
      } catch { /* malformed */ }
      return;
    }
    // Serve delta requests from the archive (durable shard holder).
    if (topic.includes('/engine-delta-req/')) {
      try {
        const d = JSON.parse(new TextDecoder().decode(msg.data));
        if (d.accountId && typeof d.shard === 'number') {
          serveEngineDeltaFromArchive(d.accountId, typeof d.haveIndex === 'number' ? d.haveIndex : -1, d.shard, networkFromTopic(topic));
        }
      } catch { /* malformed */ }
      return;
    }
    // Wipe the relay's data ONLY on a reset signed by an operator (one of the
    // first OPERATOR_COUNT accounts). Any other account's reset is ignored — a
    // stray browser can't nuke the shared super-node.
    if (topic.endsWith('/generation')) {
      try {
        if (networkFromTopic(topic) !== 'testnet') return; // reset is testnet-only
        const m = JSON.parse(new TextDecoder().decode(msg.data));
        if (typeof m.resetAt !== 'number') return;
        const ok = m.operatorPub && operators.includes(m.operatorPub) &&
          engineVerify(String(m.signature || ''), `reset:${m.generation}:${m.resetAt}`, m.operatorPub);
        if (!ok) { console.log('[Archive] Ignored reset — not an authorized operator'); return; }
        engineBlockStore.clear(); engineStoreDirty = true;
        engineHeightIndex.clear(); conflictAnnounced.clear(); // conflict index follows the archive
        keyBlobStore.clear(); keyBlobDirty = true;
        usernameRegistry.clear(); usernameDirty = true;       // free the names
        accountStore.clear(); accountsDirty = true;           // wipe the directory too
        // Face SLOTS count accounts, and this wipe just destroyed every account —
        // so a surviving count bars a human on the basis of accounts that no
        // longer exist. Zero the counts, but KEEP each descriptor + nid: the same
        // human must still map to the same nullifier identity across a reset, or
        // the whole one-human-one-account property resets with the chain.
        for (const e of faceDescriptorDB) e.count = 0;
        pendingFaceUses.clear();                              // provisional holds are moot now
        saveFaceDB().catch(() => {});
        // Re-elect operators: the wipe destroys every account chain AND every
        // key-blob, so the old operator accountIds can never be recovered by
        // anyone — keeping them as the sole reset authority makes the FIRST
        // network reset a one-way door (no live account can authorize the next
        // one; only SSH can). The next OPERATOR_COUNT accounts attested after a
        // wipe become the operators, exactly as on a fresh relay.
        operators = []; atomicWrite(OPERATORS_FILE, JSON.stringify(operators));
        currentGeneration = Number(m.generation) || currentGeneration + 1;
        atomicWrite(GENERATION_FILE, JSON.stringify(currentGeneration));
        console.log(`[Archive] WIPED by operator ${String(m.operatorPub).slice(0, 12)}… → generation ${currentGeneration}`);
      } catch { /* malformed */ }
      return;
    }

    if (!topic.endsWith('/peer-addrs')) return;
    try {
      const decoded = JSON.parse(new TextDecoder().decode(msg.data));
      if (decoded.peerId && Array.isArray(decoded.addrs) && decoded.addrs.length > 0) {
        peerAddrCache.set(decoded.peerId, {
          topic: msg.topic,
          data: msg.data,
          timestamp: Date.now(),
        });
        // Re-broadcast after 1.5s so peers that joined the mesh slightly late
        // (GossipSub mesh formation takes up to ~2 heartbeats) still receive it.
        scheduleRebroadcast(msg.topic, 1500);
      }
    } catch { /* malformed - ignore */ }
  });

  // Dynamically mirror any neuronchain topic a browser peer subscribes to
  // (covers dynamic inbox topics like neuronchain/v1/{network}/inbox/{pubShort}).
  // Also replays cached peer-addrs when a new peer subscribes to a peer-addrs topic.
  pubsub.addEventListener('subscription-change', (evt) => {
    for (const { topic, subscribe } of evt.detail.subscriptions) {
      if (subscribe && topic.startsWith(`neuronchain/${PROTOCOL_VERSION}/`)) {
        try { pubsub.subscribe(topic); } catch { /* already subscribed */ }
      }
      if (subscribe && topic.endsWith('/peer-addrs')) {
        // New subscriber - replay cached peer-addrs (for currently-connected peers only)
        // after a delay so the GossipSub stream and mesh have time to fully form.
        setTimeout(() => {
          const connected = connectedPeerIds();
          const now = Date.now();
          let replayed = 0;
          for (const [peerId, cached] of peerAddrCache) {
            if (cached.topic === topic &&
                now - cached.timestamp < 3 * 60 * 1000 &&
                connected.has(peerId)) {
              pubsub.publish(topic, cached.data).catch(() => {});
              replayed++;
            }
          }
        }, 2000);
      }
    }
  });

  // Populate relay addresses now that node is up
  relayAddrs = node.getMultiaddrs().map(a => a.toString());

  // ── Graceful shutdown ─────────────────────────────────────────────────────

  const shutdown = async () => {
    httpServer.close();
    await node.stop();
    process.exit(0);
  };

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[Relay] Unhandled error in main():', err);
  // Do NOT process.exit — the HTTP face-verify server may still be alive and serving clients.
});
