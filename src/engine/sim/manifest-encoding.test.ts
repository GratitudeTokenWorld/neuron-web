import { describe, it, expect } from 'vitest';
import {
  chunkCount, jsonBytes, binaryBytes, floorBytes, shareOfFile,
  decompressBreakEvenBitsPerSec, indexCost,
  downloadModel, deviceInclusion,
} from './manifest-encoding.js';
import { chunkContent, DEFAULT_CHUNK_SIZE } from '../content/chunking.js';
import { hashHex } from '../core/hash.js';

/**
 * Realistic CIDs — REAL SHA-256 digests, not `i.toString(16).padStart(64,'0')`.
 *
 * The first draft of this file used padded counters, which are almost all
 * zeros: gzip took that manifest to 1,485 bytes instead of 18,895, making
 * compression look 12x better than it is. A fixture that compresses more
 * easily than the real thing is a test that flatters the option under review.
 */
function fakeCid(i: number): string {
  return hashHex(new Uint8Array([i & 255, (i >> 8) & 255, (i >> 16) & 255]));
}

/**
 * gzip via the WEB-STANDARD streams, not `node:zlib`.
 *
 * The engine's tsconfig is `ES2022 + WebWorker` on purpose, so engine code stays
 * browser-portable and DOM-free; this test was the first thing in `src/engine`
 * to reach for a Node global, and typecheck caught it. `CompressionStream` runs
 * in both places and measures what a browser would actually pay.
 *
 * Note the timing below therefore INCLUDES stream setup, so it is an UPPER
 * BOUND on decompression cost. That bias runs against compression, which is the
 * option this file ends up rejecting — so it is stated rather than buried, and
 * the conclusion does not rest on it: the binary encoding is smaller than the
 * gzip *and* free to read, whatever the decompressor costs.
 */
