import { describe, it, expect } from 'vitest';
import { chunkContent, reassemble, verifyManifest, DEFAULT_CHUNK_SIZE } from './chunking.js';
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
