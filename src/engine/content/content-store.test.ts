import { describe, it, expect } from 'vitest';
import { ContentStore } from './content-store.js';
import { cidOf } from './cid.js';
import { DEFAULT_CHUNK_SIZE } from './chunking.js';

describe('ContentStore (quota-aware)', () => {
  it('stores and retrieves content', () => {
    const store = new ContentStore(1024 * 1024, 1024);
    const data = new TextEncoder().encode('the quick brown fox'.repeat(500));
    const res = store.storeContent(data);
    expect(res.ok).toBe(true);
    const out = store.getContent(res.manifest!);
    expect(out).not.toBeNull();
    expect(cidOf(out!)).toBe(cidOf(data));
  });

  it('refuses content that would exceed quota — cleanly, without partial writes', () => {
    const store = new ContentStore(2000, 1024);
    const res = store.storeContent(new Uint8Array(5000));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/quota/);
    expect(store.used()).toBe(0); // nothing written
  });

  it('never writes a blob larger than the chunk size', () => {
    const store = new ContentStore(1_000_000, 1024);
    const res = store.putBlock(cidOf(new Uint8Array(2048)), new Uint8Array(2048));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/chunk size/);
  });

  it('dedups identical chunks (content-addressed)', () => {
    const store = new ContentStore(1_000_000, 1024);
    const data = new TextEncoder().encode('repeatme'.repeat(300));
    store.storeContent(data);
    const usedAfterFirst = store.used();
    store.storeContent(data); // same content again
    expect(store.used()).toBe(usedAfterFirst); // no extra space
  });

  it('handles a 100 MB file via chunking, and rejects it cleanly when quota is too small', () => {
    const SIZE = 100 * 1024 * 1024;
    const buf = new Uint8Array(SIZE);
    for (let off = 0, ci = 0; off < SIZE; off += DEFAULT_CHUNK_SIZE, ci++) buf[off] = ci & 0xff;

    // enough quota → stored as bounded chunks, fully retrievable
    const big = new ContentStore(SIZE + DEFAULT_CHUNK_SIZE);
    const ok = big.storeContent(buf);
    expect(ok.ok).toBe(true);
    expect(big.getContent(ok.manifest!)!.length).toBe(SIZE);

    // too little quota → clean failure, no crash, nothing written
    const small = new ContentStore(50 * 1024 * 1024);
    const fail = small.storeContent(buf);
    expect(fail.ok).toBe(false);
    expect(small.used()).toBe(0);
  }, 30_000);
});
