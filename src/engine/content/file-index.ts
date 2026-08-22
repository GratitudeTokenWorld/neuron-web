/**
 * The file index, stopped from being global.
 *
 * Every node used to hold a record for every file on the network: announcements
 * went to one `files` gossip topic, every node ingested them, and every node
 * persisted the lot to IndexedDB. That is `O(total files)` per node — the same
 * shape as G1's `accounts` topic and G3's `keyblobs` topic, and the last one left
 * in storage.
 *
 * The replacement is the shape those two settled on: **hold your own, ask about
 * everyone else's, verify the answer.**
 *
 *   - A node keeps records for the files it OWNS. That set is bounded by the
 *     node's own behaviour, which is what the invariant asks for.
 *   - Archives keep the rest — the tier that is allowed to be big
 *     (ARCHITECTURE.md → Fan-IN, principle 4) — and answer `GET /files`.
 *   - Every answer is the UPLOADER's own signed record, so an archive can choose
 *     which real records to show but cannot invent a file, misreport its size, or
 *     attribute it to someone else. Asking several archives takes the union, and
 *     no particular archive is load-bearing.
 *
 * Why an archive query rather than the DHT provider records ARCHITECTURE.md's
 * Subsystem 4 sketches: the same reason G1 and G3 chose it. `kadDHT` in this
 * build is client-mode only and unused for content, so "use the DHT" is a
 * transport project, not an index one — while the verified-archive-query path is
 * already built, deployed and probe-tested. The DHT remains the better long-term
 * answer for *provider* records (who holds these bytes); this module is about
 * *file* records (what these bytes are), which is the half a query answers well.
 *
 * Everything here is pure, and signature verification is INJECTED rather than
 * imported so the relay and the browser can each verify with what they have,
 * against one shared definition of what the payload is.
 *
 * Records are signed with the account's ENGINE key and verified against its
 * engine id — the same `026…` compressed-hex identity the ledger uses. They were
 * briefly signed with the app's WebCrypto JWK key while `uploaderPub` on the
 * wire was already engine hex, which no verifier could reconcile: every
 * announcement was dropped and the index stayed empty (2026-08-16). The payload
 * definitions below are unchanged by that; only the key format was ever wrong.
 */

import { MAX_OFFLINE_MS } from './provider-ledger.js';

/** A file announcement — the uploader's own signed claim about its own content. */
export interface FileRecord {
  cid: string;
  sizeBytes: number;
  mimeType?: string;
  timestamp: number;
  uploaderPub: string;
  /** Envelope from the app's `signData` over `fileAnnouncePayload`/`fileRemovePayload`. */
  signature: string;
  /** A tombstone: the uploader withdrew this file. */
  removed?: boolean;
}

/**
 * Records an archive will hold per query page, hard-capped.
 *
 * An unbounded answer is the global firehose delivered over HTTP — the exact
 * thing this module exists to stop — so the cap is not a performance tuning knob
 * but the property that keeps the fix a fix.
 */
export const FILE_QUERY_LIMIT_DEFAULT = 50;
export const FILE_QUERY_LIMIT_MAX = 200;

/**
 * How long a withdrawal is retained after the file is gone.
 *
 * Derived, not picked. A tombstone exists so a node still HOLDING the file
 * learns it was withdrawn — and a node absent for longer than its custody lease
 * discards every foreign byte on rejoin anyway (custody.ts → `planRejoin`), so
 * it never needs to be told about individual deletions. Tombstones therefore
 * only have to outlive the lease; twice `MAX_OFFLINE_MS` is that with margin.
 *
 * Without a bound the archive grows by one permanent row per deletion, forever —
 * `O(total deletions)`, which is the same shape as the violation this module
 * exists to remove, arriving by the back door.
 */
export const TOMBSTONE_RETAIN_MS = 2 * MAX_OFFLINE_MS;

/** Is this withdrawal old enough that no live holder could still need it? */
export function tombstoneExpired(r: FileRecord, now: number): boolean {
  return !!r.removed && now - r.timestamp > TOMBSTONE_RETAIN_MS;
}

/** The exact string a file announcement signs. Shared so signer and verifier cannot drift. */
export function fileAnnouncePayload(r: Pick<FileRecord, 'cid' | 'sizeBytes' | 'uploaderPub' | 'timestamp'>): string {
  return `file:${r.cid}:${r.sizeBytes}:${r.uploaderPub}:${r.timestamp}`;
}

/** The exact string a withdrawal signs. */
export function fileRemovePayload(cid: string, ownerPub: string, timestamp: number): string {
  return `file-remove:${cid}:${ownerPub}:${timestamp}`;
}

/** The payload a record claims to have signed, whichever kind it is. */
export function payloadFor(r: FileRecord): string {
  return r.removed
    ? fileRemovePayload(r.cid, r.uploaderPub, r.timestamp)
    : fileAnnouncePayload(r);
}

/**
 * Everything checkable without crypto. Run first: a malformed row must never
 * reach the verifier, and an archive should not store one at all.
 */
export function isWellFormedFileRecord(v: unknown): v is FileRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.cid !== 'string' || r.cid.length === 0 || r.cid.length > 256) return false;
  if (typeof r.uploaderPub !== 'string' || r.uploaderPub.length === 0) return false;
  if (typeof r.signature !== 'string' || r.signature.length === 0) return false;
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp) || r.timestamp <= 0) return false;
  if (typeof r.sizeBytes !== 'number' || !Number.isFinite(r.sizeBytes) || r.sizeBytes < 0) return false;
  if (r.mimeType !== undefined && typeof r.mimeType !== 'string') return false;
  if (r.removed !== undefined && typeof r.removed !== 'boolean') return false;
  return true;
}

