import { describe, it, expect } from 'vitest';
import { ConflictResolver } from './vote.js';

describe('ConflictResolver', () => {
  it('optimistically confirms a lone block (no voting needed)', () => {
    const r = new ConflictResolver();
    expect(r.register('h1', 'acct', 'prev')).toBe('confirmed');
    expect(r.status('h1')).toBe('confirmed');
  });

  it('resolves a fork once a block passes the 2/3 weight threshold', () => {
    const r = new ConflictResolver();
    r.register('hA', 'acct', 'prev');
    expect(r.register('hB', 'acct', 'prev')).toBe('conflict');
    expect(r.status('hA')).toBe('conflict');

    r.vote({ blockHash: 'hA', voterId: 'v1', weight: 70 });
    r.vote({ blockHash: 'hB', voterId: 'v2', weight: 30 });

    const res = r.resolve();
    expect(res.confirmed).toContain('hA');
    expect(res.rejected).toContain('hB');
    expect(r.status('hA')).toBe('confirmed');
    expect(r.status('hB')).toBe('rejected');
  });

  it('does not resolve below threshold until timeout, then highest weight wins', () => {
    const r = new ConflictResolver();
    r.register('hA', 'acct', 'prev');
    r.register('hB', 'acct', 'prev');
    r.vote({ blockHash: 'hA', voterId: 'v1', weight: 55 });
    r.vote({ blockHash: 'hB', voterId: 'v2', weight: 45 });

    expect(r.resolve().confirmed.length).toBe(0); // 55% < 2/3
    const res = r.resolve({ timedOut: true });
    expect(res.confirmed).toContain('hA');
  });

  it('detects equivocation (one voter backing two forks) and does not count the second', () => {
    const r = new ConflictResolver();
    r.register('hA', 'acct', 'prev');
    r.register('hB', 'acct', 'prev');
    expect(r.vote({ blockHash: 'hA', voterId: 'v1', weight: 50 }).counted).toBe(true);

    const out = r.vote({ blockHash: 'hB', voterId: 'v1', weight: 50 });
    expect(out.counted).toBe(false);
    expect(out.equivocation).toBeDefined();
    expect(r.equivocations()).toHaveLength(1);
  });
});
