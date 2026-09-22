/**
 * What a chunk manifest costs, per encoding, and where that cost stops being
 * negligible.
 *
 * Lucian asked whether manifests should be compressed, and then the question
 * that settles it: does decompression take longer than downloading the bytes
 * compression would have saved?
 *
 * Both halves are measurable, so neither is argued here. This module computes
 * sizes analytically (the byte counts are exact, not sampled) and the test
 * measures real compression and decompression against them.
 *
 * ## The shape of the answer
 *
 * A manifest is one 32-byte hash per chunk plus a little framing, so its size
 * is `fileBytes / chunkSize × perChunkBytes`. That means **manifest cost is a
 * fixed FRACTION of the content it describes** — around a thousandth of a
 * percent — and no file size makes it significant relative to its own file.
 *
 * It becomes significant in exactly one place: a node that holds **manifests
 * without holding chunks** — an index, a browser, a search tier. There the
 * manifests are the whole cost, and the encoding is the only lever.
 */

/** Hex-JSON: what ships today. 64 hex chars per CID plus JSON framing. */
export const ENCODING_JSON = 'json';
/** The same JSON, gzipped. */
export const ENCODING_GZIP = 'gzip';
/** Raw 32-byte hashes, chunk sizes DERIVED from `size` and `chunkSize`. */
export const ENCODING_BINARY = 'binary';

export interface ManifestShape {
  fileBytes: number;
  chunkSize: number;
}

export function chunkCount(m: ManifestShape): number {
  return Math.max(1, Math.ceil(m.fileBytes / m.chunkSize));
}

/**
 * Exact JSON bytes of a manifest as `chunkContent` produces one.
 *
 * `{"cid":"<64 hex>","size":8388608}` plus separators. Computed rather than
 * sampled so the number is reproducible and its derivation is visible.
 */
export function jsonBytes(m: ManifestShape): number {
  const n = chunkCount(m);
  const d = (v: number) => String(v).length;
  // Exact, character by character, because an approximation here would be an
  // estimate dressed as a measurement and the test pins it against the real
  // chunker:
  //   {"size":N,"chunkSize":N,"chunks":[ ... ]}   →  34 + digits + digits
  //   {"cid":"<64 hex>","size":N}                  →  82 + digits
  const framing = 34 + d(m.fileBytes) + d(m.chunkSize);
  const lastSize = m.fileBytes - m.chunkSize * (n - 1);
  const full = (n - 1) * (82 + d(m.chunkSize));
  const last = 82 + d(lastSize);
  const commas = n - 1;
  return framing + full + last + commas;
}

/**
 * Raw-binary bytes: 32 per chunk, plus a 16-byte header for `size` and
 * `chunkSize`.
 *
 * The per-chunk `size` field is **derivable** — every chunk is `chunkSize`
 * except the last, which is whatever remains — so carrying it is redundant,
 * and 64 hex characters to transmit 32 bytes of hash is a 2× tax. Those two
 * facts together are the entire difference below, and neither needs a
 * compressor.
 */
export function binaryBytes(m: ManifestShape): number {
  return 16 + chunkCount(m) * 32;
}

/**
 * The information-theoretic floor: the chunk hashes themselves.
 *
 * A SHA-256 is incompressible by construction — if it compressed, it would not
 * be a good hash — so no encoding can go below this, and any compressor applied
 * to it is doing work for nothing.
 */
export function floorBytes(m: ManifestShape): number {
  return chunkCount(m) * 32;
}

/** Manifest bytes as a share of the file they describe. */
export function shareOfFile(m: ManifestShape, manifestBytes: number): number {
  return manifestBytes / m.fileBytes;
}

/**
 * The question that decides it: is decompressing cheaper than downloading the
 * bytes compression saved?
 *
 * Returns the bandwidth (bits/s) at which the two are equal. Below it,
 * compressing wins; above it, the decompression costs more than the transfer it
 * avoided. Reported as a number rather than a verdict because it depends on the
 * reader's link, and Principle 1 says that link might be a phone on 1 Mbit.
 */
export function decompressBreakEvenBitsPerSec(args: {
  bytesSaved: number;
  decompressMs: number;
}): number {
  if (args.decompressMs <= 0) return Infinity;
  return (args.bytesSaved * 8) / (args.decompressMs / 1000);
}

/**
 * Aggregate manifest bytes for a node that holds manifests but NOT the chunks.
 *
 * The only place this cost is load-bearing. A node holding the content pays
 * ~0.001% overhead and will never notice; an index holding a million manifests
 * pays all of it.
 */
export function indexCost(args: {
  files: number;
  shape: ManifestShape;
  perManifestBytes: (m: ManifestShape) => number;
}): number {
  return args.files * args.perManifestBytes(args.shape);
}

// ── Choosing the chunk size ──────────────────────────────────────────────────

/**
 * What the chunk size actually trades (Lucian asked for it measured,
 * 2026-09-22).
 *
 * Three costs move in opposite directions, so the answer is a minimum rather
 * than a slope:
 *
 * 1. **Manifest bytes** fall as chunks grow — one digest per chunk.
 * 2. **Round-trip overhead** falls as chunks grow. A reader fetches at most
 *    `MAX_PARALLEL_FETCH` chunks at once (8, since the fan-out was bounded on
 *    2026-09-22), so a file takes `ceil(chunks / parallel)` rounds and each
 *    round pays a latency.
 * 3. **Device inclusion** falls as chunks grow, and this one is a principle
 *    rather than a number: a device can only hold content whose chunk fits in
 *    its free space. Doubling the chunk size halves the set of devices that can
 *    hold any piece of a large file at all (PRINCIPLES.md → 1).
 */

/** Chunks a reader fetches concurrently — mirrors `MAX_PARALLEL_FETCH`. */
export const PARALLEL_FETCH = 8;

/**
 * Wall-clock to fetch a whole file, modelled.
 *
 * ASSUMED: per-peer bandwidth and latency, and that rounds are serial while
 * chunks within a round are parallel. That is pessimistic — a real client
 * pipelines — so treat it as an upper bound on the latency term rather than a
 * prediction.
 */
export function downloadModel(args: {
  fileBytes: number;
  chunkSize: number;
  perPeerBytesPerSec: number;
  latencyMs: number;
  parallel?: number;
}): { seconds: number; rounds: number; latencySeconds: number; transferSeconds: number } {
  const parallel = args.parallel ?? PARALLEL_FETCH;
  const n = chunkCount({ fileBytes: args.fileBytes, chunkSize: args.chunkSize });
  const rounds = Math.ceil(n / parallel);
  const latencySeconds = (rounds * args.latencyMs) / 1000;
  // Aggregate bandwidth is `parallel` peers at once.
  const transferSeconds = args.fileBytes / (args.perPeerBytesPerSec * parallel);
  return { seconds: latencySeconds + transferSeconds, rounds, latencySeconds, transferSeconds };
}

/**
 * Share of devices that can hold at least one chunk.
 *
 * `freeSpaceBytes` is a sample of the fleet — Principle 1 promises a long tail
 * of small ones, so this is the number a larger chunk size spends.
 */
export function deviceInclusion(chunkSize: number, freeSpaceBytes: readonly number[]): number {
  if (freeSpaceBytes.length === 0) return 0;
  return freeSpaceBytes.filter(b => b >= chunkSize).length / freeSpaceBytes.length;
}
