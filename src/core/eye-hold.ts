/**
 * The "eyes held closed" decision, extracted so it can be tested against a
 * frame rate — which is the thing that broke it.
 *
 * The close-eyes challenge tests a WINDOW MEAN rather than a single frame: a
 * closure moves EAR only ~6% per frame, buried in noise, but averaging n frames
 * shrinks that noise by sqrt(n) and the same gap becomes decisive. So the check
 * needs two independent things to be true — the closure was SUSTAINED (time),
 * and it was MEASURED enough times (samples).
 *
 * Those two were collapsed into one window: the mean was taken over the frames
 * inside the last `holdMs`, and the pass required at least 4 of them. With a
 * 500 ms hold that silently means "at least 8 fps". A laptop clears it; a phone
 * running face-api at 3-5 fps puts 2 frames in that window and can NEVER put 4
 * there, however long the user holds. Everything else about the check —
 * including the progress bar, which is driven by depth and the buffer's own span
 * — reaches completion, so the bar sits at 100% while the pass can never fire.
 *
 * This is the third instance of the same family in this file (a rolling
 * reference that chased the closure, a span measured on a window that could not
 * reach its own length, and now a sample count that assumes a frame rate), and
 * the first two are already written up in CLAUDE.md. The rule: **never let a
 * time-boxed window carry a minimum sample count.** Time and evidence are
 * separate requirements and have to be satisfied separately.
 *
 * So: the closure must have been sustained for `holdMs` (judged on the whole
 * buffer, which is the only thing that can actually span that long), and the
 * mean is taken over at least `minSamples` frames, reaching further back in time
 * when the hardware is slow. On fast hardware this is exactly the old
 * behaviour — the last `holdMs` already holds more than `minSamples` frames.
 */

export interface EarSample {
  /** ms timestamp. */
  t: number;
  /** Eye aspect ratio for the frame. */
  ear: number;
}

/**
 * Frames the mean must cover. Four is what makes the sqrt(n) averaging worth
 * anything; it is a statistical floor, not a duration, which is exactly why it
 * must not be expressed as one.
 */
export const MIN_HOLD_SAMPLES = 4;

export interface ClosureHold {
  /** Frames the mean was taken over. */
  samples: readonly EarSample[];
  /** Mean EAR across them (0 when there are none). */
  mean: number;
  /** How long the whole buffer covers — the sustained-for test. */
  bufferSpan: number;
  /** How long the averaged frames themselves cover, for diagnostics. */
  sampleSpan: number;
  /** Observed capture rate, so a slow device is visible in the trace. */
  fps: number;
  /** Sustained long enough AND measured enough times. */
  held: boolean;
}

/**
 * Decide whether a closure has been held, and over which frames to average.
 *
 * `buffer` is the recent EAR history, oldest first (the caller prunes it to a
 * few seconds). `now` is the current time.
 */
export function closureHold(
  buffer: readonly EarSample[],
  now: number,
  holdMs: number,
  minSamples: number = MIN_HOLD_SAMPLES,
): ClosureHold {
  // SUSTAINED: judged on the full buffer. Deliberately not on the averaged
  // frames — when those are "everything inside the last holdMs", their own span
  // is under holdMs by construction, so requiring it to reach holdMs makes the
  // test unsatisfiable. (That exact bug shipped once already.)
  const bufferSpan = buffer.length ? now - buffer[0]!.t : 0;

  const inHold = buffer.filter(s => now - s.t <= holdMs);
  // MEASURED: prefer the frames inside the hold, but when the device is too slow
  // to put `minSamples` of them there, reach further back instead of failing
  // forever. Averaging older frames is conservative — if any of them predate the
  // closure the mean rises and the check simply does not pass yet.
  const samples = inHold.length >= minSamples ? inHold : buffer.slice(-minSamples);

  const mean = samples.length
    ? samples.reduce((a, s) => a + s.ear, 0) / samples.length
    : 0;
  const sampleSpan = samples.length ? now - samples[0]!.t : 0;
  const fps = bufferSpan > 0 ? (buffer.length - 1) / (bufferSpan / 1000) : 0;

  return {
    samples,
    mean,
    bufferSpan,
    sampleSpan,
    fps,
    held: bufferSpan >= holdMs && samples.length >= minSamples,
  };
}
