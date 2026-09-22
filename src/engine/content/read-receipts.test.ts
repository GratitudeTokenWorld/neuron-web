import { describe, it, expect } from 'vitest';
import {
  ReceiptLedger, collusionCeilingBytes,
  PER_READER_EPOCH_CAP_BYTES, MIN_DISTINCT_READERS,
  ReaderReceiptBook,
  type ReadReceipt,
} from './read-receipts.js';

/**
 * Hypothesis H-P4: metering payment by reader-signed receipts removes the
 * self-metering defect (SCREENING.md → 11) without removing payment.
 *
 * Disproved by: any path where a provider's own claim changes what it is owed,
 * a replayed or regressed receipt increasing a balance, or the same bytes being
 * settled twice.
 *
 * The adversarial cases here are the point — this is money.
 */

const ok = () => true;
const MB = 1024 * 1024;

function receipt(p: Partial<ReadReceipt> & { reader: string; provider: string }): ReadReceipt {
  return {
    counter: 1,
    bytesTotal: 10 * MB,
    readsTotal: 1,
    lastLatencyMs: 120,
    ts: 1_000,
    ...p,
  };
}

/** Three honest readers, each attesting `mb` megabytes. */
function withReaders(ledger: ReceiptLedger, provider: string, mb: number, count = MIN_DISTINCT_READERS) {
  for (let i = 0; i < count; i++) {
    ledger.record(receipt({ reader: `r${i}`, provider, bytesTotal: mb * MB }), ok);
  }
}

describe('H-P4: the provider never meters its own pay', () => {
  it('pays on what readers attested', () => {
    const l = new ReceiptLedger();
    withReaders(l, 'P', 10);
    const e = l.earnings('P');
    expect(e.payable).toBe(true);
    expect(e.payableBytes).toBe(3 * 10 * MB);
    expect(e.distinctReaders).toBe(3);
  });

  it('refuses a receipt where the provider IS the reader', () => {
    // The defect being replaced, in one line: a provider vouching for itself.
    const l = new ReceiptLedger();
    expect(l.record(receipt({ reader: 'P', provider: 'P' }), ok))
      .toContain('self-attested');
    expect(l.earnings('P').payableBytes).toBe(0);
  });

  it('pays nothing when only one reader vouches', () => {
    // A testimonial, not an observation — the same rule as MIN_DISTINCT_PROBERS.
    const l = new ReceiptLedger();
    withReaders(l, 'P', 1000, 1);
    const e = l.earnings('P');
    expect(e.payable).toBe(false);
    expect(e.payableBytes).toBe(0);
    expect(e.attestedBytes).toBeGreaterThan(0); // seen, but not payable
    expect(e.reason).toContain('testimonial');
  });

  it('rejects a receipt whose signature does not verify', () => {
    const l = new ReceiptLedger();
    expect(l.record(receipt({ reader: 'r0', provider: 'P' }), () => false))
      .toContain('signature');
  });
});

describe('replace, do not append — the counter is the mechanism', () => {
  it('keeps ONE record per pair however many reads happen', () => {
    const l = new ReceiptLedger();
    for (let i = 1; i <= 1000; i++) {
      l.record(receipt({ reader: 'r0', provider: 'P', counter: i, bytesTotal: i * MB, readsTotal: i }), ok);
    }
    // O(counterparties), not O(interactions). That is the whole design.
    expect(l.size()).toBe(1);
    expect(l.pair('r0', 'P')).toEqual({ bytesTotal: 1000 * MB, readsTotal: 1000 });
  });

  it('rejects a replayed receipt', () => {
    const l = new ReceiptLedger();
    l.record(receipt({ reader: 'r0', provider: 'P', counter: 5, bytesTotal: 50 * MB }), ok);
    const err = l.record(receipt({ reader: 'r0', provider: 'P', counter: 5, bytesTotal: 50 * MB }), ok);
    expect(err).toContain('stale');
  });

  it('rejects a counter that goes backwards', () => {
    const l = new ReceiptLedger();
    l.record(receipt({ reader: 'r0', provider: 'P', counter: 9, bytesTotal: 90 * MB }), ok);
    expect(l.record(receipt({ reader: 'r0', provider: 'P', counter: 2, bytesTotal: 900 * MB }), ok))
      .toContain('stale');
  });

  it('rejects cumulative totals that shrink', () => {
    // Otherwise a reader could attest a large figure, let it settle, then
    // reduce it and rebuild the same bytes for a second payment.
    const l = new ReceiptLedger();
    l.record(receipt({ reader: 'r0', provider: 'P', counter: 1, bytesTotal: 100 * MB }), ok);
    expect(l.record(receipt({ reader: 'r0', provider: 'P', counter: 2, bytesTotal: 10 * MB }), ok))
      .toContain('backwards');
  });
});