export interface FileQuery {
  /** Exactly this CID. */
  cid?: string;
  /** Everything a given account published. */
  owner?: string;
  /**
   * Return ONLY withdrawals. This is how a provider learns that content it
   * holds was deleted: a delete request is one fire-and-forget gossip message,
   * so a provider that was offline — or that rejected it — keeps the bytes
   * forever, and once the owner has removed its own record nothing can ever
   * retract them.
   *
   * Bounded without needing a cursor: tombstones only exist inside
   * `TOMBSTONE_RETAIN_MS`, so this is the set of RECENT withdrawals, not a
   * history. That makes the sweep `O(recent deletions)` rather than
   * `O(CIDs held)`, which is what lets a provider ask about everything it holds
   * in a single request.
   */
  withdrawn?: boolean;
  limit?: number;
}

/**
 * Live files among these records — tombstones excluded.
 *
 * What "how many files are there?" means. A withdrawn file is not a file, and
 * counting rows instead of files reported four files on a network that had none
 * (all four were my own probe's withdrawals — found by Lucian, 2026-08-16). The
 * archive keeps the tombstone deliberately; it just is not a file.
 */
export function countLiveFiles(records: Iterable<FileRecord>): number {
  const newest = new Map<string, FileRecord>();
  for (const r of records) {
    if (!isWellFormedFileRecord(r)) continue;
    const prev = newest.get(r.cid);
    if (!prev || r.timestamp > prev.timestamp) newest.set(r.cid, r);
  }
  let live = 0;
  for (const r of newest.values()) if (!r.removed) live++;
  return live;
}

/**
 * What an archive serves for a query, bounded and newest-first.
 *
 * Per CID only the newest record survives, so a withdrawal supersedes the
 * announcement it withdraws instead of both being served and the client picking
 * whichever arrived last. Tombstones are still returned — a client that already
 * holds the file has to learn it was withdrawn, and silence cannot say that.
 *
 * A query with neither `cid` nor `owner` is answered as a bounded sample, not as
 * "everything": the caller wanting a network-wide count gets `total` from the
 * endpoint rather than by paging the archive to exhaustion.
 *
 * **Tombstones are served only when asked for by `cid`.** A holder checking one
 * file must be able to learn it was withdrawn — silence cannot say that. But a
 * BROWSE must not spend its page budget on deletions, and this page is
 * newest-first while deletions are by definition the newest thing that happened:
 * on a busy network every page would be tombstones and no live file would ever
 * appear.
 */
export function selectFileRecords(records: Iterable<FileRecord>, query: FileQuery = {}): FileRecord[] {
  const limit = Math.min(
    Math.max(1, Math.floor(query.limit ?? FILE_QUERY_LIMIT_DEFAULT)),
    FILE_QUERY_LIMIT_MAX,
  );

  const newest = new Map<string, FileRecord>();
  for (const r of records) {
    if (!isWellFormedFileRecord(r)) continue;
    if (query.cid && r.cid !== query.cid) continue;
    if (query.owner && r.uploaderPub !== query.owner) continue;
    const prev = newest.get(r.cid);
    if (!prev || r.timestamp > prev.timestamp) newest.set(r.cid, r);
  }

  const page = query.withdrawn
    ? [...newest.values()].filter(r => !!r.removed)
    : [...newest.values()].filter(r => !r.removed || !!query.cid);
  return page
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
}

/**
 * CIDs whose newest VERIFIED record is a withdrawal.
 *
 * Separate from `foldFileRecords`, which drops tombstones on its way to "what
 * exists" — a provider needs the opposite question, "what did the owner take
 * back". Verification is not optional here: this set drives DELETION on the
 * holder, so an unverified tombstone would let anyone with a relay make
 * providers destroy content they were paid to keep.
 */
export async function verifiedWithdrawals(
  records: Iterable<FileRecord>,
  verify: (payload: string, pub: string, signature: string) => Promise<boolean> | boolean,
): Promise<Set<string>> {
  const newest = new Map<string, FileRecord>();
  for (const r of records) {
    if (!isWellFormedFileRecord(r)) continue;
    if (!(await verify(payloadFor(r), r.uploaderPub, r.signature))) continue;
    const prev = newest.get(r.cid);
    if (!prev || r.timestamp > prev.timestamp) newest.set(r.cid, r);
  }
  const out = new Set<string>();
  for (const [cid, r] of newest) if (r.removed) out.add(cid);
  return out;
}

/**
 * Verify a batch and fold it into a usable index.
 *
 * Unverifiable rows are dropped silently — one bad row in an archive must not
 * deny service for the good ones, and a client asking several archives is
 * expected to see junk from a broken one.
 *
 * `verify(payload, pub, signature)` returns whether the uploader signed exactly
 * that payload. Note the payload is RECONSTRUCTED here from the record's own
 * fields, never taken from the envelope: verifying whatever string the sender
 * happened to sign would prove only that they signed *something*, and a record
 * could then claim any size or CID it liked.
 *
 * Tombstones remove rather than insert, so a withdrawn file cannot be revived by
 * an archive that still holds the older announcement.
 */
export async function foldFileRecords(
  records: Iterable<FileRecord>,
  verify: (payload: string, pub: string, signature: string) => Promise<boolean> | boolean,
): Promise<Map<string, FileRecord>> {
  const newest = new Map<string, FileRecord>();
  for (const r of records) {
    if (!isWellFormedFileRecord(r)) continue;
    if (!(await verify(payloadFor(r), r.uploaderPub, r.signature))) continue;
    const prev = newest.get(r.cid);
    if (!prev || r.timestamp > prev.timestamp) newest.set(r.cid, r);
  }
  for (const [cid, r] of newest) if (r.removed) newest.delete(cid);
  return newest;
}
