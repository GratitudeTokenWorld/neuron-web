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
export type CaptureGuide = 'search' | 'turn' | 'blink' | 'smile' | 'hold';

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

function smileRatio(pts: Point[]): number {
  // Mouth corners 48 & 54, top lip 51, bottom lip 57 (in 68-pt model)
  const mouthWidth  = dist(pts[48], pts[54]);
  const mouthHeight = dist(pts[51], pts[57]);
  return mouthWidth < 0.001 ? 0 : mouthHeight / mouthWidth;
}

/**
 * Detect a specific facial action before face capture.
 * Blocks until the action is confirmed or the timeout expires.
 *
 * Actions:
 *   blink      — eyes seen open, then EAR drops below threshold for 2+ consecutive frames
 *   look-left  — nose X shifts left ≥8 % of video width
 *   look-right — nose X shifts right ≥8 % of video width
 *   smile      — mouth height/width ratio exceeds threshold
 *
 * Returns true when the action is detected, false on timeout.
 */
export async function detectChallenge(
  video: HTMLVideoElement,
  type: 'blink' | 'look-left' | 'look-right' | 'smile',
  timeoutMs = 12000,
  onStatus?: (cue: CaptureCue) => void,
  guard?: PresenceGuard,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const EAR_THRESHOLD = 0.28;
  // Require ≥2 consecutive below-threshold frames (~160ms at 80ms/frame), and only
  // after the eyes have been seen open — a static photo (eyes always open OR always
  // closed) and single-frame sensor noise can no longer register as a blink.
  const BLINK_FRAMES  = 2;
  // mouthHeight/mouthWidth. A relaxed/neutral closed mouth sits well below this;
  // a genuine smile (mouth widens / parts) clears it without straining. Empirically
  // a full smile reaches ~0.28, so 0.22 gives margin above neutral and headroom to pass.
  const SMILE_THRESHOLD = 0.22;
  let earBelowCount = 0;
  let sawEyesOpen = false;
  let baselineNoseX: number | null = null;
  const baselineSamples: number[] = [];

  const actionLabel =
    type === 'blink' ? 'blink' :
    type === 'smile' ? 'smile' :
    type === 'look-left' ? 'look left' : 'look right';
  const guide: CaptureGuide = type === 'blink' ? 'blink' : type === 'smile' ? 'smile' : 'turn';
  // Bar side for a head turn. Landmarks are in RAW video coordinates, so a user
  // turning to their own left moves the nose toward higher x; the feed is
  // mirrored for display, which puts that motion on the viewer's left. Hence
  // "their left" == the bar's left half == the on-screen direction they see.
  const turnSide: 'left' | 'right' = type === 'look-right' ? 'right' : 'left';
  // Opening prompt, in the same wording the in-progress cues use.
  const prompt =
    type === 'blink' ? 'Blink' :
    type === 'smile' ? 'Smile' : `Turn head ${turnSide}`;

  onStatus?.({ label: prompt, guide, left: 0, right: 0 });

  while (Date.now() < deadline) {
    let detection: Awaited<ReturnType<typeof faceapi.detectSingleFace>> & { landmarks?: ReturnType<typeof faceapi.detectSingleFace.prototype.withFaceLandmarks> } | undefined;
    let det: { landmarks?: { positions: Point[] } } | undefined;
    try {
      det = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.3 }))
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
    const videoWidth = video.videoWidth || 640;

    if (type === 'blink') {
      const rightEAR = eyeAspectRatio(pts.slice(36, 42));
      const leftEAR  = eyeAspectRatio(pts.slice(42, 48));
      const ear = (rightEAR + leftEAR) / 2;
      if (ear < EAR_THRESHOLD) {
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
      // Two-stage, so the bar tracks the actual state machine: eyes seen open (50%)
      // then a closure confirmed (100%). Raw EAR is a debug number, not guidance.
      onStatus?.({
        label: sawEyesOpen ? 'Blink now' : 'Open your eyes',
        guide: 'blink', left: sawEyesOpen ? 50 : 0, right: sawEyesOpen ? 50 : 0,
      });

    } else if (type === 'look-left' || type === 'look-right') {
      const nose = pts[30];
      if (baselineNoseX === null) {
        baselineSamples.push(nose.x);
        if (baselineSamples.length >= 5) {
          baselineNoseX = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
        } else {
          await sleep(80); continue;
        }
      }
      // Acceptance stays direction-agnostic (|delta|) as before — the anti-replay
      // value is in "the head moved on demand", and enforcing a sign here would
      // hard-block enrollment if the camera/mirror convention is ever inverted.
      // The BAR uses the signed delta, so it always mirrors the real movement.
      const signed = nose.x - baselineNoseX;
      const delta = Math.abs(signed);
      const threshold = videoWidth * 0.08;
      if (delta > threshold * 0.85) {
        onStatus?.({ label: 'Turn detected', guide: 'turn', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.min(99, Math.round((delta / threshold) * 100));
      const movingLeft = signed > 0;   // raw nose x rises when the user turns to their left
      onStatus?.({
        label: `Turn head ${turnSide}`,
        guide: 'turn',
        left: movingLeft ? pct : 0,
        right: movingLeft ? 0 : pct,
      });

    } else if (type === 'smile') {
      const ratio = smileRatio(pts);
      if (ratio > SMILE_THRESHOLD) {
        onStatus?.({ label: 'Smile detected', guide: 'smile', left: 100, right: 100, state: 'ok' });
        return true;
      }
      const pct = Math.min(99, Math.round((ratio / SMILE_THRESHOLD) * 100));
      onStatus?.({ label: 'Smile', guide: 'smile', left: pct, right: pct });
    }

    await sleep(80);
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
