import { describe, it, expect } from 'vitest';
import { closureHold, MIN_HOLD_SAMPLES, type EarSample } from './eye-hold.js';

/**
 * The close-eyes hold, tested AT A FRAME RATE — the variable that broke it and
 * that no previous test varied.
 *
 * The bug: the mean was taken over frames inside the last 500 ms and the pass
 * required 4 of them, which silently means "at least 8 fps". A laptop clears it;
 * a phone running face-api at 3-5 fps can never put 4 frames in that window,
 * however long the user holds. The bar, driven by the buffer's own span, still
 * ran to 100%.
 */

const HOLD = 500;
const CLOSED = 0.29;
const OPEN = 0.33;

/** `n` frames at `fps`, ending at `now`, oldest first. */
function stream(now: number, fps: number, n: number, ear: number | ((i: number) => number)): EarSample[] {
  const step = 1000 / fps;
  return Array.from({ length: n }, (_, i) => ({
    t: now - (n - 1 - i) * step,
    ear: typeof ear === 'function' ? ear(i) : ear,
  }));
}

describe('closureHold', () => {
  it('holds on a laptop (16 fps) exactly as it always did', () => {
    const now = 10_000;
    const buffer = stream(now, 16, 48, CLOSED);       // 3 s of history
    const hold = closureHold(buffer, now, HOLD);
    expect(hold.held).toBe(true);
    expect(hold.mean).toBeCloseTo(CLOSED, 6);
    // Fast enough that the hold window alone supplies the samples: the averaged
    // frames stay inside 500 ms, which is the behaviour being preserved.
    expect(hold.sampleSpan).toBeLessThanOrEqual(HOLD);
    expect(hold.samples.length).toBeGreaterThanOrEqual(MIN_HOLD_SAMPLES);
  });

  it('holds on a phone (4 fps), where the old rule was unsatisfiable', () => {
    const now = 10_000;
    const buffer = stream(now, 4, 12, CLOSED);        // 3 s at 250 ms/frame
    // The old rule: frames inside the last 500 ms, needing 4 of them.
    expect(buffer.filter(s => now - s.t <= HOLD).length).toBeLessThan(MIN_HOLD_SAMPLES);

    const hold = closureHold(buffer, now, HOLD);
    expect(hold.held).toBe(true);                      // ...and now it passes
    expect(hold.samples.length).toBe(MIN_HOLD_SAMPLES);
    expect(hold.sampleSpan).toBeGreaterThan(HOLD);     // reached further back
    expect(hold.mean).toBeCloseTo(CLOSED, 6);
    expect(hold.fps).toBeCloseTo(4, 1);
  });

  it('still refuses a closure that has not been sustained long enough', () => {
    const now = 10_000;
    // Plenty of frames, but only 300 ms of history — the closure is too young.
    const buffer = stream(now, 30, 10, CLOSED);
    expect(buffer.length).toBeGreaterThan(MIN_HOLD_SAMPLES);
    expect(closureHold(buffer, now, HOLD).held).toBe(false);
  });

  it('refuses when there are too few frames to average at all', () => {
    const now = 10_000;
    // Long history, but only 3 frames in it: 1.5 fps. Time is satisfied,
    // evidence is not, and the two are judged separately.
    const buffer = stream(now, 1.5, 3, CLOSED);
    const hold = closureHold(buffer, now, HOLD);
    expect(hold.bufferSpan).toBeGreaterThan(HOLD);
    expect(hold.held).toBe(false);
  });

  it('fails CLOSED when reaching back picks up pre-closure frames', () => {
    const now = 10_000;
    // 4 fps, eyes open until the last two frames. Reaching back for a fourth
    // sample drags open frames into the mean, so it sits well above a closure —
    // the user simply has to hold a little longer. Conservative, not lenient.
    const buffer = stream(now, 4, 6, i => (i < 4 ? OPEN : CLOSED));
    const hold = closureHold(buffer, now, HOLD);
    expect(hold.held).toBe(true);                       // enough frames…
    expect(hold.mean).toBeGreaterThan(CLOSED);          // …but not a closed mean
    expect(hold.mean).toBeCloseTo((OPEN * 2 + CLOSED * 2) / 4, 6);
  });

  it('reports the observed frame rate so a slow device is visible in the trace', () => {
    const now = 10_000;
    expect(closureHold(stream(now, 16, 33, CLOSED), now, HOLD).fps).toBeCloseTo(16, 1);
    expect(closureHold(stream(now, 3, 10, CLOSED), now, HOLD).fps).toBeCloseTo(3, 1);
  });

  it('survives an empty buffer', () => {
    const hold = closureHold([], 10_000, HOLD);
    expect(hold.held).toBe(false);
    expect(hold.mean).toBe(0);
    expect(hold.fps).toBe(0);
  });

  it('never passes on a rate the hold window alone could satisfy but the mean is open', () => {
    const now = 10_000;
    const buffer = stream(now, 16, 48, OPEN);
    const hold = closureHold(buffer, now, HOLD);
    expect(hold.held).toBe(true);          // held is about time+evidence only…
    expect(hold.mean).toBeCloseTo(OPEN, 6); // …the caller still compares the mean
  });
});
