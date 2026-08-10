import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSystemBackend } from './fs-backend.js';
import { ContentStore } from '../engine/content/content-store.js';
import { cidOf } from '../engine/content/cid.js';

/**
 * The filesystem backend is the storage tier's honest bottom layer — plain
 * files, no service — so it is also the CI target that proves the backend
 * seam works against a real, restartable store rather than a Map.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'neuron-fsbackend-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('FileSystemBackend', () => {
  it('round-trips blocks, dedups by CID, and reports usage', async () => {
    const be = new FileSystemBackend(root);
    const bytes = new TextEncoder().encode('hello content addressing');
    const cid = cidOf(bytes);

    expect(await be.has(cid)).toBe(false);
    expect(await be.get(cid)).toBeUndefined();

    expect(await be.put(cid, bytes)).toBe(bytes.length);
    expect(await be.has(cid)).toBe(true);
    expect(await be.get(cid)).toEqual(bytes);
    expect(await be.bytesUsed()).toBe(bytes.length);

    // Same content again is a no-op: content-addressed storage never rewrites.
    expect(await be.put(cid, bytes)).toBe(0);
    expect(await be.bytesUsed()).toBe(bytes.length);

    expect(await be.list()).toEqual([cid]);
    expect(await be.delete(cid)).toBe(bytes.length);
    expect(await be.has(cid)).toBe(false);
    expect(await be.bytesUsed()).toBe(0);
    expect(await be.delete(cid)).toBe(0); // deleting what is not held frees nothing
  });

  it('survives a restart: a new backend on the same directory sees the blocks', async () => {
    const first = new FileSystemBackend(root);
    const a = new TextEncoder().encode('block A');
    const b = new TextEncoder().encode('block B');
    await first.put(cidOf(a), a);
    await first.put(cidOf(b), b);

    // A fresh instance scans the directory rather than trusting a cached total —
    // this is the case a node restarting on its existing disk actually hits.
    const reopened = new FileSystemBackend(root);
    expect(await reopened.bytesUsed()).toBe(a.length + b.length);
    expect((await reopened.list()).sort()).toEqual([cidOf(a), cidOf(b)].sort());
    expect(await reopened.get(cidOf(a))).toEqual(a);
  });

  it('ignores interrupted writes and refuses a path-escaping cid', async () => {
    const be = new FileSystemBackend(root);
    const bytes = new TextEncoder().encode('real block');
    await be.put(cidOf(bytes), bytes);

    // A leftover .tmp from a crashed write must not be listed or counted.
    await fs.writeFile(join(root, cidOf(bytes).slice(0, 2), 'deadbeef.tmp'), new Uint8Array(999));
    const fresh = new FileSystemBackend(root);
    expect(await fresh.list()).toEqual([cidOf(bytes)]);
    expect(await fresh.bytesUsed()).toBe(bytes.length);

    // A malformed cid can never be turned into a path outside the root.
    await expect(be.get('../../etc/passwd')).rejects.toThrow(/invalid cid/);
    await expect(be.put('..', new Uint8Array(1))).rejects.toThrow(/invalid cid/);
  });

  it('backs a ContentStore end to end, quota and chunking intact', async () => {
    // 12 KB of content through a 1 KB chunk size: real chunking, real files.
    const store = new ContentStore(1024 * 1024, 1024, new FileSystemBackend(root));
    const data = new TextEncoder().encode('neuron'.repeat(2000));

    const res = await store.storeContent(data);
    expect(res.ok).toBe(true);
    const out = await store.getContent(res.manifest!);
    expect(cidOf(out!)).toBe(cidOf(data));
    // Repeating content produces repeating chunks, and content addressing
    // stores each distinct one ONCE — so the disk holds less than the file.
    expect(store.used()).toBeLessThan(data.length);
    expect(store.used()).toBe((await store.heldCids()).length * 1024 - (1024 - (data.length % 1024)));

    // Quota still refuses cleanly, and refusal writes nothing.
    const tiny = new ContentStore(500, 1024, new FileSystemBackend(await fs.mkdtemp(join(tmpdir(), 'neuron-tiny-'))));
    const fail = await tiny.storeContent(new Uint8Array(5000));
    expect(fail.ok).toBe(false);
    expect(fail.reason).toMatch(/quota/);
    expect(tiny.used()).toBe(0);

    // Lease expiry / rejoin cleanup: release frees space and the bytes are gone.
    const usedBeforeRelease = store.used();
    const freed = await store.release(await store.heldCids());
    expect(freed).toBe(usedBeforeRelease);
    expect(store.used()).toBe(0);
    expect(await store.getContent(res.manifest!)).toBeNull();
  });

  it('reopens a ContentStore onto an existing disk without double-counting', async () => {
    const backend = new FileSystemBackend(root);
    const store = new ContentStore(1024 * 1024, 1024, backend);
    const data = new TextEncoder().encode('persisted'.repeat(300));
    await store.storeContent(data);
    const usedBefore = store.used();

    // A node restarting: same disk, fresh objects, capacity accounting adopted.
    const reopened = new ContentStore(1024 * 1024, 1024, new FileSystemBackend(root));
    await reopened.open();
    expect(reopened.used()).toBe(usedBefore);
    expect(reopened.available()).toBe(1024 * 1024 - usedBefore);
  });
});
