// face-api bundles its own @tensorflow/tfjs; use it via `faceapi.tf` so there is a
// SINGLE tfjs instance. Importing @tensorflow/tfjs separately created a second copy
// that re-registered every kernel and spammed the console with "already registered".
import * as faceapi from '@vladmandic/face-api';
import { bytesToHex } from './dag-block';

let modelsLoaded = false;

const MODEL_URL = '/models';
const MATCH_THRESHOLD = 0.45;
const ENROLLMENT_SAMPLES = 3;
/** Quantization bin size - coarser = more stable across sessions, less unique */
const QUANT_BIN = 0.1;

export interface FaceDescriptor {
  data: number[];
  capturedAt: number;
}

export interface FaceMap {
  canonical: number[];
  quantized: number[];
  hash: string;
  samples: number;
  createdAt: number;
}

// ──── Model Loading ────

export async function loadModels(): Promise<void> {
  if (modelsLoaded) return;
  await faceapi.tf.ready();
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  modelsLoaded = true;
}

export function areModelsLoaded(): boolean {
  return modelsLoaded;
}

// ──── Camera ────

export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
  });
  video.srcObject = stream;
  // Resolve only once playback has actually begun — onloadedmetadata fires when dimensions
  // are known but before any frame is rendered, so awaiting play() here prevents callers
  // from running face detection against an empty/not-yet-streaming video element.
  await new Promise<void>((resolve) => {
    video.onloadedmetadata = () => { void video.play().catch(() => {}).finally(resolve); };
  });
  return stream;
}

export function stopCamera(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

// ──── Capture cues (UI contract) ────

/** Which wireframe animation the UI should overlay on the camera feed. */
export type CaptureGuide = 'search' | 'turn' | 'blink' | 'eyes' | 'smile' | 'mouth' | 'brow' | 'depth' | 'hold';

/** An action the user can be challenged to perform. */
export type ChallengeAction = 'blink' | 'close-eyes' | 'smile' | 'mouth-open' | 'raise-brows' | 'move-depth' | 'look-left' | 'look-right';

/**
 * The expressions demanded per enrollment, drawn in a random order alongside a
 * head turn.
 *
 * `blink` is excluded and `close-eyes` is its replacement — the difference is
 * measurement, not eyelids. Measured on real hardware, EAR moves only ~6% when
 * this model's subject shuts their eyes (closed 0.296 vs open 0.314) with
 * per-frame noise of sd 0.009, so no single-frame threshold can separate them.
 * A blink is additionally a ~100ms transient that falls between frames. Holding
 * the eyes shut makes it a STATE, and averaging the hold window shrinks the
 * noise by sqrt(n): over ~6 frames the same 6% gap becomes ~4.8 sigma, which is
 * decisive. Hence close-eyes tests the WINDOW MEAN against a margin derived from
 * the user's own measured jitter, and blink stays out.
 */
export const CHALLENGE_EXPRESSIONS: readonly ChallengeAction[] =
  ['smile', 'mouth-open', 'raise-brows', 'close-eyes', 'move-depth'];

/**
 * How many expressions are demanded per enrollment (plus the head turn).
 * All of them: five actions in an unpredictable order means a replayed video
 * must contain every one of them in the exact drawn sequence — 120 orderings.
 */
export const EXPRESSIONS_PER_RUN = CHALLENGE_EXPRESSIONS.length;

/**
 * One frame of capture feedback. Structured rather than a pre-baked sentence so
 * the UI can drive a progress bar and an animation from the same signal — a
 * string can only be printed, and printing it twice (header + overlay) is what
 * the old UI did.
 *
 * `left`/`right` are independent 0–100 fills for a centre-anchored bar: a
 * head-turn fills the side being turned toward, everything else fills both
 * evenly. Feedback therefore mirrors what the user is physically doing.
 */
export interface CaptureCue {
  /** Short imperative, already free of step/sample bookkeeping. */
  label: string;
  guide: CaptureGuide;
  left?: number;
  right?: number;
  /** For a head turn: which way the user is being ASKED to turn. */
  dir?: 'left' | 'right';
  state?: 'ok' | 'fail';
}

// ──── Presence continuity (anti-swap) ────

/**
 * Longest gap with NO detected face before an enrollment is void.
 *
 * 1000 ms, not 2000: the detector samples every ~80–100 ms, so a second still
 * tolerates ~10 consecutive misses — ample for motion blur during a fast head
 * turn, a dropped frame, or a slow laptop — while being too short to physically
 * swap a phone/print in front of the lens. Two seconds is comfortably enough
 * time to make that swap, which is exactly the attack this closes.
 */
export const FACE_ABSENCE_LIMIT_MS = 1000;

/**
 * Continuity across a whole enrollment: the same face must stay in frame from
 * the first challenge through the last capture sample. Without it, an attacker
 * can satisfy the challenges with their own live face and then swap in a photo
 * of someone else for the capture that actually becomes the identity — the
 * challenges prove *a* human was present, not that they are the person enrolled.
 *
 * Shared by reference across every stage so absence is measured over the gaps
 * between stages too, which is where a swap would happen.
 */
export interface PresenceGuard {
  lastSeenAt: number;
  maxAbsenceMs: number;
  /** Latched: once continuity breaks the enrollment cannot be salvaged. */
  lost: boolean;
}

export function newPresenceGuard(maxAbsenceMs = FACE_ABSENCE_LIMIT_MS): PresenceGuard {
  return { lastSeenAt: Date.now(), maxAbsenceMs, lost: false };
}

/** Record a sighting. */
function markSeen(guard?: PresenceGuard): void {
  if (guard) guard.lastSeenAt = Date.now();
}

/** True when the face has been gone too long (latches `lost`). */
function absenceBroken(guard?: PresenceGuard): boolean {
  if (!guard) return false;
  if (guard.lost) return true;
  if (Date.now() - guard.lastSeenAt > guard.maxAbsenceMs) guard.lost = true;
  return guard.lost;
}

/**
 * Wait `ms` while keeping the presence guard fed — used for the pauses BETWEEN
 * challenge actions and between capture samples, which would otherwise be blind
 * windows. Returns false if continuity broke. Detection here skips landmarks
 * (presence only), so it is cheaper than the action detectors.
 */
export async function holdPresence(
  video: HTMLVideoElement,
  ms: number,
  guard?: PresenceGuard,
  onStatus?: (cue: CaptureCue) => void,
): Promise<boolean> {
  const until = Date.now() + ms;
  if (!guard) { await sleep(ms); return true; }
  while (Date.now() < until) {
    try {
      const det = await faceapi.detectSingleFace(
        video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 }),
      );
      if (det) markSeen(guard);
    } catch { /* treat as a miss */ }
    if (absenceBroken(guard)) {
      onStatus?.({ label: 'Face lost — start again', guide: 'search', state: 'fail', left: 0, right: 0 });
      return false;
    }
    await sleep(80);
  }
  return true;
}

