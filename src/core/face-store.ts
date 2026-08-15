/**
 * Face+PIN combined-key encrypted key storage (pinVersion=2).
 *
 * Encryption scheme:
 *   faceBytes  = PBKDF2-SHA256(quantizedDescriptor, "neuronchain-face-v1", 100k)   32 bytes
 *   pinBytes   = PBKDF2-SHA512(pin, pinSalt, 600k)                                 32 bytes
 *   sharedKey  = AES-GCM key derived from XOR(faceBytes, pinBytes)
 *   encryptedKeys = AES-GCM(sharedKey, KeyPairJSON)   ← single layer
 *
 * Both factors are required to derive sharedKey; neither alone can decrypt.
 * The PIN salt and pinVerifier are stored in the blob (enabling UX PIN
 * verification), but the main payload requires the combined key.
 *
 * The blob also carries a face-key-encrypted attempt counter so that
 * exponential backoff state transfers to new devices when the blob is
 * fetched from the libp2p network.
 *
 * ⚠ What that counter is and is NOT. It is sealed under the ENROLLMENT face key,
 * which is only recoverable by decrypting `encryptedCanonical` with the PIN — so
 * it can be read only on a recovery that already succeeded, never as a gate
 * before one. It therefore carries backoff state between a user's own devices;
 * it is not, and cannot be, a defence against PIN guessing. No such defence is
 * possible in the blob: the blob is public by design (gossiped and archived so
 * recovery does not depend on any one peer), so an attacker holding it has
 * exactly the inputs the legitimate user has before the PIN is known, and can in
 * any case brute-force `pinVerifier` offline while ignoring the counter
 * entirely. What actually costs the attacker is the KDF — PBKDF2-SHA-512 at
 * 600k iterations, ~300 ms per guess (see pin-crypto.ts). Enforced rate limiting
 * would have to live on the relay that serves the blob, and does not today.
 *
 * The live enforcement path is local IndexedDB (`checkPinLockout`) plus signed
 * `LockoutNotice` gossip — both in pin-crypto.ts, neither of which reads this
 * field.
 */

import { KeyPair } from './crypto';
import {
  deriveFaceKey,
  deriveFaceRawBits,
  encryptWithFaceKey,
  decryptWithFaceKey,
  quantizeDescriptor,
  compareFaces,
  debugMetrics,
  MATCH_THRESHOLD,
} from './face-verify';
import { bytesToHex } from './dag-block';
import {
  derivePinKey,
  derivePinRawBits,
  encryptWithPinKey,
  decryptWithPinKey,
  generatePinSalt,
  PinAttemptState,
} from './pin-crypto';

export interface EncryptedKeyBlob {
  /** pinVersion=2: AES-GCM(XOR(faceBytes,pinBytes), KeyPairJSON); pinVersion=0/1: legacy layers */
  encryptedKeys: string;
  /** SHA-256 hash of quantized face descriptor (public reference) */
  faceMapHash: string;
  /** Username */
  username: string;
  /** On-chain account identity (engine compressed-hex pubkey). Also the face-key salt. */
  pub: string;
  /** Timestamp */
  createdAt: number;
  /** SHA-256(encryptedKeys:faceMapHash:pub) - ties blob to account on-chain */
  linkedAnchor?: string;
  /** base64 32-byte PBKDF2 salt for PIN key derivation */
  pinSalt?: string;
  /** 0 = legacy face-only, 1 = face+PIN two-layer, 2 = face+PIN combined key (current) */
  pinVersion?: number;
  /**
   * JSON {failedAttempts, lockedUntil} encrypted with the ENROLLMENT face key
   * (`deriveFaceKey(quantize(canonical), pub)`) — NOT the live scan, which
   * cannot reproduce those quantization bins. Readable only once the canonical
   * has been recovered with the PIN; see the module header for why that means
   * it carries state rather than enforcing it.
   */
  pinAttemptState?: string;
  /** AES-GCM(pinKey, "PINOK") - allows verifying PIN without decrypting full key blob */
  pinVerifier?: string;
  /**
   * AES-GCM(pinKey, JSON(canonical descriptor)) - the pre-quantization averaged
   * face descriptor, encrypted with the PIN key so recovery is deterministic.
   * Decrypted with PIN → quantize → derive face key (same key as enrollment).
   * Without this field the face key must be derived from the live scan, which
   * is not reliably reproducible across sessions.
   */
  encryptedCanonical?: string;
  /**
   * Unix ms timestamp of the last blob modification.
   * Used to resolve conflicts when multiple nodes gossip the same blob -
   * only the newest version is kept in local IDB.
   */
  updatedAt?: number;
}

