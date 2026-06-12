import { describe, it, expect } from 'vitest';
import { ReplicationManager } from './replication.js';

describe('ReplicationManager', () => {
  it('detects under-replication and repairs to the target', () => {
    const r = new ReplicationManager(3);
    r.announce('cid1', 'p1');
    r.announce('cid1', 'p2');
    expect(r.underReplicated('cid1')).toBe(true);

    const added = r.repair('cid1', ['p2', 'p3', 'p4']); // p2 already present, stops at target
    expect(added).toEqual(['p3']);
    expect(r.replicationOf('cid1')).toBe(3);
    expect(r.underReplicated('cid1')).toBe(false);
  });

  it('reports CIDs that fall under target when a provider churns out', () => {
    const r = new ReplicationManager(3);
    for (const p of ['p1', 'p2', 'p3']) r.announce('cid1', p);
    expect(r.underReplicated('cid1')).toBe(false);
    const affected = r.removeProvider('p2');
    expect(affected).toContain('cid1');
    expect(r.underReplicated('cid1')).toBe(true);
  });

  it('garbage-collects unpinned, expired content but keeps pinned content', () => {
    const r = new ReplicationManager(1);
    r.announce('keep', 'p1');
    r.pin('keep', 100);
    r.announce('drop', 'p1');
    r.pin('drop', 50);
    r.unpin('drop'); // unpinned, TTL 50

    const collected = r.collectGarbage(60);
    expect(collected).toContain('drop');
    expect(collected).not.toContain('keep');
    expect(r.replicationOf('drop')).toBe(0);
    expect(r.replicationOf('keep')).toBe(1);
  });
});