async function gzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  void w.write(bytes);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  void w.write(bytes);
  void w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const hexToBytes = (hex: string) => {
  const out = new Uint8Array<ArrayBuffer>(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Hypothesis H-M1: compressing manifests is worth doing.
 *
 * Disproved by finding an encoding that is SMALLER than the compressed form
 * and needs no decompression — in which case compression is a worse version of
 * a change we should make anyway.
 *
 * Sizes here are computed analytically; this test pins them against a REAL
 * manifest and real gzip, so the model cannot drift from the code it describes.
 */

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A real manifest from the shipping chunker, as the ground truth. */
function realManifestJson(fileBytes: number): Uint8Array<ArrayBuffer> {
  const { manifest } = chunkContent(new Uint8Array(fileBytes), DEFAULT_CHUNK_SIZE);
  const { cid, ...signed } = manifest;
  return utf8(JSON.stringify(signed));
}

describe('the analytical model matches the real chunker', () => {
  it('predicts real manifest bytes within a few percent', () => {
    // 24 MB → 3 chunks, and 20 MB → an uneven last chunk, which is the case a
    // per-chunk average silently gets wrong.
    const fileBytes = 24 * MB;
    const real = realManifestJson(fileBytes).length;
    const predicted = jsonBytes({ fileBytes, chunkSize: DEFAULT_CHUNK_SIZE });
    // Exact, not approximate. The first version was within 5% and that is the
    // kind of tolerance that hides a model slowly drifting from the code.
    expect(predicted).toBe(real);
  });

  it('is exact for an uneven final chunk too', () => {
    const fileBytes = 20 * MB; // 2 full chunks + a 4 MB remainder
    expect(jsonBytes({ fileBytes, chunkSize: DEFAULT_CHUNK_SIZE }))
      .toBe(realManifestJson(fileBytes).length);
  });

  it('counts chunks the same way the chunker does', () => {
    const fileBytes = 20 * MB;
    const { manifest } = chunkContent(new Uint8Array(fileBytes), DEFAULT_CHUNK_SIZE);
    expect(chunkCount({ fileBytes, chunkSize: DEFAULT_CHUNK_SIZE })).toBe(manifest.chunks.length);
  });
});

describe('H-M1 is DISPROVED: binary beats gzip on both axes', () => {
  const shape = { fileBytes: 4 * GB, chunkSize: 8 * MB };

  it('is smaller than the compressed form AND needs no decompression', async () => {
    // Build the real JSON for this shape without allocating 4 GB.
    const n = chunkCount(shape);
    const chunks = Array.from({ length: n }, (_, i) => ({
      cid: fakeCid(i),
      size: shape.chunkSize,
    }));
    const json = utf8(JSON.stringify({ size: shape.fileBytes, chunkSize: shape.chunkSize, chunks }));
    const gz = await gzip(json);

    // The falsifier for H-M1: a cheaper encoding that also costs nothing to read.
    expect(binaryBytes(shape)).toBeLessThan(gz.length);
    // …and it is close to the information-theoretic floor.
    expect(binaryBytes(shape) - floorBytes(shape)).toBe(16);
  });

  it('shows compression cannot help the binary form — hashes are incompressible', async () => {
    // A SHA-256 that compressed would not be a good hash. Gzipping raw digests
    // makes them BIGGER, by the size of the gzip header.
    const n = 512;
    const digests = new Uint8Array<ArrayBuffer>(new ArrayBuffer(n * 32));
    for (let i = 0; i < n; i++) digests.set(hexToBytes(fakeCid(i)), i * 32);
    expect(digests.length).toBe(n * 32);
    // Gzip cannot shrink real digests; it adds its own header instead.
    expect((await gzip(digests)).length).toBeGreaterThan(digests.length * 0.99);
  });

  it('attributes the whole gap to hex and a derivable field, not to entropy', () => {
    // 64 hex characters carry 32 bytes — a 2x tax — and every chunk's `size` is
    // derivable from `size` and `chunkSize`. Fixing those two IS the win;
    // compression is a roundabout way of partially recovering the same bytes.
    expect(jsonBytes(shape) / binaryBytes(shape)).toBeGreaterThan(2.5);
  });
});

describe('does decompression cost more than the transfer it saves?', () => {
  it('measures both sides and reports the break-even link speed', async () => {
    const n = 512;
    const chunks = Array.from({ length: n }, (_, i) => ({
      cid: fakeCid(i), size: 8 * MB,
    }));
    const json = utf8(JSON.stringify({ size: 4 * GB, chunkSize: 8 * MB, chunks }));
    const gz = await gzip(json);

    // `performance.now()`, not `process.hrtime`: the engine's tsconfig is
    // WebWorker-only on purpose, so it stays browser-portable and DOM-free.
    for (let i = 0; i < 10; i++) await gunzip(gz); // warm
    const t0 = performance.now();
    const ROUNDS = 50;
    for (let i = 0; i < ROUNDS; i++) await gunzip(gz);
    const decompressMs = (performance.now() - t0) / ROUNDS;

    const breakEven = decompressBreakEvenBitsPerSec({
      bytesSaved: json.length - gz.length,
      decompressMs,
    });

    // Decompression is sub-millisecond and the saving is tens of kilobytes, so
    // the break-even lands far above any consumer link: against the JSON we
    // ship today, compressing does win on transfer.
    // Even with stream setup counted, the break-even sits above a fast consumer
    // link: against today's JSON, compressing wins on transfer.
    expect(breakEven).toBeGreaterThan(10e6);
    expect(decompressMs).toBeLessThan(20);

    // Which is exactly why the comparison that matters is not gzip-vs-JSON.
    // The binary form is smaller than the gzip AND costs zero to decompress,
    // so it wins on both axes at every link speed — there is no crossover to
    // reason about.
    expect(binaryBytes({ fileBytes: 4 * GB, chunkSize: 8 * MB })).toBeLessThan(gz.length);
  });
});

describe('scaling: where the manifest actually matters', () => {
  it('is a fixed share of the file, at every size', () => {
    // The scaling property that settles the urgency: chunks grow with the file,
    // so the ratio is constant. No file size makes a manifest significant
    // relative to its own content.
    const shares = [100 * MB, GB, 4 * GB, 50 * GB, 1024 * GB].map(fileBytes => {
      const shape = { fileBytes, chunkSize: 8 * MB };
      return shareOfFile(shape, jsonBytes(shape));
    });
    for (const s of shares) {
      expect(s).toBeLessThan(0.00002);
      expect(s).toBeGreaterThan(0.000005);
    }
    // Flat within a factor of two across four orders of magnitude of file size.
    expect(Math.max(...shares) / Math.min(...shares)).toBeLessThan(2);
  });

  it('only bites for a node holding manifests WITHOUT the chunks', () => {
    // An index, a browser, a search tier. There the manifests are the entire
    // cost and the encoding is the only lever — 2.8x, on the one node type
    // that cannot amortise it against content it is storing anyway.
    const shape = { fileBytes: 4 * GB, chunkSize: 8 * MB };
    const files = 1_000_000;
    const asJson = indexCost({ files, shape, perManifestBytes: jsonBytes });
    const asBinary = indexCost({ files, shape, perManifestBytes: binaryBytes });
    expect(asJson / GB).toBeGreaterThan(40);
    expect(asBinary / GB).toBeLessThan(20);
    expect(asJson / asBinary).toBeGreaterThan(2.5);
  });

  it('stays bounded per node, because a node indexes its OWN files', () => {
    // The invariant check. `file-index.ts` keeps own-file records only, so this
    // is O(own), not O(network) — a heavy user with 10k large files pays tens
    // of megabytes of manifest against tens of terabytes of content.
    const shape = { fileBytes: 4 * GB, chunkSize: 8 * MB };
    const ownFiles = 10_000;
    const manifestMB = indexCost({ files: ownFiles, shape, perManifestBytes: binaryBytes }) / MB;
    const contentTB = (ownFiles * shape.fileBytes) / 1024 ** 4;
    expect(manifestMB).toBeLessThan(200);
    expect(contentTB).toBeGreaterThan(35);
  });

  it('shrinks if the chunk size grows — the other lever, with its own cost', () => {
    // Doubling chunkSize halves the manifest. It also doubles the smallest
    // device's cost to hold one chunk, which is a Principle 1 cost, so this
    // trade is not free in the direction it looks free.
    const at8 = binaryBytes({ fileBytes: 4 * GB, chunkSize: 8 * MB });
    const at16 = binaryBytes({ fileBytes: 4 * GB, chunkSize: 16 * MB });
    expect(at16).toBeLessThan(at8 * 0.55);
  });
});

describe('choosing the chunk size (measured, 2026-09-22)', () => {
  const FILE = 4 * GB;
  // ASSUMED fleet: a long tail of small devices, as Principle 1 promises.
  // Sensor/SBC 64 MB, phones 256 MB - 1 GB, laptops 8 GB, servers 200 GB.
  const FLEET = [
    ...new Array(20).fill(64 * MB),
    ...new Array(30).fill(256 * MB),
    ...new Array(20).fill(1 * GB),
    ...new Array(20).fill(8 * GB),
    ...new Array(10).fill(200 * GB),
  ];

  it('shows round-trip overhead dominating at small chunk sizes', () => {
    // The cost that got sharper when the fetch fan-out was bounded to 8: a
    // reader now pays ceil(chunks / 8) serial rounds.
    const small = downloadModel({ fileBytes: FILE, chunkSize: 1 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });
    const mid = downloadModel({ fileBytes: FILE, chunkSize: 8 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });
    const large = downloadModel({ fileBytes: FILE, chunkSize: 32 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });

    expect(small.rounds).toBe(512);
    expect(mid.rounds).toBe(64);
    expect(large.rounds).toBe(16);
    // Latency cost falls 8x from 1 MB to 8 MB…
    expect(small.latencySeconds / mid.latencySeconds).toBeCloseTo(8, 0);
    // …but transfer dominates the total at every size on this link, so the
    // latency term is not what should decide the default.
    expect(mid.transferSeconds).toBeGreaterThan(mid.latencySeconds * 20);
  });

  it('shows device inclusion falling as chunks grow — the real cost', () => {
    // Principle 1 in a number. Every doubling past a device class's free space
    // removes that whole class from being able to hold any piece of the file.
    expect(deviceInclusion(1 * MB, FLEET)).toBe(1);
    expect(deviceInclusion(8 * MB, FLEET)).toBe(1);
    expect(deviceInclusion(64 * MB, FLEET)).toBe(1);
    // Past the smallest class, inclusion starts dropping.
    expect(deviceInclusion(128 * MB, FLEET)).toBeLessThan(0.85);
    expect(deviceInclusion(512 * MB, FLEET)).toBeLessThan(0.55);
  });

  it('finds 8 MB already sits in the flat part of every curve', () => {
    // The conclusion: at 8 MB the manifest is 0.0004% of the file, the latency
    // term is under 5% of the download, and 100% of the modelled fleet can
    // still hold a chunk. Nothing is being paid for that a change would
    // recover, so the default stays — measured rather than assumed.
    const m = downloadModel({ fileBytes: FILE, chunkSize: 8 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });
    expect(m.latencySeconds / m.seconds).toBeLessThan(0.05);
    expect(shareOfFile({ fileBytes: FILE, chunkSize: 8 * MB }, binaryBytes({ fileBytes: FILE, chunkSize: 8 * MB })))
      .toBeLessThan(0.00001);
    expect(deviceInclusion(8 * MB, FLEET)).toBe(1);
  });

  it('would cost inclusion to buy back a latency term that is already small', () => {
    // The trade a larger default would make, stated as numbers: going to
    // 128 MB saves ~1 second of round-trips on a 4 GB file and removes a fifth
    // of the modelled fleet from holding any of it.
    const at8 = downloadModel({ fileBytes: FILE, chunkSize: 8 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });
    const at128 = downloadModel({ fileBytes: FILE, chunkSize: 128 * MB, perPeerBytesPerSec: 1.25e6, latencyMs: 17 });
    expect(at8.latencySeconds - at128.latencySeconds).toBeLessThan(2);
    expect(deviceInclusion(8 * MB, FLEET) - deviceInclusion(128 * MB, FLEET)).toBeGreaterThan(0.15);
  });
});