// ──── Face Descriptor Capture ────

export async function captureFaceDescriptor(video: HTMLVideoElement): Promise<FaceDescriptor | null> {
  try {
    const detection = await faceapi
      // 320, not 416: the larger input missed the face repeatedly during capture
      // (observed 9 misses across 3 samples) while every other stage runs happily
      // at 320. Detector input size sets the bounding box; the descriptor itself
      // is computed from a fixed-size aligned crop, so quality is unaffected.
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) return null;

    return {
      data: Array.from(detection.descriptor),
      capturedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Enroll a face: capture multiple samples, average into canonical descriptor,
 * then quantize for stable key derivation.
 */
export async function enrollFace(
  video: HTMLVideoElement,
  onProgress: (step: number, total: number, cue: CaptureCue) => void,
  guard?: PresenceGuard,
): Promise<FaceMap | null> {
  const descriptors: number[][] = [];
  let retries = 0;
  const pct = (n: number) => Math.round((n / ENROLLMENT_SAMPLES) * 100);

  for (let i = 0; i < ENROLLMENT_SAMPLES; i++) {
    onProgress(i + 1, ENROLLMENT_SAMPLES, {
      label: `Hold still ${i + 1}/${ENROLLMENT_SAMPLES}`,
      guide: 'hold', left: pct(i), right: pct(i),
    });
    // Watched pause, not a blind sleep: the window between samples is the last
    // place a swapped face could slip in unnoticed.
    if (!await holdPresence(video, 800, guard, c => onProgress(i + 1, ENROLLMENT_SAMPLES, c))) return null;

    const desc = await captureFaceDescriptor(video);
    debugMetrics(`enroll sample ${i + 1}/${ENROLLMENT_SAMPLES} descriptor=${desc ? 'ok' : 'MISS'} retries=${retries}`);
    if (!desc) {
      if (retries++ > 10) { debugMetrics('enroll GAVE UP after 10 misses'); return null; }
      onProgress(i + 1, ENROLLMENT_SAMPLES, {
        label: 'Look at the camera', guide: 'search', left: pct(i), right: pct(i),
      });
      i--;
      if (!await holdPresence(video, 1000, guard, c => onProgress(i + 2, ENROLLMENT_SAMPLES, c))) return null;
      continue;
    }
    markSeen(guard);
    descriptors.push(desc.data);
    onProgress(i + 1, ENROLLMENT_SAMPLES, {
      label: `Hold still ${i + 1}/${ENROLLMENT_SAMPLES}`,
      guide: 'hold', left: pct(i + 1), right: pct(i + 1),
    });
  }

  if (guard?.lost) return null;
  if (descriptors.length < ENROLLMENT_SAMPLES) return null;

  // Average descriptors
  const canonical = new Array(128).fill(0);
  for (const d of descriptors) {
    for (let i = 0; i < 128; i++) canonical[i] += d[i];
  }
  for (let i = 0; i < 128; i++) canonical[i] /= descriptors.length;

  const quantized = quantizeDescriptor(canonical);
  const hash = await hashDescriptor(quantized);

  return { canonical, quantized, hash, samples: descriptors.length, createdAt: Date.now() };
}

// ──── Challenge Action Detection ────

type Point = { x: number; y: number };

function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function eyeAspectRatio(pts: Point[]): number {
  // pts[0..5] = 6 eye landmarks (one eye)
  // EAR = (||p2-p6|| + ||p3-p5||) / (2 * ||p1-p4||)
  const A = dist(pts[1], pts[5]);
  const B = dist(pts[2], pts[4]);
  const C = dist(pts[0], pts[3]);
  return C < 0.001 ? 0 : (A + B) / (2 * C);
}

/**
 * Scale reference: outer eye corners (36 ↔ 45). Independent of mouth state and
 * of how far the user sits from the camera, so mouth measurements normalised by
 * it are comparable frame to frame.
 */
function faceScale(pts: Point[]): number {
  return dist(pts[36], pts[45]);
}

/**
 * Smile geometry, normalised by face scale.
 *
 * The previous metric was mouthHeight/mouthWidth, which measures how far the
 * mouth is OPEN, not whether it is smiling: a closed-lip smile widens the mouth
 * and pushes that ratio DOWN, while merely parting the lips pushes it up past
 * the threshold — so it passed without a smile and failed with one.
 *
 * A smile has two robust signatures instead:
 *  - `lift`  — the corners rise relative to the mouth's vertical centre
 *              (y grows downward, so corners above centre ⇒ positive)
 *  - `width` — the mouth widens
 * Both are compared against the user's OWN neutral face (see calibration in
 * detectChallenge), because absolute values vary hugely between faces.
 */
function mouthMetrics(pts: Point[]): { lift: number; width: number; open: number } {
  const s = faceScale(pts) || 1;
  const centreY = (pts[51].y + pts[57].y) / 2;
  const cornerY = (pts[48].y + pts[54].y) / 2;
  const w = dist(pts[48], pts[54]);
  return {
    lift: (centreY - cornerY) / s,
    width: w / s,
    // Jaw drop: lip gap over mouth width. Huge, unambiguous signal (neutral
    // ~0.1, open ~0.5+) — the one facial action this landmark model reports
    // reliably on every face.
    open: w < 0.001 ? 0 : dist(pts[51], pts[57]) / w,
  };
}

/**
 * TWO independent head-yaw estimates, both translation- and scale-invariant.
 *
 * A single estimate is not enough: sliding the body sideways still shifts a face
 * that sits off-centre in the lens, because perspective genuinely rotates it a
 * little. Demanding that two estimators built from *different* landmark groups
 * agree — in magnitude and in sign — separates a deliberate head rotation from
 * that residual perspective drift.
 *
 *  - `skew`     nose tip's distance to the far vs near outer eye corner,
 *               normalised by eye span. Eye landmarks are the most stable in the
 *               68-point model, so this is the primary signal.
 *  - `jawRatio` nose tip's position between the jaw edges (0.5 facing forward).
 *               Silhouette points are noisier, so it acts as the corroborator.
 *
 * Both are 0-centred at rest (jawRatio at 0.5) and both grow in the SAME
 * direction as the head turns, so a sign check is meaningful.
 */
/**
 * Where the face sits in the frame, 0–1 across the width.
 *
 * This is what separates "turned my head" from "slid my body sideways", and
 * nothing else can: translating in front of a lens genuinely rotates the face
 * relative to the camera axis (10cm at 60cm ≈ 10° of apparent yaw), so every
 * landmark-based yaw metric reports a real turn either way. The difference is
 * that a head rotation pivots at the neck and barely moves the face across the
 * frame, while a body shift moves it a long way — measured here so a turn can
 * require yaw *without* displacement.
 */
function frameCentreX(pts: Point[], videoWidth: number): number {
  return ((pts[36].x + pts[45].x) / 2) / (videoWidth || 640);
}

function yawSignals(pts: Point[]): { skew: number; jawRatio: number } {
  const nose = pts[30];
  const eyeR = pts[36];               // subject's right eye, outer corner
  const eyeL = pts[45];               // subject's left eye, outer corner
  const eyeSpan = dist(eyeR, eyeL) || 1;
  const jawSpan = pts[16].x - pts[0].x;
  return {
    skew: (dist(nose, eyeR) - dist(nose, eyeL)) / eyeSpan,
    jawRatio: Math.abs(jawSpan) < 1 ? 0.5 : (nose.x - pts[0].x) / jawSpan,
  };
}

/** Every per-frame measurement the challenges compare against neutral. */
interface FaceMetrics {
  ear: number; lift: number; width: number; open: number;
  yaw: number; skew: number; centreX: number; brow: number;
  /** Eye span as a fraction of frame width — how big the head is. */
  frac: number;
  /**
   * PERSPECTIVE shape: eye span over jaw width.
   *
   * The eyes sit ~8-10cm nearer the lens than the jaw silhouette, so on a real
   * 3D head this ratio RISES as the face approaches (near features magnify
   * faster) and falls as it recedes. On a flat surface — a phone, a tablet, a
   * printed photo — every point is the same distance away, so moving it only
   * scales the image and this ratio does not change at all. That difference is
   * what the depth challenge tests, and it is the one check a screen replay
   * cannot fake no matter what it displays.
   */
  shape: number;
}

/** Neutral plus the measured jitter of the open-eye signal (see close-eyes). */
export interface NeutralStats { earSd: number; }

/**
 * Eyebrow raise: vertical gap between brow centres and the upper eyelids,
 * normalised by face scale. Large, deliberate, and — unlike a blink — held long
 * enough to be sampled at any frame rate.
 */
function browLift(pts: Point[]): number {
  const s = faceScale(pts) || 1;
  const brow = (pts[19].y + pts[24].y) / 2;                       // mid of each eyebrow
  const lid = (pts[37].y + pts[38].y + pts[43].y + pts[44].y) / 4; // upper eyelids
  return (lid - brow) / s;
}

function metricsOf(pts: Point[], videoWidth: number): FaceMetrics {
  const m = mouthMetrics(pts);
  const y = yawSignals(pts);
  const rightEAR = eyeAspectRatio(pts.slice(36, 42));
  const leftEAR = eyeAspectRatio(pts.slice(42, 48));
  return {
    ear: (rightEAR + leftEAR) / 2,
    lift: m.lift, width: m.width, open: m.open,
    yaw: y.jawRatio, skew: y.skew,
    centreX: frameCentreX(pts, videoWidth),
    brow: browLift(pts),
    frac: faceScale(pts) / (videoWidth || 640),
    shape: (() => {
      const jaw = Math.abs(pts[16].x - pts[0].x);
      return jaw < 1 ? 0 : faceScale(pts) / jaw;
    })(),
  };
}

/** The user's relaxed face, measured once per enrollment. */
export type NeutralBaseline = FaceMetrics & NeutralStats;

/**
 * Measure the neutral face ONCE, before any action is asked for.
 *
 * Per-action calibration was being poisoned by the previous action's tail: real
 * runs recorded "neutral" at width=0.70 (still smiling) and open=0.70 (mouth
 * still open) against true neutrals of 0.55 and 0.30 — half the baselines in a
 * single session. A poisoned baseline makes the next check either unpassable or
 * free, which is the "passed instantly without doing anything" symptom. Taken
 * here, before the first prompt, the face is by definition at rest.
 *
 * 10 frames, first 4 discarded (transition), median of the rest.
 */
export async function calibrateNeutral(
  video: HTMLVideoElement,
  onStatus?: (cue: CaptureCue) => void,
  guard?: PresenceGuard,
): Promise<NeutralBaseline | null> {
  const FRAMES = 8;
  // The baseline is taken right after the liveness step, which just asked the
  // user to turn their head both ways — so the face is often still rotated. A
  // real run recorded neutral at yaw=0.817 / skew=0.387 (frontal is ~0.55 / ~0),
  // and every later comparison was measured against that lie: simply facing
  // forward again then read as a huge "turn". Frames are therefore only accepted
  // while the face is FRONTAL and STILL; anything else restarts the window.
  const FRONTAL_YAW = 0.13;     // |yaw − 0.55| — covers normal facial asymmetry
  const FRONTAL_SKEW = 0.15;
  const STABLE_YAW_RANGE = 0.04;
  // FRAMING, checked before anything else. Every metric is a normalised ratio, so
  // a face far from the camera still "works" — but at that distance the landmarks
  // are a handful of pixels apart, which is what makes the expression deltas noisy
  // and the captured descriptor weak. Demand a properly framed head up front
  // instead of letting a distant face produce unreliable results throughout.
  const MIN_FACE_FRAC = 0.13;   // eye span as a fraction of frame width
  const MAX_FACE_FRAC = 0.45;   // too close: the face gets cropped
  const CENTRE_MIN = 0.25, CENTRE_MAX = 0.75;
  const samples: FaceMetrics[] = [];
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    let det: { landmarks?: { positions: Point[] } } | undefined;
    try {
      det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
        .withFaceLandmarks() as unknown as { landmarks?: { positions: Point[] } };
    } catch { await sleep(80); continue; }
    if (!det?.landmarks) {
      if (absenceBroken(guard)) return null;
      await sleep(80); continue;
    }
    markSeen(guard);

    const pts = det.landmarks.positions as Point[];
    const m = metricsOf(pts, video.videoWidth);

    // 1. Framing first — no point measuring a face that is too small to measure.
    const faceFrac = faceScale(pts) / (video.videoWidth || 640);
    const framing =
      faceFrac < MIN_FACE_FRAC ? 'Move closer' :
      faceFrac > MAX_FACE_FRAC ? 'Move back' :
      (m.centreX < CENTRE_MIN || m.centreX > CENTRE_MAX) ? 'Centre your face' : null;
    if (framing) {
      samples.length = 0;
      debugMetrics(`framing ${framing}: faceFrac=${faceFrac.toFixed(3)} cx=${m.centreX.toFixed(3)}`);
      onStatus?.({ label: framing, guide: 'search', left: 0, right: 0 });
      await sleep(80);
      continue;
    }

    // 2. Then pose: frontal and still.
    if (Math.abs(m.yaw - 0.55) > FRONTAL_YAW || Math.abs(m.skew) > FRONTAL_SKEW) {
      samples.length = 0;                       // still turned — start over
      onStatus?.({ label: 'Look straight at the camera', guide: 'search', left: 0, right: 0 });
      await sleep(60);
      continue;
    }
    samples.push(m);
    if (samples.length > FRAMES) samples.shift();

    if (samples.length === FRAMES) {
      const yaws = samples.map(x => x.yaw);
      if (Math.max(...yaws) - Math.min(...yaws) <= STABLE_YAW_RANGE) break;   // settled
      samples.shift();                          // still moving — keep sliding
    }
    onStatus?.({
      label: 'Relax your face', guide: 'hold',
      left: Math.round((samples.length / FRAMES) * 100),
      right: Math.round((samples.length / FRAMES) * 100),
    });
    await sleep(30);
  }
  if (samples.length < FRAMES) {
    debugMetrics(`neutral: gave up — never held a still, forward-facing pose`);
    return null;
  }

  const kept = samples;
  const med = (pick: (m: FaceMetrics) => number) => {
    const s = kept.map(pick).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  // EAR ignores frames caught mid-blink so the open-eye reference stays honest.
  const open = kept.map(m => m.ear).filter(e => e > 0.15).sort((a, b) => a - b);
  const neutral: NeutralBaseline = {
    ear: open.length ? open[Math.floor(open.length * 0.7)] : med(m => m.ear),
    lift: med(m => m.lift), width: med(m => m.width), open: med(m => m.open),
    yaw: med(m => m.yaw), skew: med(m => m.skew), centreX: med(m => m.centreX),
    brow: med(m => m.brow), frac: med(m => m.frac), shape: med(m => m.shape),
    // Spread of the open-eye EAR. close-eyes compares a windowed MEAN against
    // this, so the bar has to be set from the noise, not from a guessed factor.
    earSd: (() => {
      const xs = kept.map(m => m.ear);
      const mu = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length || 1));
    })(),
  };
  debugMetrics(`neutral(once): ear=${neutral.ear.toFixed(3)} lift=${neutral.lift.toFixed(4)} width=${neutral.width.toFixed(4)} open=${neutral.open.toFixed(3)} yaw=${neutral.yaw.toFixed(3)} skew=${neutral.skew.toFixed(3)} cx=${neutral.centreX.toFixed(3)} brow=${neutral.brow.toFixed(4)} earSd=${neutral.earSd.toFixed(4)} frac=${neutral.frac.toFixed(3)} shape=${neutral.shape.toFixed(4)}`);
  return neutral;
}

