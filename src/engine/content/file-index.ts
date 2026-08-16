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
 * Everything here is pure. Signature verification is INJECTED rather than
 * imported: these records are signed with the app's WebCrypto P-256 keys, not
 * the engine's `@noble` ones, and an engine module may not reach into the app
 * layer. It also means the relay and the browser can verify with whatever each
 * has, against one shared definition of what the payload is.
 */

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
  limit?: number;
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

  return [...newest.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);
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
