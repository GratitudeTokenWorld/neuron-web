import { describe, it, expect } from 'vitest';
import { RelayDirectory } from './relay-directory.js';

function directoryOf(n: number): RelayDirectory {
  const d = new RelayDirectory();
  for (let i = 0; i < n; i++) d.add('relay-' + i);
  return d;
}

describe('RelayDirectory (rendezvous hashing)', () => {
  it('assigns a peer to relays deterministically', () => {
    const d = directoryOf(10);
    const a = d.assign('peer-x', 3);
    const b = d.assign('peer-x', 3);
    expect(a).toEqual(b);
    expect(a).toHaveLength(3);
  });

  it('balances load across relays', () => {
    const d = directoryOf(20);
    const replication = 2;
    const peers = 4000;
    const load = new Map<string, number>();
    for (let i = 0; i < peers; i++) {
      for (const r of d.assign('peer-' + i, replication)) load.set(r, (load.get(r) ?? 0) + 1);
    }
    const expected = (peers * replication) / 20; // 400
    for (const r of d.list()) {
      const l = load.get(r) ?? 0;
      expect(l).toBeGreaterThan(expected * 0.6);
      expect(l).toBeLessThan(expected * 1.4);
    }
  });

  it('reshuffles only a small fraction of peers when a relay is added', () => {
    const d = directoryOf(20);
    const replication = 2;
    const peers = 4000;
    const before = new Map<string, string>();
    for (let i = 0; i < peers; i++) before.set('peer-' + i, d.assign('peer-' + i, replication).join(','));

    d.add('relay-new');
    let changed = 0;
    for (let i = 0; i < peers; i++) {
      if (d.assign('peer-' + i, replication).join(',') !== before.get('peer-' + i)) changed++;
    }
    expect(changed / peers).toBeLessThan(0.2); // ≈ replication/(relays+1) ≈ 9.5%
  });

  it('scales by adding relays rather than raising a per-relay cap', () => {
    // 1B peers at replication 2, 100k reservations per relay → 20k relays
    expect(RelayDirectory.relaysNeeded(1_000_000_000, 2, 100_000)).toBe(20_000);
  });
});