/** Live tuning aid: `localStorage.neuron_debug = '1'` prints raw metrics. */
function debugMetrics(msg: string): void {
  try { if (localStorage.getItem('neuron_debug') === '1') console.log(`[face] ${msg}`); } catch { /* no localStorage */ }
}

/**
 * Detect a specific facial action before face capture.
 * Blocks until the action is confirmed or the timeout expires.
 *
 * Every action is measured against the USER'S OWN neutral face, learned in a
 * short calibration phase at the start (`CALIBRATION_MS`), because absolute
 * thresholds cannot hold across face shapes, glasses, camera angle and distance.
 *
 * Actions:
 *   blink      — eye-aspect-ratio drops to ≤BLINK_DROP of the user's open-eye
 *                baseline, after the eyes have been seen open
 *   look-left  — nose X shifts ≥8 % of video width from its resting position
 *   look-right — same, other direction
 *   smile      — mouth corners rise AND the mouth widens, both relative to the
 *                calibrated neutral mouth
 *
 * Returns true when the action is detected, false on timeout.
 */
export async function detectChallenge(
  video: HTMLVideoElement,
  type: ChallengeAction,
  timeoutMs = 12000,
  onStatus?: (cue: CaptureCue) => void,
  guard?: PresenceGuard,
  neutral?: NeutralBaseline,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Calibrate by SAMPLE COUNT, not wall-clock. The first inference after a model
  // or input-size change costs 1-3s (kernel compilation), which blew straight
  // through an 800ms window and left the baseline at zero — the trigger then fell
  // back to a fixed threshold no blink could reach. Counting frames cannot fail
  // that way. The prompt here asks for a RELAXED face so the baseline can never
  // capture the action itself.
  // Collect 10, discard the first 4, take the MEDIAN of the rest.
  //
  // Measured baselines were being poisoned by the tail of the PREVIOUS action:
  // real runs calibrated at yaw=0.198 (head still turned) and open=0.495 (mouth
  // still open) where neutral is ~0.59 and ~0.33. A baseline captured mid-action
  // makes the next check either unpassable or free — which is exactly the
  // "passed instantly without doing anything" symptom. Dropping the leading
  // frames skips the transition, and a median ignores any that slip through.
  const CALIBRATION_FRAMES = 10;
  const CALIBRATION_DROP = 4;
  const median = (a: number[]) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  const settled = (a: number[]) => median(a.slice(CALIBRATION_DROP));
  // Blink: EAR must fall to this fraction of the user's own open-eye value.
  //
  // 0.62 was far too deep and broke blink entirely: face-api's 68-point model is
  // trained mostly on open eyes, so a real closure only pulls EAR down to
  // ~0.70-0.80 of its open value — it never reaches 0.62, and every blink was
  // rejected. (The old absolute 0.28 against a ~0.30 open EAR was effectively a
  // 7% drop, which is why it fired at all.) 0.80 = a 20% drop: deeper than
  // landmark jitter, shallower than a genuine blink.
  const BLINK_DROP = 0.80;
  // A single sub-threshold frame counts. A blink's closed phase is ~100ms and
  // detection costs ~60-150ms per frame, so demanding two consecutive frames
  // (the old rule) missed most ordinary blinks. The open→closed transition
  // requirement below is what defeats a photo; the 38% relative drop is what
  // rejects noise — neither needs a second frame.
  const BLINK_FRAMES = 1;
  // Smile: corners must rise AND the mouth widen, vs. this user's neutral.
  // Requiring both rejects "mouth open" (widens little, corners don't rise) and
  // a jaw drop. Fractions of inter-eye distance; tightened 15% + 10% after real
  // runs passed too easily.
  const SMILE_LIFT_DELTA = 0.0175;
  const SMILE_WIDTH_DELTA = 0.0550;
  // Jaw drop: lip gap / mouth width, over the calibrated neutral. Neutral sits
  // near 0.1, a deliberate open mouth clears 0.4 — enormous margin.
  const MOUTH_OPEN_DELTA = 0.22;
  // Head turn. Measured: at rest the jaw-ratio jitters ±0.03, and a deliberate
  // turn reached 0.12 — so 0.055 sat only ~2x above noise, which is why leaning
  // sideways could clear it. 0.085 keeps a real turn comfortable while putting
  // ~3x the noise band between them. The skew corroborator must move too: body
  // translation barely changes it, a rotation changes it a lot.
  const YAW_DELTA = 0.085;
  const SKEW_DELTA = 0.05;
  // Max allowed movement of the face across the frame while turning, as a
  // fraction of frame width. A neck-pivoted turn shifts the face ~5-7%; a body
  // slide big enough to fake that yaw moves it 15-20%.
  const CENTRE_DRIFT_MAX = 0.035;
  // Yaw that a pure sideways move explains on its own: apparent rotation grows
  // ~0.35 of jaw-ratio per unit of frame-width drift (60-degree lens, arm's
  // length). Demanding the observed yaw be several times that is what makes a
  // slide fail even when it drifts less than the cap above.
  const TRANSLATION_YAW_GAIN = 0.35;
  const ROTATION_MARGIN = 3.0;
  // Depth challenge. The size change must be large enough for perspective to be
  // measurable, and the SHAPE must move with it — that second half is the actual
  // anti-spoof, because a flat screen scales without changing shape at all.
  const DEPTH_SIZE_RATIO = 1.35;    // when approaching (inverse when receding)
  const DEPTH_SHAPE_DELTA = 0.025;  // relative change in eye-span / jaw-width
  // Eyebrow raise, as a fraction of face scale over the calibrated neutral.
  const BROW_DELTA = 0.025;
  // Eyes CLOSED AND HELD. A blink is a ~100ms transient that falls between
  // frames; a held closure is a state, so it is sampled many times over and is
  // detectable at any frame rate. Both the depth and the hold must be met.
  const CLOSE_HOLD_MS = 500;
  /** How far back the rolling open-eye reference looks. */
  const OPEN_REF_MS = 3000;
  let earBelowCount = 0;
  let sawEyesOpen = false;
  const earWindow: { t: number; ear: number }[] = [];
  /** Open-eye reference history, fed only by frames that are NOT a closure. */
  const openRefHist: { t: number; ear: number }[] = [];
  /** Relaxed-brow reference history, fed only by frames that are NOT a raise. */
  const browRefHist: { t: number; v: number }[] = [];
  // Every action must be HELD, not merely touched. Jitter crosses a threshold
  // for one frame; a deliberate expression stays there. This is what stops the
  // checks feeling "too sensitive" without making them physically harder — the
  // bar to clear is unchanged, it just has to be sustained.
  const SUSTAIN_MS = 320;
  let metSince = 0;
  const sustained = (met: boolean): boolean => {
    const t = Date.now();
    if (!met) { metSince = 0; return false; }
    if (!metSince) metSince = t;
    return t - metSince >= SUSTAIN_MS;
  };
  let browNeutral = 0;
  let earSdNeutral = 0;
  // Calibrated neutrals (filled during the calibration frames).
  const earOpenSamples: number[] = [];
  const liftSamples: number[] = [];
  const widthSamples: number[] = [];
  const openSamples: number[] = [];
  const yawSamples: number[] = [];
  const skewSamples: number[] = [];
  const centreSamples: number[] = [];
  let openNeutral = 0, yawNeutral = 0.5, skewNeutral = 0, centreNeutral = 0.5;
  let earOpen = 0, liftNeutral = 0, widthNeutral = 0;
  /** Deepest closure seen — reported on timeout so a near-miss is tunable. */
  let earMin = Infinity;

  const actionLabel =
    type === 'blink' ? 'blink' : type === 'smile' ? 'smile' :
    type === 'mouth-open' ? 'open mouth' : type === 'raise-brows' ? 'raise eyebrows' :
    type === 'close-eyes' ? 'close eyes' : type === 'move-depth' ? 'move closer/away' :
    type === 'look-left' ? 'look left' : 'look right';
  const guide: CaptureGuide =
    type === 'blink' ? 'blink' : type === 'smile' ? 'smile' :
    type === 'mouth-open' ? 'mouth' : type === 'raise-brows' ? 'brow' :
    type === 'close-eyes' ? 'eyes' : type === 'move-depth' ? 'depth' : 'turn';
  // Bar side for a head turn. Landmarks are in RAW video coordinates, so a user
  // turning to their own left moves the nose toward higher x; the feed is
  // mirrored for display, which puts that motion on the viewer's left. Hence
  // "their left" == the bar's left half == the on-screen direction they see.
  const turnSide: 'left' | 'right' = type === 'look-right' ? 'right' : 'left';
  // Opening prompt, in the same wording the in-progress cues use.
  const prompt =
    type === 'blink' ? 'Blink' : type === 'smile' ? 'Smile' :
    type === 'mouth-open' ? 'Open your mouth' :
    type === 'raise-brows' ? 'Raise your eyebrows' :
    type === 'close-eyes' ? 'Close your eyes' :
    type === 'move-depth' ? (neutral && neutral.frac > 0.25 ? 'Move further away' : 'Move closer') :
    `Turn head ${turnSide}`;

  onStatus?.({ label: prompt, guide, dir: guide === 'turn' ? turnSide : undefined, left: 0, right: 0 });

  // Frame time is dominated by the detector's input size. Blink needs the
  // highest possible frame rate to catch a ~100ms closure, and eye landmarks
  // survive the smaller input fine; the other actions keep 320 for stability.
  const inputSize = type === 'blink' ? 224 : 320;

  while (Date.now() < deadline) {
    let detection: Awaited<ReturnType<typeof faceapi.detectSingleFace>> & { landmarks?: ReturnType<typeof faceapi.detectSingleFace.prototype.withFaceLandmarks> } | undefined;
    let det: { landmarks?: { positions: Point[] } } | undefined;
    try {
      det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: 0.3 }))
        .withFaceLandmarks() as unknown as { landmarks?: { positions: Point[] } };
    } catch {
      await sleep(100); continue;
    }
    if (!det?.landmarks) {
      // A miss counts toward the continuity budget — this is where a swap shows up.
      if (absenceBroken(guard)) {
        onStatus?.({ label: 'Face lost — start again', guide: 'search', state: 'fail', left: 0, right: 0 });
        return false;
      }
      await sleep(100); continue;
    }
    markSeen(guard);

    const pts = det.landmarks.positions as Point[];

    // ── Calibration: learn this user's neutral face ───────────────────────────
    if (neutral && !widthNeutral) {
      // Baseline supplied by the caller (measured before ANY action) — no
      // per-action calibration, so it cannot capture the previous movement.
      earOpen = neutral.ear; liftNeutral = neutral.lift; widthNeutral = neutral.width;
      openNeutral = neutral.open; yawNeutral = neutral.yaw; skewNeutral = neutral.skew;
      centreNeutral = neutral.centreX;
      browNeutral = neutral.brow;
      earSdNeutral = neutral.earSd;
    }
    if (!neutral && widthSamples.length < CALIBRATION_FRAMES) {
      const rightEAR = eyeAspectRatio(pts.slice(36, 42));
      const leftEAR  = eyeAspectRatio(pts.slice(42, 48));
      const ear = (rightEAR + leftEAR) / 2;
      if (ear > 0.15) earOpenSamples.push(ear);   // ignore frames caught mid-blink
      const m = mouthMetrics(pts);
      liftSamples.push(m.lift);
      widthSamples.push(m.width);
      openSamples.push(m.open);
      const y = yawSignals(pts);
      yawSamples.push(y.jawRatio);
      skewSamples.push(y.skew);
      centreSamples.push(frameCentreX(pts, video.videoWidth));
      const pct = Math.round((widthSamples.length / CALIBRATION_FRAMES) * 100);
      onStatus?.({ label: 'Relax your face', guide, left: pct, right: pct });
      await sleep(30);
      continue;
    }
    // 70th percentile, not the mean: if the user happens to blink during the
    // 800ms calibration those frames drag a mean down, lowering the trigger
    // threshold and making the real blink undetectable. A high percentile
    // represents a solidly-open eye.
    if (!earOpen && earOpenSamples.length) {
      const sorted = [...earOpenSamples].sort((a, b) => a - b);
      earOpen = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.7))];
    }
    if (!widthNeutral && widthSamples.length) {
      liftNeutral = settled(liftSamples);
      widthNeutral = settled(widthSamples);
      openNeutral = settled(openSamples);
      yawNeutral = settled(yawSamples);
      skewNeutral = settled(skewSamples);
      centreNeutral = settled(centreSamples);
      debugMetrics(`neutral: earOpen=${earOpen.toFixed(3)} lift=${liftNeutral.toFixed(4)} width=${widthNeutral.toFixed(4)} open=${openNeutral.toFixed(3)} yaw=${yawNeutral.toFixed(3)} skew=${skewNeutral.toFixed(3)}`);
    }

    if (type === 'blink') {
      const rightEAR = eyeAspectRatio(pts.slice(36, 42));
      const leftEAR  = eyeAspectRatio(pts.slice(42, 48));
      const ear = (rightEAR + leftEAR) / 2;
      const closedBelow = (earOpen || 0.30) * BLINK_DROP;
      earMin = Math.min(earMin, ear);
      debugMetrics(`blink ear=${ear.toFixed(3)} min=${earMin.toFixed(3)} threshold=${closedBelow.toFixed(3)} open=${earOpen.toFixed(3)}`);
      if (ear < closedBelow) {
        // Only count a closure as a blink once we've confirmed the eyes were open —
        // this requires a real open→closed transition, defeating a static photo.
        if (sawEyesOpen) {
          earBelowCount++;
          if (earBelowCount >= BLINK_FRAMES) {
            onStatus?.({ label: 'Blink detected', guide: 'blink', left: 100, right: 100, state: 'ok' });
            return true;
          }
        }
      } else {
        sawEyesOpen = true;
        earBelowCount = 0;
      }
      // Bar shows how far the lids have actually closed toward the trigger, so a
      // half-blink reads as progress instead of nothing happening.
      const closure = earOpen > 0
        ? Math.max(0, Math.min(99, Math.round(((earOpen - ear) / (earOpen - closedBelow)) * 100)))
        : 0;
      onStatus?.({
        label: sawEyesOpen ? 'Blink now' : 'Open your eyes',
        guide: 'blink', left: closure, right: closure,
      });

    } else if (type === 'look-left' || type === 'look-right') {
      // Yaw, not displacement: sliding the body sideways no longer counts, because
      // the nose keeps its position between the jaw edges. Acceptance stays
      // direction-agnostic — the anti-replay value is "the head rotated on
      // demand", and enforcing a sign would hard-block enrollment if the
      // camera/mirror convention were inverted. The BAR uses the signed value,
      // so it always mirrors the real movement.
      const y = yawSignals(pts);
      const signed = y.jawRatio - yawNeutral;
      const skewΔ = y.skew - skewNeutral;
      const delta = Math.abs(signed);
      // Displacement is the ONLY thing that separates a head turn from a body
      // shift: both produce identical yaw at the landmarks, because sliding
      // sideways really does rotate the face relative to the lens. A rotation
      // pivots at the neck and keeps the face roughly in place; a shift carries
      // it across the frame. So yaw must arrive WITHOUT the face having moved.
      const driftΔ = Math.abs(frameCentreX(pts, video.videoWidth) - centreNeutral);
      const stayedPut = driftΔ <= CENTRE_DRIFT_MAX;
      // ...and the yaw must be far more than the drift by itself could produce.
      const explained = TRANSLATION_YAW_GAIN * driftΔ;
      const rotationDominates = delta >= ROTATION_MARGIN * explained;
      const agree = Math.sign(signed) === Math.sign(skewΔ);
      debugMetrics(`turn jawΔ=${signed.toFixed(4)}/±${YAW_DELTA} skewΔ=${skewΔ.toFixed(4)}/±${SKEW_DELTA} drift=${driftΔ.toFixed(4)}/${CENTRE_DRIFT_MAX} explains=${explained.toFixed(4)} agree=${agree}`);
      if (sustained(delta >= YAW_DELTA && Math.abs(skewΔ) >= SKEW_DELTA && agree && stayedPut && rotationDominates)) {
        onStatus?.({ label: 'Turn detected', guide: 'turn', dir: turnSide, left: 100, right: 100, state: 'ok' });
        return true;
      }
      if (!stayedPut) {
        // Name the mistake instead of silently refusing to fill the bar.
        onStatus?.({ label: 'Keep your head in place — turn, don\'t move', guide: 'turn', left: 0, right: 0 });
        await sleep(60);
        continue;
      }
      // Bar tracks the WEAKER signal, so it only fills on a genuine rotation.
      const pct = Math.min(99, Math.round(Math.min(
        delta / YAW_DELTA, Math.abs(skewΔ) / SKEW_DELTA,
      ) * 100));
      const movingLeft = signed > 0;   // nose drifts toward higher x when turning to their left
      onStatus?.({
        label: `Turn head ${turnSide}`,
        guide: 'turn', dir: turnSide,
        left: movingLeft ? pct : 0,
        right: movingLeft ? 0 : pct,
      });

    } else if (type === 'smile') {
      const m = mouthMetrics(pts);
      const liftΔ = m.lift - liftNeutral;
      const widthΔ = m.width - widthNeutral;
      debugMetrics(`smile liftΔ=${liftΔ.toFixed(4)}/${SMILE_LIFT_DELTA} widthΔ=${widthΔ.toFixed(4)}/${SMILE_WIDTH_DELTA}`);
      // BOTH must move: corners up AND mouth wider. Either alone is something
      // else — a jaw drop widens nothing, and raised corners with no widening is
      // usually the head tilting.
      if (sustained(liftΔ >= SMILE_LIFT_DELTA && widthΔ >= SMILE_WIDTH_DELTA)) {
        onStatus?.({ label: 'Smile detected', guide: 'smile', left: 100, right: 100, state: 'ok' });
        return true;
      }
      // Progress = the weaker of the two, so the bar only fills on a real smile.
      const pct = Math.max(0, Math.min(99, Math.round(Math.min(
        (liftΔ / SMILE_LIFT_DELTA), (widthΔ / SMILE_WIDTH_DELTA),
      ) * 100)));
      onStatus?.({ label: 'Smile', guide: 'smile', left: pct, right: pct });

    } else if (type === 'mouth-open') {
      const openΔ = mouthMetrics(pts).open - openNeutral;
      debugMetrics(`mouth openΔ=${openΔ.toFixed(3)}/${MOUTH_OPEN_DELTA}`);
      if (sustained(openΔ >= MOUTH_OPEN_DELTA)) {
        onStatus?.({ label: 'Mouth open detected', guide: 'mouth', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.max(0, Math.min(99, Math.round((openΔ / MOUTH_OPEN_DELTA) * 100)));
      onStatus?.({ label: 'Open your mouth', guide: 'mouth', left: pct, right: pct });

    } else if (type === 'raise-brows') {
      // Rolling RELAXED reference, not the enrollment baseline. Measured: the
      // resting brow sat 0.030 above the calibrated neutral for a whole action
      // (75% of the old 0.040 bar) while the actual raise added only 0.015 on
      // top — brow-to-lid distance shifts with head pitch and distance, so a
      // fixed baseline goes stale exactly like the eye reference did. Fed only
      // by frames that are NOT a raise, so holding the raise cannot erase it.
      const browNow = browLift(pts);
      const sortedBrow = browRefHist.map(e => e.v).sort((a, b) => a - b);
      const browRef = sortedBrow.length >= 6
        ? sortedBrow[Math.floor(sortedBrow.length * 0.3)]
        : browNeutral;
      const browΔ = browNow - browRef;
      if (browΔ < BROW_DELTA * 0.5) {
        browRefHist.push({ t: Date.now(), v: browNow });
        while (browRefHist.length && Date.now() - browRefHist[0].t > OPEN_REF_MS) browRefHist.shift();
      }
      debugMetrics(`brow browΔ=${browΔ.toFixed(4)}/${BROW_DELTA} ref=${browRef.toFixed(4)} raw=${browNow.toFixed(4)}`);
      if (sustained(browΔ >= BROW_DELTA)) {
        onStatus?.({ label: 'Eyebrows detected', guide: 'brow', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.max(0, Math.min(99, Math.round((browΔ / BROW_DELTA) * 100)));
      onStatus?.({ label: 'Raise your eyebrows', guide: 'brow', left: pct, right: pct });

    } else if (type === 'move-depth') {
      const m = metricsOf(pts, video.videoWidth);
      const fracRef = neutral?.frac || m.frac;
      const shapeRef = neutral?.shape || m.shape;
      // Approach unless the head already fills the frame, in which case recede.
      const wantCloser = fracRef <= 0.25;
      const sizeGoal = wantCloser ? DEPTH_SIZE_RATIO : 1 / DEPTH_SIZE_RATIO;
      const sizeProgress = wantCloser
        ? (m.frac / fracRef - 1) / (sizeGoal - 1)
        : (1 - m.frac / fracRef) / (1 - sizeGoal);
      // Perspective must move in the direction the motion implies.
      const shapeRel = shapeRef > 0 ? (m.shape / shapeRef - 1) : 0;
      const shapeProgress = (wantCloser ? shapeRel : -shapeRel) / DEPTH_SHAPE_DELTA;
      debugMetrics(`depth frac=${m.frac.toFixed(3)}/${fracRef.toFixed(3)} size=${sizeProgress.toFixed(2)} shapeRel=${shapeRel.toFixed(4)} shape=${shapeProgress.toFixed(2)} wantCloser=${wantCloser}`);

      if (sustained(sizeProgress >= 1 && shapeProgress >= 1)) {
        onStatus?.({ label: 'Depth confirmed', guide: 'depth', left: 100, right: 100, state: 'ok' });
        return true;
      }
      // If the head clearly moved but the shape did NOT, the surface is flat —
      // a phone, tablet or print. Say so rather than letting it time out silently.
      if (sizeProgress >= 1 && shapeProgress < 0.35) {
        onStatus?.({ label: 'Flat image detected — use your real face', guide: 'depth', left: 0, right: 0 });
        await sleep(60);
        continue;
      }
      const pct = Math.max(0, Math.min(99, Math.round(Math.min(sizeProgress, Math.max(shapeProgress, 0)) * 100)));
      onStatus?.({
        label: wantCloser ? 'Move closer' : 'Move further away',
        guide: 'depth', left: pct, right: pct,
      });

    } else if (type === 'close-eyes') {
      const rightEAR = eyeAspectRatio(pts.slice(36, 42));
      const leftEAR = eyeAspectRatio(pts.slice(42, 48));
      const ear = (rightEAR + leftEAR) / 2;
      const now = Date.now();
      earWindow.push({ t: now, ear });
      // Keep MORE than the hold. Pruning at exactly CLOSE_HOLD_MS meant the
      // window's span was always just under it by construction, so the
      // "held long enough" test could never fire — the check was unpassable
      // however long the eyes stayed shut (observed: span stuck at ~330ms).
      while (earWindow.length && now - earWindow[0].t > OPEN_REF_MS) earWindow.shift();

      // Threshold from the MEASURED jitter, not a guessed factor. Measured on
      // real hardware: closed 0.296 vs open 0.314 is only 5.9% per frame — buried
      // in noise — but averaging the hold window shrinks that noise by sqrt(n)
      // and the same gap becomes ~4.8 sigma. So the test is on the WINDOW MEAN.
      // Reference the RECENT open eye, not the enrollment baseline. Measured:
      // EAR drifts ~0.05 across a session with head pose and distance, while a
      // real closure moves it only ~0.017 — so a fixed baseline goes stale and
      // ordinary drift crosses the line on its own. That is the "passes
      // instantly with your eyes open" case, caught in a real trace at
      // mean=0.311 vs a 0.314 threshold. The 80th percentile of the last few
      // seconds tracks drift while ignoring the closure itself.
      const sortedOpen = openRefHist.map(e => e.ear).sort((a, b) => a - b);
      const openRef = sortedOpen.length >= 6
        ? sortedOpen[Math.floor(sortedOpen.length * 0.8)]
        : (earOpen || 0.30);
      const margin = Math.max(3.0 * (earSdNeutral || 0.008), 0.015);
      const closedBelow = openRef - margin;
      if (ear >= closedBelow + margin * 0.5) sawEyesOpen = true;   // clearly open first

      // Mean over the LAST CLOSE_HOLD_MS, but only once the buffer actually
      // covers that much history.
      const recent = earWindow.filter(e => now - e.t <= CLOSE_HOLD_MS);
      // Coverage comes from the FULL buffer, not from `recent`: `recent` only
      // holds the last CLOSE_HOLD_MS by construction, so its own span can never
      // reach that value — measuring it there made the hold unsatisfiable and
      // the bar sat at 100% forever. (Second time; the same trap as before.)
      const span = earWindow.length ? now - earWindow[0].t : 0;
      const windowMean = recent.reduce((a, b) => a + b.ear, 0) / (recent.length || 1);
      const held = span >= CLOSE_HOLD_MS && recent.length >= 4;
      debugMetrics(`eyes ear=${ear.toFixed(3)} mean=${windowMean.toFixed(3)} openRef=${openRef.toFixed(3)} threshold=${closedBelow.toFixed(3)} span=${span}ms n=${recent.length} held=${held}`);

      if (sawEyesOpen && held && windowMean <= closedBelow) {
        onStatus?.({ label: 'Eyes closed detected', guide: 'eyes', left: 100, right: 100, state: 'ok' });
        return true;
      }
      // You cannot watch a progress bar with your eyes shut, so the bar is only
      // for the approach; the confirmation is what matters and it is announced
      // (with a tone) the moment it lands.
      const depth = earOpen > 0 ? (earOpen - windowMean) / margin : 0;
      const pct = Math.max(0, Math.min(99, Math.round(depth * Math.min(1, span / CLOSE_HOLD_MS) * 100)));
      // Feed the reference ONLY with frames that are not part of a closure —
      // otherwise a long hold drags the reference down to meet the closure and
      // the test can never fire (observed: openRef decaying 0.329 -> 0.304 while
      // the eyes stayed shut).
      if (windowMean > closedBelow) {
        openRefHist.push({ t: now, ear });
        while (openRefHist.length && now - openRefHist[0].t > OPEN_REF_MS) openRefHist.shift();
      }
      onStatus?.({
        label: sawEyesOpen ? (windowMean <= closedBelow ? 'Keep them closed' : 'Close your eyes') : 'Look at the camera',
        guide: 'eyes', left: pct, right: pct,
      });
    }

    // Fast cadence: a blink's closed phase is ~100ms, so polling must be as
    // tight as detection allows or the closure falls between two frames.
    await sleep(type === 'blink' ? 20 : 60);
  }

  // Always log the near-miss on timeout: without the deepest value reached there
  // is no way to tell "the user did nothing" from "the threshold is too tight".
  if (type === 'blink') {
    debugMetrics(`blink TIMEOUT deepest=${earMin === Infinity ? 'n/a' : earMin.toFixed(3)} needed<${((earOpen || 0.30) * BLINK_DROP).toFixed(3)} open=${earOpen.toFixed(3)}`);
  }
  onStatus?.({ label: 'Timed out — try again', guide, state: 'fail', left: 0, right: 0 });
  return false;
}

// ──── Quantization ────

/**
 * Quantize a 128-D descriptor into stable bins.
 * Each value is rounded to the nearest QUANT_BIN.
 * This ensures the same face produces the same quantized vector
 * across sessions (within tolerance).
 */
export function quantizeDescriptor(descriptor: number[]): number[] {
  return descriptor.map((v) => Math.round(v / QUANT_BIN) * QUANT_BIN);
}

// ──── Face-Derived Key ────

/**
 * Derive a stable AES encryption key from a quantized face descriptor.
 * Salt is per-account: "neuronchain-face-v2:<accountPub>" - prevents cross-account
 * rainbow tables even if two accounts share similar descriptors.
 */
export async function deriveFaceKey(quantized: number[], accountPub: string): Promise<CryptoKey> {
  const descriptorStr = quantized.map((v) => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(descriptorStr);
  const salt = new TextEncoder().encode(`neuronchain-face-v2:${accountPub}`);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoded, 'PBKDF2', false, ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive 32 raw bytes from a quantized face descriptor using PBKDF2-SHA-256.
 * Uses the same per-account salt as deriveFaceKey.
 */
export async function deriveFaceRawBits(quantized: number[], accountPub: string): Promise<Uint8Array> {
  const descriptorStr = quantized.map((v) => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(descriptorStr);
  const salt = new TextEncoder().encode(`neuronchain-face-v2:${accountPub}`);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoded, 'PBKDF2', false, ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt data with a face-derived AES-GCM key.
 */
export async function encryptWithFaceKey(data: string, faceKey: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(data);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    faceKey,
    encoded,
  );
  // Combine IV + ciphertext, encode as base64
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(combined);
}

/**
 * Decrypt data with a face-derived AES-GCM key.
 * Returns null if decryption fails (wrong face / corrupted data).
 */
export async function decryptWithFaceKey(encrypted: string, faceKey: CryptoKey): Promise<string | null> {
  try {
    const raw = atob(encrypted);
    const combined = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) combined[i] = raw.charCodeAt(i);
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      faceKey,
      ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null; // Wrong face - decryption failed
  }
}

// ──── Comparison ────

export function compareFaces(a: number[], b: number[]): { distance: number; match: boolean } {
  let sum = 0;
  for (let i = 0; i < 128; i++) sum += (a[i] - b[i]) ** 2;
  const distance = Math.sqrt(sum);
  return { distance, match: distance < MATCH_THRESHOLD };
}

// ──── Hashing ────

export async function hashDescriptor(descriptor: number[]): Promise<string> {
  const str = descriptor.map((v) => v.toFixed(4)).join(',');
  const encoded = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// ──── Helpers ────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Encode Uint8Array to base64 without spread operator (safe for large arrays). */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export { MATCH_THRESHOLD, ENROLLMENT_SAMPLES, QUANT_BIN };
