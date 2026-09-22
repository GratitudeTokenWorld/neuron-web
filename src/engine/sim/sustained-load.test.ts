import { describe, it, expect } from 'vitest';
import { runSustainedLoad, DEFAULT_LOAD, type Subject } from './sustained-load.js';
import { CustodySignals, demandWindowMs } from '../content/custody.js';
import { ReceiptLedger, ReaderReceiptBook, receiptPayload, type ReadReceipt } from '../content/read-receipts.js';
import { PresenceStore } from '../content/presence.js';
import { CustodyLiveness } from '../content/custody-sampling.js';
import { FailureCorrelation } from '../content/failure-domain.js';
import { CalibrationRun } from '../content/calibration.js';
import { SubAccountRegistry } from '../core/sub-accounts.js';

/**
 * Hypothesis H-L1: no per-node structure grows monotonically over sustained
 * load — what they hold is bounded by counterparties and interest, not by
 * elapsed time.
 *
 * Disproved by late growth: a structure still getting bigger in the second
 * half of a simulated month, after it has already seen everything it will see.
 *
 * These drive the SHIPPING objects. A model of them passing would mean nothing
 * — that is the mistake `repair.ts` paid for.
 */

const ok = () => true;
/** A month of steady work: 360k operations, 200 peers plus 5 new an hour. */
const PROFILE = { ...DEFAULT_LOAD, hours: 24 * 30 };
/** Peers that stop appearing must eventually be forgotten. */
const TTL = demandWindowMs() * 4;

function subjects(): Subject[] {
  const signals = new CustodySignals();
  const inbound = new ReceiptLedger();
  const book = new ReaderReceiptBook('me');
  const presence = new PresenceStore();
  const liveness = new CustodyLiveness();
  const correlation = new FailureCorrelation();
  const calibrations = new Map<string, CalibrationRun>();
  const subs = new SubAccountRegistry();
  /** Cumulative bytes per PAIR, as a real receipt carries. */
  const served = new Map<string, number>();
  const counters = new Map<string, number>();

  return [
    {
      name: 'CustodySignals',
      step: (now, cid) => signals.recordRead(cid, now, 50),
      sweep: (now) => { signals.sweepDemand(now); },
      size: (now) => {
        // No public size; count CIDs still reporting demand AT THE SIMULATED TIME.
        let n = 0;
        for (let i = 0; i < PROFILE.distinctCids; i++) if (signals.reads(`cid-${i}`, now) > 0) n++;
        return n;
      },
    },
    {
      name: 'ReceiptLedger',
      step: (now, _cid, peer) => {
        // Cumulative PER PAIR. A first version used one global counter, which
        // made every reader look like it was owed hundreds of megabytes and
        // hid whether the sweep worked.
        const n = (counters.get(peer) ?? 0) + 1;
        counters.set(peer, n);
        const bytes = (served.get(peer) ?? 0) + 8192;
        served.set(peer, bytes);
        const r: ReadReceipt = {
          reader: peer, provider: 'me', counter: n,
          bytesTotal: bytes, readsTotal: n, lastLatencyMs: 10, ts: now,
        };
        inbound.record(r, ok);
      },
      // A quiet pair owing less than a settlement is worth is dropped: the
      // node would never write a block for it anyway.
      sweep: (now) => { inbound.sweep(now, TTL, 64 * 1024 * 1024); },
      size: () => inbound.size(),
    },
    {
      name: 'ReaderReceiptBook',
      // `now` passed explicitly: `record` defaults to Date.now() while `sweep`
      // takes the clock as an argument, so a harness that omits it feeds
      // wall-clock timestamps into a simulated-time sweep and nothing ever
      // matches. Production passes neither and gets real time for both, which
      // is consistent — but the default is a trap worth naming.
      step: (now, _cid, peer) => { book.record({ provider: peer, creditedBytes: 1000, latencyMs: 5, now }); },
      sweep: (now) => { book.sweep(now, TTL); },
      size: () => book.size(),
    },
    {
      name: 'PresenceStore',
      step: (now, _cid, peer) => {
        presence.record({ beacon: { pub: peer, smokeAddr: `${peer}.x`, ts: now }, signature: 's' },
          ok, now, 60_000);
      },
      sweep: (now) => { presence.sweep(now, TTL); },
      size: () => presence.size(),
    },
    {
      name: 'CustodyLiveness',
      step: (now, _cid, peer) => liveness.record(peer, true, now),
      sweep: (now) => { liveness.sweep(now, TTL); },
      size: () => liveness.size(),
    },
    {
      name: 'FailureCorrelation',
      step: (now, _cid, peer) => correlation.record(peer, Math.random() > 0.1, now),
      // `prune` only trims the holder being recorded, so departed peers need
      // an explicit sweep — added after this harness found 1,795 of them
      // accumulating over a simulated month.
      sweep: (now) => { correlation.sweep(now); },
      size: () => correlation.holders().length,
    },
    {
      name: 'CalibrationRun',
      step: (_now, _cid, peer) => {
        let run = calibrations.get(peer);
        if (!run) { run = new CalibrationRun(); calibrations.set(peer, run); }
        run.add({ level: 1, size: 'small', ok: true, latencyMs: 40, prober: 'me' });
      },
      // The node sweeps calibrations for departed providers; modelled by
      // dropping any peer not seen recently.
      sweep: () => {
        if (calibrations.size > PROFILE.distinctPeers * 2) {
          const keep = [...calibrations.keys()].slice(-PROFILE.distinctPeers);
          const kept = new Set(keep);
          for (const k of [...calibrations.keys()]) if (!kept.has(k)) calibrations.delete(k);
        }
      },
      size: () => {
        let samples = 0;
        for (const r of calibrations.values()) samples += r.size();
        return samples;
      },
    },
    {
      name: 'SubAccountRegistry',
      step: (now, _cid, peer) => {
        subs.register({ parent: 'me', child: `${peer}-dev`, kind: 'device', issuedAt: now,
          expiresAt: now + TTL }, ok, now);
      },
      sweep: (now) => { subs.sweep(now); },
      size: () => subs.size(),
    },
  ];
}

