import { describe, it, expect } from 'vitest';
import {
  settlementSlot, settlementDue, settlementPeriodMs, periodIndexAt,
  publishRecordRoot, serviceRecordRoot, storedBytesOf, MIN_SETTLE_BYTES,
} from './storage-settlement.js';

/**
 * Scheduling and the two record roots.
 *
 * The scheduling claim: settlements spread across the period with no
 * coordination, never settle a period twice, and never write a block to move
 * nothing. The root claim: two nodes holding the same data compute the same
 * commitment.
 */

const DAY = 24 * 60 * 60 * 1000;
const PERIOD = settlementPeriodMs(DAY);

describe('slots spread the load with nobody coordinating', () => {
  it('never returns a negative slot', () => {
    // The bug this function inherited from its measured ancestor: without
    // forcing back to unsigned, the modulo produced negative slots and the
    // spread contained more distinct values than the period has.
    for (let i = 0; i < 20_000; i++) {
      const slot = settlementSlot(`acct${i}`, 43_200);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(43_200);
    }
  });

  it('spreads uniformly', () => {
    const buckets = new Map<number, number>();
    for (let i = 0; i < 100_000; i++) {
      const s = settlementSlot(`acct${i}`, 43_200);
      buckets.set(s, (buckets.get(s) ?? 0) + 1);
    }
    // ~2.3 per slot on average; nothing should be a spike.
    expect(Math.max(...buckets.values())).toBeLessThan(20);
    expect(buckets.size).toBeGreaterThan(38_000);
  });

  it('is deterministic, so a node computes its own slot and anyone can check', () => {
    expect(settlementSlot('alice', 43_200)).toBe(settlementSlot('alice', 43_200));
  });
});

describe('settlementDue', () => {
  const base = { accountId: 'alice', periodMs: PERIOD, lastSettledPeriod: -1, pendingBytes: MIN_SETTLE_BYTES };
  /** A time inside the current period, past alice's slot. */
  const slot = settlementSlot('alice', Math.floor(PERIOD / 60_000));
  const now = 500 * PERIOD + (slot + 5) * 60_000;

  it('is due once the slot is reached and there is enough to settle', () => {
    const d = settlementDue({ ...base, now });
    expect(d.due).toBe(true);
    expect(d.periodIndex).toBe(periodIndexAt(now, PERIOD));
  });

  it('refuses before the account slot, so the network does not spike', () => {
    const early = 500 * PERIOD + Math.max(0, slot - 5) * 60_000;
    if (slot > 5) expect(settlementDue({ ...base, now: early }).due).toBe(false);
  });

  it('refuses to settle a period twice', () => {
    const d = settlementDue({ ...base, now, lastSettledPeriod: periodIndexAt(now, PERIOD) });
    expect(d.due).toBe(false);
    expect(d.reason).toMatch(/already settled/);
  });

  it('refuses to write a block for a rounding error', () => {
    // Measured to cut claim volume ~65x: most accounts earn almost nothing, and
    // letting it accrue costs them nothing because receipts are cumulative.
    const d = settlementDue({ ...base, now, pendingBytes: 1024 });
    expect(d.due).toBe(false);
    expect(d.reason).toMatch(/below/);
  });

  it('still settles after a missed slot rather than waiting another month', () => {
    // The slot is a floor, not an exact match. A node offline at its slot must
    // not lose a period.
    const late = 500 * PERIOD + PERIOD - 60_000;
    expect(settlementDue({ ...base, now: late }).due).toBe(true);
  });
});

describe('the two record roots', () => {
  const files = [
    { cid: 'bbb', sizeBytes: 200 },
    { cid: 'aaa', sizeBytes: 100 },
    { cid: 'ccc', sizeBytes: 300 },
  ];

  it('does not depend on iteration order', () => {
    // Two nodes holding the same files must commit to the same root. An
    // unordered hash would only disagree once two implementations differed.
    const shuffled = [files[2]!, files[0]!, files[1]!];
    expect(publishRecordRoot(files)).toBe(publishRecordRoot(shuffled));
  });

  it('changes when the content changes', () => {
    expect(publishRecordRoot(files))
      .not.toBe(publishRecordRoot([...files, { cid: 'ddd', sizeBytes: 1 }]));
  });

  it('commits the service record from SETTLED baselines, order-independently', () => {
    const a = new Map([['r1', 100], ['r2', 200]]);
    const b = new Map([['r2', 200], ['r1', 100]]);
    expect(serviceRecordRoot(a)).toBe(serviceRecordRoot(b));
    expect(serviceRecordRoot(a)).not.toBe(serviceRecordRoot(new Map([['r1', 101], ['r2', 200]])));
  });

  it('totals stored bytes for the burn side', () => {
    expect(storedBytesOf(files)).toBe(600);
  });

  it('gives an empty account a stable root rather than nothing', () => {
    // A new account still commits to "I store nothing", which is a different
    // statement from having no commitment at all.
    expect(publishRecordRoot([])).toBe(publishRecordRoot([]));
    expect(publishRecordRoot([])).not.toBe(publishRecordRoot(files));
  });
});
