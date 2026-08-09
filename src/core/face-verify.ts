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
export type ChallengeAction = 'blink' | 'close-eyes' | 'smile' | 'mouth-open' | 'raise-brows' | 'look-left' | 'look-right';

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
  ['smile', 'mouth-open', 'raise-brows', 'close-eyes'];

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
  /**
   * For a depth-sweep leg: which way this leg goes. The guide draws the inner
   * oval growing toward the target on an approach and shrinking on a retreat,
   * so it has to know the direction — progress alone is a magnitude.
   */
  depth?: 'in' | 'out';
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
    // The pauses between actions and between capture samples are the softest
    // windows in the whole flow — nothing is being measured, so an unwatched
    // second face here is free. Same one-face rule as everywhere else.
    const solo = await detectSolo(video, 224);
    if (solo.count > 1) {
      debugMetrics(`hold ABORT: ${solo.count} faces in frame`);
      onStatus?.({ label: 'Only one face in frame', guide: 'search', state: 'fail', left: 0, right: 0 });
      return false;
    }
    if (solo.count === 1) markSeen(guard);
    if (absenceBroken(guard)) {
      onStatus?.({ label: noFaceLabel(video, 'Out of frame / Too dark!'), guide: 'search', state: 'fail', left: 0, right: 0 });
      return false;
    }
    await sleep(80);
  }
  return true;
}

// ──── Face Descriptor Capture ────

/**
 * Returns 'multi' rather than a descriptor when more than one face is in shot.
 * This is the stage that matters most: whatever descriptor comes back here is
 * what gets enrolled and becomes the identity. Picking the highest-scoring of
 * two faces would mean the liveness actions proved one person was present while
 * a different face was registered.
 */