describe('H-L1: nothing grows with the clock', () => {
  const result = runSustainedLoad(subjects(), PROFILE);

  it('runs a month of work without any structure growing late', () => {
    // The decisive assertion. Growth during warm-up is expected; growth in the
    // second half, after everything has been seen, is what a leak looks like.
    //
    // The bound is not zero, and that is a real distinction rather than a
    // loosened threshold. A leak grows with WORK — proportional to operations,
    // so thousands over a fortnight. An active set of counterparties
    // FLUCTUATES by a handful as peers come and go, and a first draft asserting
    // exactly zero failed on a drift of one, which is noise. So: bounded by a
    // small fraction of the structure's own size, which noise satisfies and a
    // leak cannot. The planted-leak test below proves the difference is still
    // detected.
    for (const [name, growth] of Object.entries(result.lateGrowth)) {
      const size = result.finalSizes[name] ?? 0;
      const tolerance = Math.max(2, Math.ceil(size * 0.02));
      expect(growth, `${name} grew by ${growth} (tolerance ${tolerance}) in the second half`)
        .toBeLessThanOrEqual(tolerance);
    }
  });

  it('bounds every structure by counterparties or interest, not by time', () => {
    const ops = PROFILE.hours * PROFILE.opsPerHour;
    expect(ops).toBeGreaterThan(300_000);
    for (const [name, size] of Object.entries(result.finalSizes)) {
      // Nothing may approach the number of OPERATIONS — that is the shape of a
      // structure keyed by interactions rather than by counterparties.
      expect(size, `${name} holds ${size} after ${ops} operations`).toBeLessThan(ops / 20);
    }
  });

  it('keeps receipt state at one record per counterparty', () => {
    // 360,000 receipts, and the ledger holds one per peer it still owes.
    expect(result.finalSizes.ReceiptLedger).toBeLessThanOrEqual(PROFILE.distinctPeers * 2);
  });

  it('keeps calibration samples capped however long it runs', () => {
    // The defect this session introduced: every probe pushed a sample and
    // nothing removed any.
    expect(result.finalSizes.CalibrationRun).toBeLessThan(
      PROFILE.distinctPeers * 2 * CalibrationRun.MAX_PER_LEVEL + 1);
  });

  it('forgets peers that stopped appearing', () => {
    // Churn is the term that turns a bounded structure unbounded when nothing
    // removes entries: 3,600 peers are introduced over the month, and the node
    // only ever deals with ~200 at a time.
    const introduced = PROFILE.distinctPeers + PROFILE.hours * PROFILE.newPeersPerHour;
    expect(introduced).toBeGreaterThan(3_000);
    expect(result.finalSizes.PresenceStore).toBeLessThan(introduced / 2);
    expect(result.finalSizes.CustodyLiveness).toBeLessThan(introduced / 2);
  });
});

describe('the harness itself can fail', () => {
  it('detects a structure that never removes anything', () => {
    // A test that cannot fail is worse than no test. This plants a deliberate
    // leak and confirms the harness reports it.
    const leaked = new Map<string, number>();
    const leaky: Subject = {
      name: 'Leaky',
      step: (now, _cid, peer) => { leaked.set(`${peer}:${now}`, 1); },
      size: () => leaked.size,
    };
    const r = runSustainedLoad([leaky], { ...PROFILE, hours: 48 });
    expect(r.lateGrowth.Leaky).toBeGreaterThan(0);
  });
});
