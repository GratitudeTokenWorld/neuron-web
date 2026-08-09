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
export type CaptureGuide = 'search' | 'turn' | 'blink' | 'smile' | 'mouth' | 'hold';

/** An action the user can be challenged to perform. */
export type ChallengeAction = 'blink' | 'smile' | 'mouth-open' | 'look-left' | 'look-right';

/**
 * The actions used to gate enrollment, in the order-randomised sequence.
 *
 * `blink` is deliberately EXCLUDED. Measured on real hardware, this landmark
 * model barely moves the eye-aspect-ratio during a blink: open ≈ 0.32, a full
 * blink bottoms at ≈ 0.29, while frame-to-frame jitter alone spans 0.29–0.35.
 * There is no threshold that separates a blink from noise, so any setting is
 * either unpassable or free — security theatre either way. `mouth-open` replaces
 * it: same "do a thing on demand" property, with a signal an order of magnitude
 * larger (neutral ≈ 0.1, open ≈ 0.5). The blink detector is kept for hardware
 * where it does work, and can be re-added here once verified with neuron_debug.
 */
export const CHALLENGE_SEQUENCE_ACTIONS: readonly ChallengeAction[] = ['smile', 'mouth-open'];

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
      .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.3 }))
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
    if (!desc) {
      if (retries++ > 10) return null;
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
  const SMILE_LIFT_DELTA = 0.0152;
  const SMILE_WIDTH_DELTA = 0.0380;
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
  let earBelowCount = 0;
  let sawEyesOpen = false;
  // Calibrated neutrals (filled during the calibration frames).
  const earOpenSamples: number[] = [];
  const liftSamples: number[] = [];
  const widthSamples: number[] = [];
  const openSamples: number[] = [];
  const yawSamples: number[] = [];
  const skewSamples: number[] = [];
  let openNeutral = 0, yawNeutral = 0.5, skewNeutral = 0;
  let earOpen = 0, liftNeutral = 0, widthNeutral = 0;
  /** Deepest closure seen — reported on timeout so a near-miss is tunable. */
  let earMin = Infinity;

  const actionLabel =
    type === 'blink' ? 'blink' : type === 'smile' ? 'smile' :
    type === 'mouth-open' ? 'open mouth' :
    type === 'look-left' ? 'look left' : 'look right';
  const guide: CaptureGuide =
    type === 'blink' ? 'blink' : type === 'smile' ? 'smile' :
    type === 'mouth-open' ? 'mouth' : 'turn';
  // Bar side for a head turn. Landmarks are in RAW video coordinates, so a user
  // turning to their own left moves the nose toward higher x; the feed is
  // mirrored for display, which puts that motion on the viewer's left. Hence
  // "their left" == the bar's left half == the on-screen direction they see.
  const turnSide: 'left' | 'right' = type === 'look-right' ? 'right' : 'left';
  // Opening prompt, in the same wording the in-progress cues use.
  const prompt =
    type === 'blink' ? 'Blink' : type === 'smile' ? 'Smile' :
    type === 'mouth-open' ? 'Open your mouth' : `Turn head ${turnSide}`;

  onStatus?.({ label: prompt, guide, left: 0, right: 0 });

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
    if (widthSamples.length < CALIBRATION_FRAMES) {
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
      // Two independent estimators, both past threshold and both moving the SAME
      // way. Leaning or sliding sideways nudges the jaw ratio (perspective) but
      // leaves the eye-referenced skew almost untouched, so it can no longer pass.
      const agree = Math.sign(signed) === Math.sign(skewΔ);
      debugMetrics(`turn jawΔ=${signed.toFixed(4)}/±${YAW_DELTA} skewΔ=${skewΔ.toFixed(4)}/±${SKEW_DELTA} agree=${agree}`);
      if (delta >= YAW_DELTA && Math.abs(skewΔ) >= SKEW_DELTA && agree) {
        onStatus?.({ label: 'Turn detected', guide: 'turn', left: 100, right: 100, state: 'ok' });
        return true;
      }
      // Bar tracks the WEAKER signal, so it only fills on a genuine rotation.
      const pct = Math.min(99, Math.round(Math.min(
        delta / YAW_DELTA, Math.abs(skewΔ) / SKEW_DELTA,
      ) * 100));
      const movingLeft = signed > 0;   // nose drifts toward higher x when turning to their left
      onStatus?.({
        label: `Turn head ${turnSide}`,
        guide: 'turn',
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
      if (liftΔ >= SMILE_LIFT_DELTA && widthΔ >= SMILE_WIDTH_DELTA) {
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
      if (openΔ >= MOUTH_OPEN_DELTA) {
        onStatus?.({ label: 'Mouth open detected', guide: 'mouth', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.max(0, Math.min(99, Math.round((openΔ / MOUTH_OPEN_DELTA) * 100)));
      onStatus?.({ label: 'Open your mouth', guide: 'mouth', left: pct, right: pct });
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

// ──── Liveness Detection (Movement) ────

/**
 * Liveness detection via face movement.
 *
 * Tracks the nose landmark across frames and confirms the user
 * moved their head (proving live person, not a static photo).
 * Much more reliable than blink/EAR detection.
 */
export async function detectLiveness(
  video: HTMLVideoElement,
  timeoutMs = 15000,
  onStatus?: (cue: CaptureCue) => void,
): Promise<boolean> {
  const startTime = Date.now();
  let framesWithFace = 0;
  let framesWithoutFace = 0;
  const nosePositions: { x: number; y: number }[] = [];
  // Require a genuine excursion to BOTH sides of the resting position, ≥TURN_PX
  // each. That is at least as strong as the previous "30px total range + 2
  // direction reversals" (it implies both) while being un-spoofable by jitter,
  // and — unlike a reversal counter — it maps directly onto a two-sided progress
  // bar: each half fills with how far that side has actually been turned.
  const TURN_PX = 15;
  let leftMax = 0;    // nose x ABOVE baseline → user turned to their left
  let rightMax = 0;   // nose x BELOW baseline → user turned to their right
  let baseline: number | null = null;
  const baselineSamples: number[] = [];

  // Don't claim a face was found before we've actually looked — show a neutral prompt until
  // the detection loop confirms one (otherwise "Face detected" flashes before the camera
  // has even produced a frame).
  onStatus?.({ label: 'Show your face', guide: 'search', left: 0, right: 0 });

  while (Date.now() - startTime < timeoutMs) {
    // Skip detection until the camera is actually streaming frames — running face-api on a
    // not-yet-playing video element wastes a cycle and can briefly report a stale result.
    if (video.readyState < 2 || !video.videoWidth) { await sleep(100); continue; }

    let detection;
    try {
      detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
        .withFaceLandmarks();
    } catch {
      await sleep(200);
      continue;
    }

    if (detection) {
      framesWithFace++;
      const nose = detection.landmarks.positions[30];
      nosePositions.push({ x: nose.x, y: nose.y });
      if (nosePositions.length > 40) nosePositions.shift();

      // Resting position from the first frames, then measure each side's excursion.
      if (baseline === null) {
        baselineSamples.push(nose.x);
        if (baselineSamples.length >= 5) {
          baseline = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
        } else {
          onStatus?.({ label: 'Hold still', guide: 'hold', left: 0, right: 0 });
          await sleep(100);
          continue;
        }
      }

      const signed = nose.x - baseline;
      if (signed > 0) leftMax = Math.max(leftMax, signed);
      else rightMax = Math.max(rightMax, -signed);

      const leftPct = Math.min(100, Math.round((leftMax / TURN_PX) * 100));
      const rightPct = Math.min(100, Math.round((rightMax / TURN_PX) * 100));

      if (leftPct >= 100 && rightPct >= 100) {
        onStatus?.({ label: 'Liveness confirmed', guide: 'turn', left: 100, right: 100, state: 'ok' });
        return true;
      }

      // Prompt only the side still missing, so there is exactly one thing to do.
      const need = leftPct >= 100 ? 'right' : rightPct >= 100 ? 'left' : 'left and right';
      onStatus?.({
        label: need === 'left and right' ? 'Turn head left, then right' : `Turn head ${need}`,
        guide: 'turn', left: leftPct, right: rightPct,
      });
    } else {
      framesWithoutFace++;
      if (framesWithoutFace % 8 === 0) {
        onStatus?.({ label: 'Move closer', guide: 'search', left: 0, right: 0 });
      }
    }
    await sleep(100);
  }

  onStatus?.({ label: 'Liveness failed — try again', guide: 'search', state: 'fail', left: 0, right: 0 });
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