describe('settlement cannot pay for the same bytes twice', () => {
  it('moves the baseline so a re-settle pays nothing', () => {
    const l = new ReceiptLedger();
    withReaders(l, 'P', 10);
    expect(l.settle('P')).toBe(3 * 10 * MB);
    expect(l.settle('P')).toBe(0);
    expect(l.earnings('P').payableBytes).toBe(0);
  });

  it('pays only the DELTA after further reads', () => {
    const l = new ReceiptLedger();
    withReaders(l, 'P', 10);
    l.settle('P');
    for (let i = 0; i < 3; i++) {
      l.record(receipt({ reader: `r${i}`, provider: 'P', counter: 2, bytesTotal: 25 * MB }), ok);
    }
    // 15 MB of new service each, not 25.
    expect(l.earnings('P').payableBytes).toBe(3 * 15 * MB);
  });
});

describe('collusion is priced, not prevented — stated honestly', () => {
  it('caps what any single reader can be worth', () => {
    const l = new ReceiptLedger();
    // Three readers, one of them claiming an absurd figure.
    l.record(receipt({ reader: 'honest1', provider: 'P', bytesTotal: 5 * MB }), ok);
    l.record(receipt({ reader: 'honest2', provider: 'P', bytesTotal: 5 * MB }), ok);
    l.record(receipt({ reader: 'friend', provider: 'P', bytesTotal: 1024 * 1024 * MB }), ok);
    const e = l.earnings('P');
    expect(e.attestedBytes).toBeGreaterThan(PER_READER_EPOCH_CAP_BYTES);
    // The inflated reader is worth at most the cap, not what it claimed.
    expect(e.payableBytes).toBe(10 * MB + PER_READER_EPOCH_CAP_BYTES);
  });

  it('makes collusion earnings scale with IDENTITIES, which cost nullifiers', () => {
    // The honest statement of the defence: not impossible, priced. Each fake
    // reader is a human-gated identity and is worth at most the cap.
    expect(collusionCeilingBytes({ identities: 1 })).toBe(PER_READER_EPOCH_CAP_BYTES);
    expect(collusionCeilingBytes({ identities: 10 })).toBe(10 * PER_READER_EPOCH_CAP_BYTES);
    // Linear, with a per-unit price set by the Sybil gate — which is the only
    // shape this project has ever been able to defend.
    const l = new ReceiptLedger();
    for (let i = 0; i < 10; i++) {
      l.record(receipt({ reader: `sybil${i}`, provider: 'P', bytesTotal: 1e15 }), ok);
    }
    expect(l.earnings('P').payableBytes).toBe(collusionCeilingBytes({ identities: 10 }));
  });
});

describe('the unverifiable field never touches the money', () => {
  it('ignores latency entirely when computing what is owed', () => {
    // Lucian asked for time-to-retrieve to be signalled, and it is — for
    // routing and reputation. It is reader-reported and unverifiable, so a
    // payout must not depend on it (SCREENING.md → 11 is the same defect).
    const fast = new ReceiptLedger();
    const slow = new ReceiptLedger();
    for (let i = 0; i < 3; i++) {
      fast.record(receipt({ reader: `r${i}`, provider: 'P', bytesTotal: 10 * MB, lastLatencyMs: 1 }), ok);
      slow.record(receipt({ reader: `r${i}`, provider: 'P', bytesTotal: 10 * MB, lastLatencyMs: 99_999 }), ok);
    }
    expect(fast.earnings('P').payableBytes).toBe(slow.earnings('P').payableBytes);
  });
});