// ── Combined key derivation ───────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from XOR(faceBytes, pinBytes).
 * Used by both createEncryptedKeyBlob and recoverKeysWithFace for pinVersion=2.
 * Also exported so that main.ts can re-derive the combined key for blob updates
 * (face update, PIN change) without re-running the full recovery flow.
 */
export async function deriveCombinedKey(faceBytes: Uint8Array, pinBytes: Uint8Array): Promise<CryptoKey> {
  const xored = new Uint8Array(32);
  for (let i = 0; i < 32; i++) xored[i] = faceBytes[i] ^ pinBytes[i];
  return crypto.subtle.importKey('raw', xored as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ── linkedAnchor computation ──────────────────────────────────────────────────

async function computeLinkedAnchor(encryptedKeys: string, faceMapHash: string, pub: string): Promise<string> {
  const input = `${encryptedKeys}:${faceMapHash}:${pub}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

// ── Attempt state (stored inside blob, face-key-encrypted) ────────────────────

async function encryptAttemptState(state: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>, faceKey: CryptoKey): Promise<string> {
  return encryptWithFaceKey(JSON.stringify(state), faceKey);
}

async function decryptAttemptState(encrypted: string, faceKey: CryptoKey): Promise<Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'> | null> {
  const raw = await decryptWithFaceKey(encrypted, faceKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>;
  } catch {
    return null;
  }
}

const NO_ATTEMPTS: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'> = { failedAttempts: 0, lockedUntil: 0 };

/**
 * Read the embedded attempt counter with the face key it was WRITTEN under.
 *
 * That key is derived from the ENROLLMENT canonical descriptor — the one sealed
 * into the blob — never from the live scan. The two are not interchangeable:
 * `deriveFaceKey` quantizes into 0.1 bins, and reproducing a 128-D bin vector
 * from a fresh camera frame is effectively impossible (that is the whole reason
 * `encryptedCanonical` exists). Deriving the read key from the live scan, as
 * this did, meant the counter never once decrypted and every recovery silently
 * fell back to zero.
 *
 * Best-effort by design: a blob written before this field existed, or one whose
 * counter is corrupt, must not block a legitimate recovery.
 */
async function readAttemptState(
  blob: EncryptedKeyBlob,
  faceKey: CryptoKey,
): Promise<Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>> {
  if (!blob.pinAttemptState) return NO_ATTEMPTS;
  return (await decryptAttemptState(blob.pinAttemptState, faceKey)) ?? NO_ATTEMPTS;
}

// ── Blob creation ─────────────────────────────────────────────────────────────

/**
 * Create a combined-key encrypted key blob (pinVersion=2).
 *
 * If `pin` is provided:
 *   sharedKey     = AES-GCM(XOR(faceBytes, pinBytes))
 *   encryptedKeys = AES-GCM(sharedKey, KeyPair JSON)   ← single layer, both factors required
 *
 * If `pin` is omitted (legacy face-only path):
 *   encryptedKeys = AES-GCM(face key, KeyPair JSON)
 */
export async function createEncryptedKeyBlob(
  keys: KeyPair,
  username: string,
  canonicalDescriptor: number[],
  faceMapHash: string,
  pin?: string,
  /**
   * On-chain account identity (engine compressed-hex pubkey). Stored as `blob.pub`
   * and used as the salt for the face-key derivation and the linkedAnchor. Must be
   * the SAME value the account is registered under, so loadAccount(blob.pub), the
   * linkedAnchor integrity check, and PIN-change/face-update (which salt with
   * acc.pub) all stay consistent. Defaults to keys.pub for legacy/test callers.
   */
  accountId: string = keys.pub,
): Promise<EncryptedKeyBlob> {
  const quantized = quantizeDescriptor(canonicalDescriptor);
  // Enrollment-canonical face key. Seals pinAttemptState (and, for pinVersion=0,
  // the keys themselves). recoverKeysWithFace re-derives exactly this key from
  // the PIN-decrypted canonical, which is the only way the counter reads back.
  const faceKey = await deriveFaceKey(quantized, accountId);
  const keysJson = JSON.stringify(keys);

  let encryptedKeys: string;
  let pinSalt: string | undefined;
  let pinVersion = 0;
  let pinVerifier: string | undefined;
  let encryptedCanonical: string | undefined;

  if (pin !== undefined) {
    const saltBytes = generatePinSalt();
    let binary = '';
    for (let i = 0; i < saltBytes.length; i++) binary += String.fromCharCode(saltBytes[i]);
    pinSalt = btoa(binary);

    // One PBKDF2 call for the PIN - reuse pinBytes for both pinKey and combined key
    const pinBytes = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Combined key: XOR(faceBytes, pinBytes) - both factors required to decrypt
    const faceBytes = await deriveFaceRawBits(quantized, accountId);
    const sharedKey = await deriveCombinedKey(faceBytes, pinBytes);
    encryptedKeys = await encryptWithPinKey(keysJson, sharedKey);  // single layer

    pinVerifier = await encryptWithPinKey('PINOK', pinKey);
    encryptedCanonical = await encryptWithPinKey(JSON.stringify(canonicalDescriptor), pinKey);
    pinVersion = 2;
  } else {
    encryptedKeys = await encryptWithFaceKey(keysJson, faceKey);
  }

  const linkedAnchor = await computeLinkedAnchor(encryptedKeys, faceMapHash, accountId);

  const blob: EncryptedKeyBlob = {
    encryptedKeys,
    faceMapHash,
    username,
    pub: accountId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    linkedAnchor,
    pinVersion,
    pinSalt,
    pinVerifier,
    encryptedCanonical,
    pinAttemptState: await encryptAttemptState({ failedAttempts: 0, lockedUntil: 0 }, faceKey),
  };

  return blob;
}

// ── Blob verification ─────────────────────────────────────────────────────────

export async function verifyKeyBlobHash(blob: EncryptedKeyBlob, expectedAnchor: string): Promise<boolean> {
  const computed = await computeLinkedAnchor(blob.encryptedKeys, blob.faceMapHash, blob.pub);
  return computed === expectedAnchor;
}

// ── Attempt state update ──────────────────────────────────────────────────────

/**
 * Re-encrypt the attempt state inside the blob with the face key.
 *
 * `faceKey` MUST be the enrollment-canonical key — pass the one
 * `recoverKeysWithFace` returns, which is derived from the stored canonical, or
 * (on a face change) the key derived from the new canonical being sealed in.
 * A live-scan key writes a counter nothing can ever read back.
 *
 * Necessarily only callable on a SUCCESSFUL recovery: producing that key needs
 * the canonical, and the canonical needs the PIN. A failed attempt cannot update
 * the blob — its counter lives in local IndexedDB (`recordPinFailure`).
 */
export async function updateAttemptStateInBlob(
  blob: EncryptedKeyBlob,
  faceKey: CryptoKey,
  state: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>,
): Promise<EncryptedKeyBlob> {
  return {
    ...blob,
    updatedAt: Date.now(),
    pinAttemptState: await encryptAttemptState(state, faceKey),
  };
}

// ── Key recovery ──────────────────────────────────────────────────────────────

/**
 * The biometric gate, with the number it decided on written to the `[face]`
 * trace — on a pass as well as a fail.
 *
 * This is the measurement the whole threshold rests on and it was the one thing
 * never recorded. A failed recovery returned a bare `null`, so "a stranger tried"
 * (distance ~0.9) and "the owner missed by a hair" (distance 0.46) were
 * indistinguishable from the outside — including to us, which is why the
 * quantized-comparison bug survived as long as it did. Logging the passes
 * matters just as much: the threshold can only be judged against the spread of
 * distances real recoveries actually produce.
 *
 * Same reasoning as the blink timeout logging in face-verify: never discard the
 * near-miss, or you cannot tell a wrong answer from a tight threshold.
 */
function matchOrLog(storedCanonical: number[], liveDescriptor: number[]): boolean {
  const { distance, match } = compareFaces(storedCanonical, liveDescriptor);
  debugMetrics(
    `recovery match distance=${distance.toFixed(3)} threshold=${MATCH_THRESHOLD} ` +
    `margin=${(MATCH_THRESHOLD - distance).toFixed(3)} ${match ? 'PASS' : 'FAIL'}`,
  );
  return match;
}

export interface RecoveryResult {
  keys: KeyPair;
  faceKey: CryptoKey;
  attemptState: Pick<PinAttemptState, 'failedAttempts' | 'lockedUntil'>;
}

/**
 * Recover keys from a blob using a face scan and PIN.
 *
 * Supports:
 *   pinVersion=2 (combined key): derives sharedKey = AES(XOR(faceBytes, pinBytes))
 *   pinVersion=1 (two-layer legacy): decrypts PIN outer then face inner
 *   pinVersion=0 (face-only legacy): decrypts with face key only
 *
 * Returns null if decryption fails (wrong face or wrong PIN).
 */
export async function recoverKeysWithFace(
  blob: EncryptedKeyBlob,
  newDescriptor: number[],
  pin?: string,
): Promise<RecoveryResult | null> {
  // Live-scan face key. ONLY the legacy pinVersion=0 path may use this: there
  // the payload really is sealed under a live-reproducible key, which is the
  // fragility that pinVersion≥1 exists to remove. The attempt counter is read
  // per-branch, under the key it was written with (see readAttemptState).
  const quantized = quantizeDescriptor(newDescriptor);
  const faceKey = await deriveFaceKey(quantized, blob.pub);

  // ── Combined-key blob (pinVersion === 2) ───────────────────────────────────
  if (blob.pinVersion === 2) {
    if (!pin || !blob.pinSalt || !blob.encryptedCanonical) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    // Single PBKDF2 for PIN - reuse bits for both pinVerifier check and combined key
    const pinBytes = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Quick PIN check via pinVerifier
    if (blob.pinVerifier) {
      const pv = await decryptWithPinKey(blob.pinVerifier, pinKey);
      if (pv !== 'PINOK') return null;
    }

    // Recover stored canonical descriptor (deterministic face key source)
    const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, pinKey);
    if (!canonicalJson) return null;

    let storedCanonical: number[];
    try { storedCanonical = JSON.parse(canonicalJson) as number[]; } catch { return null; }

    const storedQuantized = quantizeDescriptor(storedCanonical);

    // Biometric verification: live scan must match stored canonical.
    // (compareFaces returns { distance, match } — must check .match, not the object.)
    //
    // RAW descriptors on both sides. Comparing the QUANTIZED pair — as this did —
    // is not the same test with a rounding error, it is a different and far
    // stricter test: 0.1 bins on a unit-norm 128-D vector amplify distance by
    // roughly a square root (raw 0.35 measures 0.55), so MATCH_THRESHOLD 0.45
    // was enforcing ~0.21 raw. A face re-scanned under different lighting lands
    // around 0.30–0.45 raw, which cleared the intended gate and failed the one
    // actually running — an account enrolled in a dim room could not be
    // recovered in daylight by its own owner. Quantization exists solely so the
    // KEY derivation below reproduces its bins exactly; it has no business in a
    // distance comparison. Raw @0.45 is also what the relay's Sybil check and
    // dag-ledger.countMatchingFaceAccounts already use, so all three "is this
    // the same human?" decisions now agree instead of contradicting each other.
    if (!matchOrLog(storedCanonical, newDescriptor)) return null;

    // Derive combined key and decrypt
    const faceBytes = await deriveFaceRawBits(storedQuantized, blob.pub);
    const sharedKey = await deriveCombinedKey(faceBytes, pinBytes);
    const decrypted = await decryptWithPinKey(blob.encryptedKeys, sharedKey);
    if (!decrypted) return null;

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch { return null; }

    // The enrollment-canonical face key: what sealed the counter, and what
    // `updateAttemptStateInBlob` will re-seal it with via the returned faceKey.
    const resolvedFaceKey = await deriveFaceKey(storedQuantized, blob.pub);
    return { keys, faceKey: resolvedFaceKey, attemptState: await readAttemptState(blob, resolvedFaceKey) };
  }

  // ── Two-layer blob (pinVersion === 1) ─────────────────────────────────────
  if (blob.pinVersion === 1) {
    if (!pin || !blob.pinSalt) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    const pinKey = await derivePinKey(pin, saltBytes);

    // Decrypt outer (PIN) layer → intermediate (face-encrypted) ciphertext
    const intermediate = await decryptWithPinKey(blob.encryptedKeys, pinKey);
    if (!intermediate) return null;

    let resolvedFaceKey = faceKey;
    if (blob.encryptedCanonical) {
      const canonicalJson = await decryptWithPinKey(blob.encryptedCanonical, pinKey);
      if (canonicalJson) {
        try {
          const storedCanonical = JSON.parse(canonicalJson) as number[];
          const storedQuantized = quantizeDescriptor(storedCanonical);
          resolvedFaceKey = await deriveFaceKey(storedQuantized, blob.pub);
          // Raw on both sides — same reasoning as the pinVersion=2 path above.
          if (!matchOrLog(storedCanonical, newDescriptor)) return null;
        } catch { /* fall back to live-scan key */ }
      }
    }

    // Decrypt inner (face) layer → KeyPair JSON
    const decrypted = await decryptWithFaceKey(intermediate, resolvedFaceKey);
    if (!decrypted) return null;

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch { return null; }

    // resolvedFaceKey is the enrollment-canonical key when the blob carries one,
    // and falls back to the live-scan key only for a v1 blob written without it —
    // which is also the key such a blob's counter was written under, so the two
    // stay consistent either way.
    return { keys, faceKey: resolvedFaceKey, attemptState: await readAttemptState(blob, resolvedFaceKey) };
  }

  // ── Legacy face-only blob (pinVersion === 0) ───────────────────────────────
  const decrypted = await decryptWithFaceKey(blob.encryptedKeys, faceKey);
  if (!decrypted) return null;

  try {
    const keys = JSON.parse(decrypted) as KeyPair;
    if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    // v0 sealed everything under the live-reproducible face key, and the payload
    // above just decrypted with it — so here it IS the write key.
    return { keys, faceKey, attemptState: await readAttemptState(blob, faceKey) };
  } catch {
    return null;
  }
}