export async function captureFaceDescriptor(
  video: HTMLVideoElement,
): Promise<FaceDescriptor | 'multi' | null> {
  try {
    const dets = await faceapi
      // 320, not 416: the larger input missed the face repeatedly during capture
      // (observed 9 misses across 3 samples) while every other stage runs happily
      // at 320. Detector input size sets the bounding box; the descriptor itself
      // is computed from a fixed-size aligned crop, so quality is unaffected.
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: SOLO_SCORE }))
      .withFaceLandmarks()
      .withFaceDescriptors() as unknown as { descriptor: Float32Array }[];

    if (dets.length > 1) return 'multi';
    if (dets.length !== 1 || !dets[0]?.descriptor) return null;

    return {
      data: Array.from(dets[0].descriptor),
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
    debugMetrics(`enroll sample ${i + 1}/${ENROLLMENT_SAMPLES} descriptor=${desc === 'multi' ? 'MULTI' : desc ? 'ok' : 'MISS'} retries=${retries}`);
    if (desc === 'multi') {
      // Not a retry: which face would we be retrying for?
      debugMetrics('enroll ABORT: more than one face in frame');
      onProgress(i + 1, ENROLLMENT_SAMPLES, {
        label: 'Only one face in frame', guide: 'search', state: 'fail', left: 0, right: 0,
      });
      return null;
    }
    if (!desc) {
      if (retries++ > 10) { debugMetrics('enroll GAVE UP after 10 misses'); return null; }
      onProgress(i + 1, ENROLLMENT_SAMPLES, {
        label: noFaceLabel(video, 'Look at the camera'), guide: 'search', left: pct(i), right: pct(i),
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

/**
 * Score floor for the one-face gate. Lower than the 0.4 the setup screen used:
 * a face on a phone or tablet scores lower than a live one (screen glare, lower
 * effective resolution, moire), and the entire purpose of this gate is to SEE
 * that second face. A missed detection here is a spoof that walks through.
 */
const SOLO_SCORE = 0.3;

/**
 * Mean luminance of the current frame, 0-255, or -1 if it cannot be sampled.
 *
 * The detector has no concept of lighting. In a dim room the face score simply
 * drops under `scoreThreshold` and the detection disappears — a result byte-for
 * byte identical to an empty frame — so the user is told to show their face
 * while they are already showing it. Sampling the pixels is the only way to
 * separate "nobody there" from "cannot see anybody".
 *
 * 64x48 and only called on a MISS, so it never touches the common path.
 */
let lumaCanvas: HTMLCanvasElement | null = null;
function frameBrightness(video: HTMLVideoElement): number {
  try {
    if (!video.videoWidth) return -1;
    if (!lumaCanvas) {
      lumaCanvas = document.createElement('canvas');
      lumaCanvas.width = 64; lumaCanvas.height = 48;
    }
    const ctx = lumaCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return -1;
    ctx.drawImage(video, 0, 0, 64, 48);
    const { data } = ctx.getImageData(0, 0, 64, 48);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    return sum / (data.length / 4);
  } catch { return -1; }
}

/**
 * Starting value, not a measured one — unlike the detection thresholds, being
 * wrong here only changes the WORDING of a message, never whether a check
 * passes. Every miss logs its luma, so a `neuron_debug` trace from a real dim
 * room gives the number to replace it with.
 */
const DARK_LUMA = 45;

/**
 * Message for a frame with no usable face: name the darkness when that is the
 * likely cause, otherwise fall back to the caller's wording.
 *
 * Deliberately does NOT relax the presence budget. Covering the lens produces a
 * dark frame too, so treating darkness as forgivable would hand an attacker a
 * free unwatched window mid-sequence — exactly what the continuity guard exists
 * to close. Only the explanation improves; the timeout is unchanged.
 */
function noFaceLabel(video: HTMLVideoElement, fallback: string): string {
  const luma = frameBrightness(video);
  if (luma >= 0) debugMetrics(`no face detected; frame luma=${luma.toFixed(0)} (dark below ${DARK_LUMA})`);
  return luma >= 0 && luma < DARK_LUMA ? 'Too dark, add more light.' : fallback;
}

/**
 * Exactly one face, or nothing.
 *
 * Every stage except setup used detectSingleFace, which does not mean "fail if
 * there are two" — it silently returns the HIGHEST-SCORING face. So a second
 * face was invisible to the liveness actions and to capture, and worse, nothing
 * tied the face measured in one frame to the face measured in the next: a live
 * head could perform the actions while a photo held beside it scored higher at
 * capture time and supplied the descriptor that actually got enrolled.
 *
 * Reported by a user who passed setup and close-eyes while holding a still
 * photo on a phone with their real head also in shot.
 *
 * `count` is what the caller must branch on: >1 means abort the run, not pick a
 * winner.
 */
async function detectSolo(
  video: HTMLVideoElement,
  inputSize: number,
): Promise<{ pts?: Point[]; count: number }> {
  try {
    const dets = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: SOLO_SCORE }))
      .withFaceLandmarks() as unknown as { landmarks?: { positions: Point[] } }[];
    if (dets.length !== 1 || !dets[0]?.landmarks) return { count: dets.length };
    return { pts: dets[0].landmarks.positions as Point[], count: 1 };
  } catch {
    return { count: 0 };
  }
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
export type CalibrationFailure = 'presence' | 'flat' | 'multi-face' | 'timeout';
export type CalibrationResult =
  | { ok: true; neutral: NeutralBaseline }
  | { ok: false; reason: CalibrationFailure };

/**
 * SETUP: dial in the camera distance, prove the face is three-dimensional, and
 * screen the frame — all before a single expression is measured.
 *
 * Doing this first, rather than as one more randomly-drawn action, matters:
 *
 *  - Every other metric is a normalised ratio, so a face across the room passes
 *    them all — while its landmarks are a few pixels apart and every delta is
 *    noise. The baseline must be taken at a known-good distance or everything
 *    downstream is calibrated against mush.
 *  - The depth sweep is the one check a screen cannot pass. The eyes sit ~8-10cm
 *    nearer the lens than the jaw silhouette, so on a real head the eye-span /
 *    jaw-width ratio RISES on approach. A phone, tablet or print is flat: moving
 *    it scales the image and leaves that ratio untouched. Running it up front
 *    means a spoof is rejected before it can attempt anything else.
 *  - The whole frame is checked while the user is moving anyway: exactly one
 *    face (a second one means a bystander, or a screen held beside a real head)
 *    and a level, forward-facing pose.
 *
 * Stages: frame it → move closer (perspective must respond) → settle back →
 * baseline. Returns the neutral measurements taken at the settled distance.
 */
export async function calibrateNeutral(
  video: HTMLVideoElement,
  onStatus?: (cue: CaptureCue) => void,
  guard?: PresenceGuard,
): Promise<CalibrationResult> {
  const FRAMES = 8;
  const FRONTAL_YAW = 0.13;      // |yaw − 0.55| — covers normal facial asymmetry
  const FRONTAL_SKEW = 0.15;
  const STABLE_YAW_RANGE = 0.04;
  const MAX_ROLL_DEG = 16;       // head tilt; beyond this the landmarks skew
  // Framing starts mid-range so the sweep has room in BOTH directions without
  // the face leaving the measurable band.
  const MIN_FACE_FRAC = 0.15;    // eye span as a fraction of frame width
  const MAX_FACE_FRAC = 0.32;
  const CENTRE_MIN = 0.25, CENTRE_MAX = 0.75;
  // Depth sweep, THREE legs: closer → back → closer.
  //
  // One leg proves the face is 3D; three make it decisive. Each leg is measured
  // against the end of the previous one, so the perspective has to reverse
  // direction on demand — a flat surface fails all three identically, and a
  // coincidental shape wobble cannot line up with three prescribed directions.
  // Ending on "closer" also leaves the user at a good distance for the baseline
  // and the capture that follows.
  const LEGS = [
    { in: true,  label: 'Move closer' },
    { in: false, label: 'Move back' },
    { in: true,  label: 'Move closer' },
  ];
  const LEG_SIZE_RATIO = 1.25;   // per leg, inverted when receding
  const SHAPE_DELTA = 0.022;     // relative change in eye-span / jaw-width, per leg
  // "Flat" must be egregious before we reject: the shape signal rides on the jaw
  // silhouette, the least reliable landmarks in the model, so a real approach can
  // legitimately register a weak response (measured: the SAME face gave 0.007 on
  // one approach and 0.030 on the next). A false "flat image" locks a real person
  // out of the network, which is far worse than a spoof needing another attempt —
  // so this only fires when the face moved MUCH further than asked with virtually
  // no perspective response at all.
  const FLAT_SIZE_MIN = 2.5;     // multiples of the required size change
  const FLAT_SHAPE_MAX = 0.12;   // fraction of SHAPE_DELTA that still reads as "flat"
  const deadline = Date.now() + 60000;

  type Phase = 'frame' | 'sweep' | 'baseline';
  let phase: Phase = 'frame';
  let leg = 0;
  let startFrac = 0, startShape = 0;
  /**
   * Snapshot of the face BEFORE the sweep. The usable baseline has to come
   * after — the actions happen at the settled distance, and calibrating at any
   * other one reproduces the stale-baseline bug we already hit twice. But the
   * pre-sweep face is still worth keeping as a consistency reference: the
   * distance-INVARIANT ratios (mouth width, corner lift, brow gap — all
   * normalised by eye span) belong to the face, not the distance, so they should
   * survive the sweep unchanged. A large drift means something about the subject
   * changed while it was moving. Measured and logged for now, not enforced:
   * a rejection rule needs real numbers behind it, not a guessed tolerance.
   */
  let preNeutral: FaceMetrics | null = null;
  const samples: FaceMetrics[] = [];

  const fail = (reason: CalibrationFailure): CalibrationResult => {
    debugMetrics(`calibration failed: ${reason}`);
    return { ok: false, reason };
  };

  while (Date.now() < deadline) {
    // detectAllFaces (not Single) so a second face in frame is visible to us.
    let dets: { landmarks?: { positions: Point[] } }[] = [];
    try {
      dets = await faceapi
        // SOLO_SCORE (0.3), not 0.4: a face on a phone screen scores lower than
        // a live one, and this screen only works if it SEES the second face.
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: SOLO_SCORE }))
        .withFaceLandmarks() as unknown as { landmarks?: { positions: Point[] } }[];
    } catch { await sleep(80); continue; }

    if (!dets.length || !dets[0]?.landmarks) {
      if (absenceBroken(guard)) return fail('presence');
      onStatus?.({ label: noFaceLabel(video, 'Show your face'), guide: 'search', left: 0, right: 0 });
      samples.length = 0;
      await sleep(80);
      continue;
    }
    if (dets.length > 1) {
      // A screen held next to a real head, a bystander, a poster on the wall.
      samples.length = 0;
      debugMetrics(`calibration: ${dets.length} faces in frame`);
      onStatus?.({ label: 'Only one face in frame', guide: 'search', state: 'fail', left: 0, right: 0 });
      await sleep(150);
      continue;
    }
    markSeen(guard);

    const pts = dets[0].landmarks!.positions as Point[];
    const m = metricsOf(pts, video.videoWidth);
    const rollDeg = Math.abs(Math.atan2(pts[45].y - pts[36].y, pts[45].x - pts[36].x) * 180 / Math.PI);

    // ── framing + pose, enforced in every phase ──────────────────────────────
    const badFrame =
      m.frac < MIN_FACE_FRAC ? 'Move closer' :
      m.frac > MAX_FACE_FRAC ? 'Move back' :
      (m.centreX < CENTRE_MIN || m.centreX > CENTRE_MAX) ? 'Centre your face' :
      rollDeg > MAX_ROLL_DEG ? 'Hold your head level' :
      (Math.abs(m.yaw - 0.55) > FRONTAL_YAW || Math.abs(m.skew) > FRONTAL_SKEW) ? 'Look straight at the camera' : null;

    if (phase !== 'sweep' && badFrame) {
      samples.length = 0;
      onStatus?.({ label: badFrame, guide: 'search', left: 0, right: 0 });
      await sleep(80);
      continue;
    }

    if (phase === 'frame') {
      // Hold a good frame briefly, then record the reference for the sweep.
      samples.push(m);
      if (samples.length > FRAMES) samples.shift();
      const yaws = samples.map(x => x.yaw);
      if (samples.length === FRAMES && Math.max(...yaws) - Math.min(...yaws) <= STABLE_YAW_RANGE) {
        startFrac = m.frac;
        startShape = m.shape;
        const midOf = (pick: (x: FaceMetrics) => number) => {
          const v = samples.map(pick).sort((a, b) => a - b);
          return v[Math.floor(v.length / 2)];
        };
        preNeutral = { ...m, width: midOf(x => x.width), lift: midOf(x => x.lift), brow: midOf(x => x.brow) };
        samples.length = 0;
        phase = 'sweep';
        debugMetrics(`calibration: framed at frac=${startFrac.toFixed(3)} shape=${startShape.toFixed(4)}`);
        continue;
      }
      onStatus?.({
        label: 'Hold still', guide: 'hold',
        left: Math.round((samples.length / FRAMES) * 100),
        right: Math.round((samples.length / FRAMES) * 100),
      });
      await sleep(40);
      continue;
    }

    if (phase === 'sweep') {
      const { in: goIn, label } = LEGS[leg];
      // Approaching magnifies the eyes faster than the jaw (they are nearer the
      // lens) so the shape ratio RISES; receding flattens it back. A flat
      // surface scales without either.
      const sizeProgress = goIn
        ? (m.frac / startFrac - 1) / (LEG_SIZE_RATIO - 1)
        : (1 - m.frac / startFrac) / (1 - 1 / LEG_SIZE_RATIO);
      const shapeRel = startShape > 0 ? (m.shape / startShape - 1) : 0;
      const shapeProgress = (goIn ? shapeRel : -shapeRel) / SHAPE_DELTA;
      debugMetrics(`depth leg${leg + 1}/${LEGS.length} ${goIn ? 'in' : 'out'} frac=${m.frac.toFixed(3)}/${startFrac.toFixed(3)} size=${sizeProgress.toFixed(2)} shapeRel=${shapeRel.toFixed(4)} shape=${shapeProgress.toFixed(2)}`);

      if (sizeProgress >= 1 && shapeProgress >= 1) {
        leg++;
        startFrac = m.frac;          // next leg is measured from here
        startShape = m.shape;
        if (leg >= LEGS.length) {
          phase = 'baseline';
          samples.length = 0;
          debugMetrics('depth: all legs confirmed');
        }
        // state:'ok' is what fires the completion chime — each sweep leg is a
        // completed action from the user's side, so it gets the same audible
        // confirmation as a challenge. Without it the setup stage was the one
        // part of the flow that gave no feedback for doing the right thing.
        onStatus?.({ label: 'Good', guide: 'depth', depth: goIn ? 'in' : 'out', state: 'ok', left: 100, right: 100 });
        await sleep(150);
        continue;
      }
      // Moved a long way with no perspective response ⇒ the surface is flat.
      if (sizeProgress >= FLAT_SIZE_MIN && shapeProgress < FLAT_SHAPE_MAX) {
        onStatus?.({ label: 'Flat image detected — use your real face', guide: 'depth', state: 'fail', left: 0, right: 0 });
        return fail('flat');
      }
      const pct = Math.max(0, Math.min(99, Math.round(Math.min(sizeProgress, Math.max(shapeProgress, 0)) * 100)));
      onStatus?.({ label, guide: 'depth', depth: goIn ? 'in' : 'out', left: pct, right: pct });
      await sleep(50);
      continue;
    }

    // ── baseline ─────────────────────────────────────────────────────────────
    samples.push(m);
    if (samples.length > FRAMES) samples.shift();
    if (samples.length === FRAMES) {
      const yaws = samples.map(x => x.yaw);
      if (Math.max(...yaws) - Math.min(...yaws) <= STABLE_YAW_RANGE) break;
      samples.shift();
    }
    onStatus?.({
      label: 'Relax your face', guide: 'hold',
      left: Math.round((samples.length / FRAMES) * 100),
      right: Math.round((samples.length / FRAMES) * 100),
    });
    await sleep(30);
  }

  if (samples.length < FRAMES) return fail('timeout');

  const kept = samples;
  const med = (pick: (m: FaceMetrics) => number) => {
    const v = kept.map(pick).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  // EAR ignores frames caught mid-blink so the open-eye reference stays honest.
  const open = kept.map(m => m.ear).filter(e => e > 0.15).sort((a, b) => a - b);
  const neutral: NeutralBaseline = {
    ear: open.length ? open[Math.floor(open.length * 0.7)] : med(m => m.ear),
    lift: med(m => m.lift), width: med(m => m.width), open: med(m => m.open),
    yaw: med(m => m.yaw), skew: med(m => m.skew), centreX: med(m => m.centreX),
    brow: med(m => m.brow), frac: med(m => m.frac), shape: med(m => m.shape),
    earSd: (() => {
      const xs = kept.map(m => m.ear);
      const mu = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
      return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length || 1));
    })(),
  };
  if (preNeutral) {
    debugMetrics(`consistency pre→post: width ${(neutral.width - preNeutral.width).toFixed(4)} lift ${(neutral.lift - preNeutral.lift).toFixed(4)} brow ${(neutral.brow - preNeutral.brow).toFixed(4)}`);
  }
  debugMetrics(`neutral(once): ear=${neutral.ear.toFixed(3)} lift=${neutral.lift.toFixed(4)} width=${neutral.width.toFixed(4)} open=${neutral.open.toFixed(3)} yaw=${neutral.yaw.toFixed(3)} skew=${neutral.skew.toFixed(3)} cx=${neutral.centreX.toFixed(3)} brow=${neutral.brow.toFixed(4)} earSd=${neutral.earSd.toFixed(4)} frac=${neutral.frac.toFixed(3)} shape=${neutral.shape.toFixed(4)}`);
  return { ok: true, neutral };
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
  // Head turn. Measured on real runs: at rest the jaw-ratio jitters up to 0.028,
  // a SLIGHT turn of the head reaches 0.045-0.084, and a deliberate turn reaches
  // 0.105-0.33. 0.085 sat at the top of the "slight" band, which is why a small
  // movement filled the bar immediately. 0.13 sits below every deliberate turn
  // measured and above every slight one.
  // Raised on request so the bar fills roughly half as fast per degree turned.
  // 0.22, not a literal 2x: the last trace peaked at jaw 0.133 and stopped
  // there because it passed, so the true ceiling is unknown from that run —
  // 0.26 would sit above everything recorded. 0.22 makes the same turn read
  // ~60%, demanding a visibly further rotation while staying inside the
  // 0.105-0.33 band deliberate turns have historically produced. Skew tracks at
  // ~1.4x jaw in practice, so it moves with it and stays the looser of the two.
  const YAW_DELTA = 0.22;
  const SKEW_DELTA = 0.15;
  // Max allowed movement of the face across the frame while turning, as a
  // fraction of frame width. A neck-pivoted turn shifts the face ~5-7%; a body
  // slide big enough to fake that yaw moves it 15-20%.
  //
  // This was 0.035 — BELOW the 5-7% a genuine turn produces, so honest turns hit
  // "keep your head in place" and the hold kept resetting. 0.08 clears a real
  // neck pivot with margin and still sits far under a slide. The cap is not what
  // stops a slide anyway: rotationDominates below is drift-RELATIVE, and for a
  // slide to fake YAW_DELTA it would have to travel ~0.37 of the frame, which
  // this cap rejects many times over.
  const CENTRE_DRIFT_MAX = 0.08;
  // Yaw that a pure sideways move explains on its own: apparent rotation grows
  // ~0.35 of jaw-ratio per unit of frame-width drift (60-degree lens, arm's
  // length). Demanding the observed yaw be several times that is what makes a
  // slide fail even when it drifts less than the cap above.
  const TRANSLATION_YAW_GAIN = 0.35;
  const ROTATION_MARGIN = 3.0;
  // Eyebrow raise over the rolling relaxed reference, measured as a WINDOWED
  // MEAN. Per frame the signal is hopeless: at rest it swings ±0.013 while a
  // real raise averages only 0.028, so the bar lurched between 0 and 50% on a
  // motionless face. Averaging ~400ms shrinks the resting noise to sd 0.003
  // while leaving the raise at 0.028 — an 8-sigma separation instead of 2.
  // 0.032, not 0.020. Once the reference became rolling, a real raise measured
  // far larger than the fixed-baseline estimate this threshold was set from:
  // logged at rest max +0.0081 (sd 0.0046) against a sustained raise of
  // 0.032-0.066. 0.020 sat at only 2.5x the resting maximum and a third of a
  // real raise, which is why it passed on almost nothing. 0.032 is 4x resting
  // noise and still only half of the measured raise.
  // 0.038 = 0.032 + 20%, on request. Note this is close to the top of what the
  // last trace recorded: the raise ran 0.031 -> 0.042, so only the final frames
  // clear it and they must still hold for SUSTAIN_MS. If a genuine raise starts
  // timing out, this is the number to walk back first.
  const BROW_DELTA = 0.038;
  const BROW_WINDOW_MS = 400;
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
  const browWindow: { t: number; v: number }[] = [];
  // Every action must be HELD, not merely touched. Jitter crosses a threshold
  // for one frame; a deliberate expression stays there. This is what stops the
  // checks feeling "too sensitive" without making them physically harder — the
  // bar to clear is unchanged, it just has to be sustained.
  const SUSTAIN_MS = 320;
  let metSince = 0;
  /**
   * Hysteresis: `met` ARMS the hold, `holding` (when given) KEEPS it. Landmark
   * noise makes a signal sitting just over the line dip below it for the odd
   * frame, and without this a single dip restarts the whole 320ms — which is
   * what made holding a turn feel like balancing rather than posing. Arming
   * still costs full threshold, so the bar to clear is unchanged.
   */
  const HOLD_FRACTION = 0.75;
  const sustained = (met: boolean, holding?: boolean): boolean => {
    const t = Date.now();
    const keep = metSince ? (holding ?? met) : met;
    if (!keep) { metSince = 0; return false; }
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
    type === 'close-eyes' ? 'close eyes' :
    type === 'look-left' ? 'look left' : 'look right';
  const guide: CaptureGuide =
    type === 'blink' ? 'blink' : type === 'smile' ? 'smile' :
    type === 'mouth-open' ? 'mouth' : type === 'raise-brows' ? 'brow' :
    type === 'close-eyes' ? 'eyes' : 'turn';
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
    `Turn head ${turnSide}`;

  onStatus?.({ label: prompt, guide, dir: guide === 'turn' ? turnSide : undefined, left: 0, right: 0 });

  // Frame time is dominated by the detector's input size. Blink needs the
  // highest possible frame rate to catch a ~100ms closure, and eye landmarks
  // survive the smaller input fine; the other actions keep 320 for stability.
  const inputSize = type === 'blink' ? 224 : 320;

  while (Date.now() < deadline) {
    const solo = await detectSolo(video, inputSize);
    if (solo.count > 1) {
      // Abort, never pick a winner: a second face mid-action is a photo or
      // screen held beside the real head, which is exactly the swap this whole
      // sequence exists to prevent.
      debugMetrics(`challenge ABORT: ${solo.count} faces in frame`);
      onStatus?.({ label: 'Only one face in frame', guide: 'search', state: 'fail', left: 0, right: 0 });
      return false;
    }
    const det: { landmarks?: { positions: Point[] } } | undefined =
      solo.pts ? { landmarks: { positions: solo.pts } } : undefined;
    if (!det?.landmarks) {
      // A miss counts toward the continuity budget — this is where a swap shows up.
      if (absenceBroken(guard)) {
        onStatus?.({ label: noFaceLabel(video, 'Out of frame / Too dark!'), guide: 'search', state: 'fail', left: 0, right: 0 });
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
      // Safety terms (direction agreement, no slide, rotation dominates) are
      // required throughout; only the magnitudes get the hysteresis, so a held
      // turn survives landmark jitter but a slide never sneaks through the hold.
      const safe = agree && stayedPut && rotationDominates;
      const armTurn = delta >= YAW_DELTA && Math.abs(skewΔ) >= SKEW_DELTA && safe;
      const holdTurn = delta >= YAW_DELTA * HOLD_FRACTION
        && Math.abs(skewΔ) >= SKEW_DELTA * HOLD_FRACTION && safe;
      if (sustained(armTurn, holdTurn)) {
        onStatus?.({ label: 'Turn detected', guide: 'turn', dir: turnSide, left: 100, right: 100, state: 'ok' });
        return true;
      }
      if (!stayedPut) {
        // Name the mistake instead of silently refusing to fill the bar.
        onStatus?.({ label: 'Keep your head in place — turn, don\'t move', guide: 'turn', left: 0, right: 0 });
        await sleep(60);
        continue;
      }
      // Bar tracks the WEAKER signal, so it only fills on a genuine rotation —
      // and it stays empty while the SAFETY terms are unmet, because those are
      // part of the test too. Dividing the magnitudes alone let a body slide
      // fill the bar to 99% while rotationDominates silently held the action
      // shut: the bar promised a pass that could not arrive. (Same defect as the
      // close-eyes bar reading a reference the test did not use.)
      const pct = (agree && rotationDominates)
        ? Math.min(99, Math.round(Math.min(
          delta / YAW_DELTA, Math.abs(skewΔ) / SKEW_DELTA,
        ) * 100))
        : 0;
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
      const nowMs = Date.now();
      browWindow.push({ t: nowMs, v: browNow });
      while (browWindow.length && nowMs - browWindow[0].t > BROW_WINDOW_MS) browWindow.shift();
      const browMean = browWindow.reduce((a, b) => a + b.v, 0) / (browWindow.length || 1);
      const browΔ = browMean - browRef;
      if (browNow - browRef < BROW_DELTA * 0.5) {
        browRefHist.push({ t: Date.now(), v: browNow });
        while (browRefHist.length && Date.now() - browRefHist[0].t > OPEN_REF_MS) browRefHist.shift();
      }
      debugMetrics(`brow browΔ=${browΔ.toFixed(4)}/${BROW_DELTA} ref=${browRef.toFixed(4)} raw=${browNow.toFixed(4)} n=${browWindow.length}`);
      if (sustained(browΔ >= BROW_DELTA)) {
        onStatus?.({ label: 'Eyebrows detected', guide: 'brow', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.max(0, Math.min(99, Math.round((browΔ / BROW_DELTA) * 100)));
      onStatus?.({ label: 'Raise your eyebrows', guide: 'brow', left: pct, right: pct });

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
      // MEDIAN, not the 80th percentile. The test compares a window MEAN against
      // this reference, and comparing a mean to a high percentile builds in a
      // systematic gap even when nothing happens — the reference sits above the
      // middle of the same noise the mean sits in the middle of. Combined with
      // slow drift that gap reached 0.015 with the eyes fully OPEN, which is the
      // entire margin, so the check passed on an open-eyed face (caught in a real
      // trace: mean 0.321 against a 0.321 threshold, openRef 0.336). The
      // percentile was defensive against closure frames polluting the reference,
      // but openRefHist is already filtered to exclude them below — so it bought
      // nothing and cost a false pass. Median against mean is unbiased.
      const sortedOpen = openRefHist.map(e => e.ear).sort((a, b) => a - b);
      const openRef = sortedOpen.length >= 6
        ? sortedOpen[Math.floor(sortedOpen.length * 0.5)]
        : (earOpen || 0.30);
      // Floor raised 0.015 -> 0.018: a real closure measured 0.018-0.027 of EAR
      // drop, while session drift alone covered 0.015. 3-sigma of per-frame noise
      // (~0.010) does not bound drift, so the floor is what actually governs.
      const margin = Math.max(3.0 * (earSdNeutral || 0.008), 0.018);
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
      // Measured against openRef — the SAME reference the pass test uses — not
      // the calibration baseline. earOpen is a single snapshot from setup, and
      // EAR drifts downward across a session with pose and distance (measured
      // 0.333 at calibration against 0.312 a few seconds later, eyes wide open).
      // Dividing that drift by the margin put the bar at 99% on open eyes while
      // the test, correctly using the rolling reference, refused to fire — a bar
      // that says "nearly there" while nothing is happening. Bar and test must
      // read the same number or one of them is lying.
      const depth = openRef > 0 ? (openRef - windowMean) / margin : 0;
      const pct = Math.max(0, Math.min(99, Math.round(depth * Math.min(1, span / CLOSE_HOLD_MS) * 100)));
      // Feed the reference ONLY with frames that are not part of a closure —
      // otherwise a long hold drags the reference down to meet the closure and
      // the test can never fire (observed: openRef decaying 0.329 -> 0.304 while
      // the eyes stayed shut).
      // Feed only frames that are CLEARLY open, judged against the reference
      // itself — not merely frames that have not passed yet.
      //
      // `windowMean > closedBelow` meant "not currently passing", which is true
      // for the entire descent into a closure, so every frame on the way down
      // fed the reference and dragged it after the eyes. Logged: the reference
      // fell 0.318 -> 0.292 during one closure, the threshold followed to 0.274,
      // and a mean of 0.286 — a perfectly good closure that would have passed
      // against the pre-closure reference — never caught it. The check became
      // unpassable by chasing its own target, which is the same failure the
      // earlier fix was meant to stop; it just came back through a looser test.
      //
      // Requiring the frame to sit within 40% of a margin of the reference keeps
      // slow drift tracked while a closure, which is a full margin away, stops
      // contributing the moment it begins.
      if (ear >= openRef - margin * 0.4) {
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
