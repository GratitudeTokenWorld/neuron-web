import { describe, it, expect } from 'vitest';
import { chunkContent, reassemble, verifyManifest, DEFAULT_CHUNK_SIZE, encodeManifest, decodeManifest,
} from './chunking.js';
import { cidOf } from './cid.js';

describe('chunking', () => {
  it('round-trips small content and verifies the manifest', () => {
    const data = new TextEncoder().encode('hello content world'.repeat(100));
    const { manifest, chunks } = chunkContent(data, 64);
    expect(verifyManifest(manifest)).toBe(true);
    const map = new Map(chunks.map((c) => [c.cid, c.bytes]));
    const out = reassemble(manifest, (cid) => map.get(cid));
    expect(out).not.toBeNull();
    expect(cidOf(out!)).toBe(cidOf(data));
  });

  it('fails reassembly on a missing or corrupt chunk', () => {
    const data = new Uint8Array(500).map((_, i) => i & 0xff);
    const { manifest, chunks } = chunkContent(data, 64);
    const map = new Map(chunks.map((c) => [c.cid, c.bytes]));
    // missing
    expect(reassemble(manifest, (cid) => (cid === manifest.chunks[1]!.cid ? undefined : map.get(cid)))).toBeNull();
    // corrupt
    expect(
      reassemble(manifest, (cid) => (cid === manifest.chunks[1]!.cid ? new Uint8Array(64) : map.get(cid))),
    ).toBeNull();
  });

  it('chunks a 100 MB file into bounded blobs and reassembles it', () => {
    const SIZE = 100 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    // distinct first byte per chunk so chunks are not all-identical
    for (let off = 0, ci = 0; off < SIZE; off += DEFAULT_CHUNK_SIZE, ci++) buf[off] = ci & 0xff;

    const { manifest, chunks } = chunkContent(buf);
    expect(chunks.length).toBe(Math.ceil(SIZE / DEFAULT_CHUNK_SIZE));
    expect(chunks.every((c) => c.bytes.length <= DEFAULT_CHUNK_SIZE)).toBe(true); // no monolithic blob
    expect(manifest.size).toBe(SIZE);

    const map = new Map(chunks.map((c) => [c.cid, c.bytes]));
    const out = reassemble(manifest, (cid) => map.get(cid));
    expect(out).not.toBeNull();
    expect(out!.length).toBe(SIZE);
    expect(cidOf(out!)).toBe(cidOf(buf));
  }, 30_000);
});

describe('compact wire encoding (2026-09-22)', () => {
  const build = (bytes: number, chunkSize = 1024) =>
    chunkContent(new Uint8Array(bytes).map((_, i) => i & 255), chunkSize).manifest;

  it('round-trips a manifest exactly', () => {
    const m = build(4096 + 17);
    const back = decodeManifest(encodeManifest(m));
    expect(back).not.toBeNull();
    expect(back).toEqual(m);
  });

  it('keeps the CID identical — the address must not depend on the encoding', () => {
    // The load-bearing property. If the CID were computed over the wire bytes,
    // the same file would address differently depending on how it was
    // serialised, which is precisely why compressing the manifest was rejected.
    const m = build(8192);
    expect(decodeManifest(encodeManifest(m))!.cid).toBe(m.cid);
    expect(verifyManifest(decodeManifest(encodeManifest(m))!)).toBe(true);
  });

  it('derives the last chunk size rather than transmitting it', () => {
    const m = build(2048 + 300); // 2 full chunks + a 300-byte remainder
    const back = decodeManifest(encodeManifest(m))!;
    expect(back.chunks.at(-1)!.size).toBe(300);
    expect(back.chunks[0]!.size).toBe(1024);
  });

  it('is 2.8x smaller than the JSON it replaces', () => {
    const m = build(64 * 1024, 1024); // 64 chunks
    const json = new TextEncoder().encode(JSON.stringify({
      size: m.size, chunkSize: m.chunkSize, chunks: m.chunks,
    }));
    const wire = encodeManifest(m);
    expect(wire.length).toBe(20 + 64 * 32);
    expect(json.length / wire.length).toBeGreaterThan(2.5);
  });

  it('rejects malformed input rather than throwing — this parses untrusted bytes', () => {
    expect(decodeManifest(new Uint8Array(4))).toBeNull();              // too short
    expect(decodeManifest(new Uint8Array(20 + 31))).toBeNull();        // body not a multiple of 32
    const good = encodeManifest(build(4096));
    const wrongVersion = good.slice();
    wrongVersion[0] = 99;
    expect(decodeManifest(wrongVersion)).toBeNull();
  });

  it('rejects a header whose chunk count disagrees with its own size fields', () => {
    // A decompression-bomb-shaped attack in miniature: claim a huge file in the
    // header and send three digests. The count is implied by size/chunkSize, so
    // the disagreement is detectable before anything is allocated per chunk.
    const m = build(4096);
    const forged = encodeManifest(m);
    new DataView(forged.buffer).setBigUint64(4, BigInt(1_000_000_000), true);
    expect(decodeManifest(forged)).toBeNull();
  });

  it('round-trips an empty manifest', () => {
    const m = build(0);
    const back = decodeManifest(encodeManifest(m));
    expect(back?.size).toBe(0);
  });
});
