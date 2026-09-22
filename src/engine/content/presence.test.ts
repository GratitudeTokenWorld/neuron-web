import { describe, it, expect } from 'vitest';
import { PresenceStore, presencePayload, type SignedPresence } from './presence.js';

/**
 * The beacon replaces the heartbeat's only remaining job — telling peers where
 * to dial — without putting a string that changes onto a permanent chain.
 *
 * Disproved by anything here feeding a custody or payout decision, or by an
 * unsigned/stale/future-dated beacon being accepted.
 */

const NOW = 1_000_000_000;
const MAX_AGE = 12 * 60 * 60 * 1000;
const SKEW = 60_000;
const ok = () => true;
const no = () => false;

const beacon = (pub: string, ts: number, addr = 'p1.example'): SignedPresence => ({
  beacon: { pub, smokeAddr: addr, countryCode: 'DE', capacityGB: 10, storedBytes: 5, ts },
  signature: 'sig',
});

describe('accepting a beacon', () => {
  it('takes a fresh, signed one', () => {
    const s = new PresenceStore();
    expect(s.record(beacon('P', NOW), ok, NOW, SKEW)).toBeNull();
    expect(s.get('P', NOW, MAX_AGE)?.smokeAddr).toBe('p1.example');
  });

  it('refuses one that does not verify', () => {
    const s = new PresenceStore();
    expect(s.record(beacon('P', NOW), no, NOW, SKEW)).toMatch(/signature/);
    expect(s.get('P', NOW, MAX_AGE)).toBeUndefined();
  });

  it('refuses one dated in the future', () => {
    // A beacon from the future would win every comparison forever — a cheap
    // way to pin a stale address in place.
    const s = new PresenceStore();
    expect(s.record(beacon('P', NOW + SKEW * 10), ok, NOW, SKEW)).toMatch(/too far ahead/);
  });

  it('keeps the newest and refuses a replay', () => {
    const s = new PresenceStore();
    s.record(beacon('P', NOW, 'new.example'), ok, NOW, SKEW);
    expect(s.record(beacon('P', NOW - 1000, 'old.example'), ok, NOW, SKEW)).toMatch(/stale/);
    expect(s.get('P', NOW, MAX_AGE)?.smokeAddr).toBe('new.example');
  });

  it('replaces rather than appends — one slot per provider', () => {
    const s = new PresenceStore();
    for (let i = 1; i <= 1_000; i++) s.record(beacon('P', NOW + i), ok, NOW + i, SKEW);
    expect(s.size()).toBe(1);
  });
});

describe('freshness and bounds', () => {
  it('stops handing out an address too old to dial', () => {
    const s = new PresenceStore();
    s.record(beacon('P', NOW), ok, NOW, SKEW);
    expect(s.get('P', NOW + MAX_AGE, MAX_AGE)).toBeDefined();
    expect(s.get('P', NOW + MAX_AGE + 1, MAX_AGE)).toBeUndefined();
  });

  it('sweeps what it will no longer hand out', () => {
    const s = new PresenceStore();
    s.record(beacon('P', NOW), ok, NOW, SKEW);
    expect(s.sweep(NOW + MAX_AGE + 1, MAX_AGE)).toBe(1);
    expect(s.size()).toBe(0);
  });
});

describe('what it must NOT be used for', () => {
  it('signs over the fields a verifier will actually read', () => {
    // Rebuilt from the record, never taken from the message: a signature over
    // attacker-chosen bytes proves nothing about the fields you then use.
    const b = beacon('P', NOW).beacon;
    expect(presencePayload(b)).toContain('P');
    expect(presencePayload(b)).toContain('p1.example');
    expect(presencePayload(b)).toContain(String(NOW));
    // Changing any signed field changes the payload, so the old signature fails.
    expect(presencePayload({ ...b, smokeAddr: 'evil.example' })).not.toBe(presencePayload(b));
    expect(presencePayload({ ...b, storedBytes: 999 })).not.toBe(presencePayload(b));
  });

  it('carries self-reported volume that must never meter a payout', () => {
    // It rides along for display. A beacon saying "I hold a petabyte" is
    // exactly what a provider holding nothing would also say, which is why
    // custody is decided by observed service instead.
    const s = new PresenceStore();
    s.record({
      beacon: { pub: 'liar', storedBytes: 1e15, capacityGB: 1e9, ts: NOW },
      signature: 'sig',
    }, ok, NOW, SKEW);
    const got = s.get('liar', NOW, MAX_AGE)!;
    expect(got.storedBytes).toBe(1e15);
    // …and nothing in this module turns that into anything. It has no method
    // that returns a payout, a lease, or a liveness verdict.
    expect(Object.keys(s)).not.toContain('isLive');
  });
});