describe('state is bounded', () => {
  it('sweeps quiet pairs that owe nothing', () => {
    const l = new ReceiptLedger();
    withReaders(l, 'P', 10);
    l.settle('P');
    expect(l.sweep(1_000 + 10_000, 5_000)).toBe(3);
    expect(l.size()).toBe(0);
  });

  it('never sweeps a pair that is still owed', () => {
    // Dropping an unsettled pair would silently destroy a provider's earnings.
    const l = new ReceiptLedger();
    withReaders(l, 'P', 10);
    expect(l.sweep(1_000 + 10_000, 5_000)).toBe(0);
    expect(l.earnings('P').payableBytes).toBe(3 * 10 * MB);
  });

  it('grows with counterparties, not with reads', () => {
    const l = new ReceiptLedger();
    for (let r = 0; r < 5; r++) {
      for (let i = 1; i <= 500; i++) {
        l.record(receipt({ reader: `r${r}`, provider: 'P', counter: i, bytesTotal: i * MB, readsTotal: i }), ok);
      }
    }
    expect(l.size()).toBe(5); // 2,500 reads, 5 records
  });
});

describe('what it costs the chain, against the system it replaces', () => {
  it('collapses interactions into counterparties, then into settlements', () => {
    // The heartbeat design writes 2,555 blocks per provider per YEAR by the
    // clock alone, whether or not anyone read anything
    // (sim/storage-accounting.ts). This writes on ACTIVITY and aggregates
    // twice before touching the chain.
    const l = new ReceiptLedger();
    const READERS = 200;
    const READS_EACH = 500;
    for (let r = 0; r < READERS; r++) {
      for (let i = 1; i <= READS_EACH; i++) {
        l.record(receipt({ reader: `r${r}`, provider: 'P', counter: i, bytesTotal: i * MB, readsTotal: i }), ok);
      }
    }
    const interactions = READERS * READS_EACH;
    expect(interactions).toBe(100_000);

    // First collapse: 100,000 reads are held as 200 records.
    expect(l.size()).toBe(READERS);
    expect(interactions / l.size()).toBe(500);

    // Second collapse: all 200 become ONE settlement on the chain.
    const settled = l.settle('P');
    expect(settled).toBeGreaterThan(0);
    // 100,000 reads → 1 block. The heartbeat design would have written 7 that
    // day regardless of whether a single byte was served.
    expect(l.earnings('P').payableBytes).toBe(0);
  });

  it('writes NOTHING when the network is quiet — the property no cadence gives', () => {
    // An idle provider under the heartbeat design writes exactly as many blocks
    // as a busy one. Here it writes none, because there is nothing to settle.
    const l = new ReceiptLedger();
    expect(l.earnings('P').payable).toBe(false);
    expect(l.settle('P')).toBe(0);
    expect(l.size()).toBe(0);
  });
});

describe('ReaderReceiptBook — the attesting side', () => {
  it('produces a monotone cumulative receipt per provider', () => {
    const book = new ReaderReceiptBook('reader-1');
    const a = book.record({ provider: 'P', creditedBytes: 100, latencyMs: 10, now: 1 })!;
    const b = book.record({ provider: 'P', creditedBytes: 250, latencyMs: 20, now: 2 })!;
    expect(a.counter).toBe(1);
    expect(b.counter).toBe(2);
    expect(b.bytesTotal).toBe(350);
    expect(b.readsTotal).toBe(2);
  });

  it('keeps ONE record per provider however many reads happen', () => {
    const book = new ReaderReceiptBook('reader-1');
    for (let i = 0; i < 5_000; i++) book.record({ provider: 'P', creditedBytes: 1, latencyMs: 1 });
    expect(book.size()).toBe(1);
    expect(book.latest('P')!.readsTotal).toBe(5_000);
  });

  it('refuses to vouch for itself', () => {
    const book = new ReaderReceiptBook('me');
    expect(book.record({ provider: 'me', creditedBytes: 100, latencyMs: 1 })).toBeNull();
  });

  it('emits nothing for a read the taper zeroed out', () => {
    // A repeat fetch inside the cache window is worth nothing, so there is no
    // receipt to send — the counter does not advance on it either.
    const book = new ReaderReceiptBook('reader-1');
    book.record({ provider: 'P', creditedBytes: 100, latencyMs: 1 });
    expect(book.record({ provider: 'P', creditedBytes: 0, latencyMs: 1 })).toBeNull();
    expect(book.latest('P')!.counter).toBe(1);
  });

  it('sweeps providers gone quiet', () => {
    const book = new ReaderReceiptBook('reader-1');
    book.record({ provider: 'P', creditedBytes: 1, latencyMs: 1, now: 1_000 });
    expect(book.sweep(2_000, 500)).toBe(1);
    expect(book.size()).toBe(0);
  });
});
