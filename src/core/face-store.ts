/**
 * Face+PIN(+network share) encrypted key storage.
 *
 * Current scheme (pinVersion=3, "custody-split"):
 *   faceBytes  = PBKDF2-SHA256(quantizedDescriptor, per-account salt, 100k)   32 bytes
 *   pinBytes   = PBKDF2-SHA512(pin, pinSalt, 600k)                            32 bytes
 *   shareBytes = 32 random bytes, generated at creation, held by the RELAYS —
 *                NEVER stored in the blob, released only to a live face that
 *                matches the account's enrolled identity (nid), rate-limited
 *                server-side (relay/server.ts → /recovery-share/release)
 *   encryptedKeys      = AES-GCM(XOR(faceBytes, pinBytes, shareBytes), KeyPairJSON)
 *   encryptedCanonical = AES-GCM(XOR(pinBytes, shareBytes), canonical descriptor)
 *
 * Why v3 exists — the v2 lesson, learned by running the attack (2026-08-15):
 * v2 sealed `encryptedCanonical` under the PIN key ALONE. The PIN therefore
 * unlocked the face descriptor, and the descriptor was the other half of the
 * "combined" key — so the 4-digit PIN was the ONLY protection on the account
 * keys, ~50 min of offline PBKDF2 for anyone holding the public blob, and it
 * leaked the biometric as a bonus. The face check was client-side policy an
 * attacker simply deletes. Two factors sealed inside one public blob can never
 * be more than the weaker factor: the blob hands every input except the PIN to
 * the attacker by construction.
 *
 * v3 fixes this by making the third input LIVE SOMEWHERE ELSE. What each party
 * gets:
 *   blob alone                     → nothing (AES under unknown 256-bit keys)
 *   blob + PIN                     → nothing: encryptedCanonical needs the share,
 *                                    and the share sits behind a relay-enforced
 *                                    live-face match with exponential backoff
 *                                    that clearing site data cannot reset
 *   blob + share (rogue relay)     → still needs the PIN: 600k-iteration PBKDF2
 *                                    per guess — i.e. a compromised relay only
 *                                    degrades to the OLD security level, and the
 *                                    biometric stays sealed under the PIN
 *   blob + PIN + live face (owner) → recovery
 * The pinVerifier still allows offline PIN CONFIRMATION for a blob holder
 * (kept for local UX); with v3 a confirmed PIN no longer opens anything.
 *
 * The blob also carries a face-key-encrypted attempt counter (see field doc):
 * it transfers local-backoff state between a user's own devices. The ENFORCED
 * limits are the relay-side ones on /recovery-share/release; the local IDB
 * counter (`checkPinLockout`) and signed `LockoutNotice` gossip remain as
 * device-local UX friction.
 *
 * pinVersion history: 0 = face-only, 1 = PIN-outer/face-inner layers,
 * 2 = XOR(face,pin) with PIN-sealed canonical (the flaw above), 3 = current.
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
  /**
   * 0 = legacy face-only, 1 = face+PIN two-layer, 2 = face+PIN combined key
   * (canonical sealed under PIN alone — the flaw), 3 = custody-split: a third
   * random factor is held by the relays and never appears in this blob.
   */
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
   * The pre-quantization averaged face descriptor — the input the face key is
   * deterministically derived from (a live scan cannot reproduce quantization
   * bins, which is why this field exists at all).
   *
   * v3: AES-GCM(XOR(pinBytes, shareBytes), JSON(canonical)) — needs the PIN
   * AND the relay-held share, so neither a PIN-cracker nor a rogue relay can
   * read the biometric, and neither can reach the key material behind it.
   * v2/v1: AES-GCM(pinKey, JSON(canonical)) — sealed under the PIN alone,
   * which is what let a PIN-cracker walk the chain to the account keys.
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
 * XOR any number of 32-byte factors into one AES-256-GCM key.
 *
 * XOR is the right combiner here precisely because it is information-theoretic:
 * with `shareBytes` uniformly random and absent from the blob, the XOR of the
 * other factors reveals NOTHING about the key — an attacker missing any one
 * 32-byte input faces the full 2^256 keyspace, not a reduced one. (Contrast
 * layered encryption, where each layer can be attacked as its outermost shell.)
 */
async function xorKey(...parts: Uint8Array[]): Promise<CryptoKey> {
  const xored = new Uint8Array(32);
  for (const p of parts) {
    for (let i = 0; i < 32; i++) xored[i] ^= p[i];
  }
  return crypto.subtle.importKey('raw', xored as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * v2 pair key — XOR(faceBytes, pinBytes). Kept for reading v2 blobs and for
 * main.ts blob-update paths that still handle them.
 */
export async function deriveCombinedKey(faceBytes: Uint8Array, pinBytes: Uint8Array): Promise<CryptoKey> {
  return xorKey(faceBytes, pinBytes);
}

/** v3 outer key — XOR(faceBytes, pinBytes, shareBytes). All three or nothing. */
export async function deriveTripleKey(faceBytes: Uint8Array, pinBytes: Uint8Array, shareBytes: Uint8Array): Promise<CryptoKey> {
  return xorKey(faceBytes, pinBytes, shareBytes);
}

/**
 * The recovery share: 32 uniformly random bytes minted at account creation.
 * Its entire value is WHERE it lives — on the relays, bound to the account's
 * enrolled identity (nid), behind a live-face release gate — so it must never
 * be written into the blob, logged, or gossiped.
 */
export function generateRecoveryShare(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
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
 * Create an encrypted key blob.
 *
 * With `pin` + `recoveryShare` (pinVersion=3, the only mode new accounts use):
 *   encryptedKeys      = AES-GCM(XOR(faceBytes, pinBytes, shareBytes), KeyPair JSON)
 *   encryptedCanonical = AES-GCM(XOR(pinBytes, shareBytes), canonical)
 *   — the share goes to the relays via storeRecoveryShare, NOT into this blob.
 *
 * With `pin` alone (pinVersion=2): the legacy combined-key layout. Kept ONLY so
 * old blobs remain readable and old tests meaningful — do not create new v2
 * blobs in app code; a v2 blob is PIN-strength only (see module header).
 *
 * With neither (pinVersion=0): legacy face-only.
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
  /** 32 random bytes from generateRecoveryShare(); presence selects pinVersion=3. */
  recoveryShare?: Uint8Array,
): Promise<EncryptedKeyBlob> {
  if (recoveryShare && (!pin || recoveryShare.length !== 32)) {
    // A share without a PIN would make the relay the sole gate on the keys;
    // a short share would silently shrink the keyspace. Both are caller bugs.
    throw new Error('recoveryShare requires a PIN and must be 32 bytes');
  }
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
    const faceBytes = await deriveFaceRawBits(quantized, accountId);

    if (recoveryShare) {
      // v3: keys under all three factors; canonical under PIN+share, so the
      // biometric (and the face key derived from it) is out of reach of a
      // PIN-cracker AND of a rogue relay — each holds one factor, not two.
      const outerKey = await deriveTripleKey(faceBytes, pinBytes, recoveryShare);
      encryptedKeys = await encryptWithPinKey(keysJson, outerKey);
      encryptedCanonical = await encryptWithPinKey(
        JSON.stringify(canonicalDescriptor),
        await xorKey(pinBytes, recoveryShare),
      );
      pinVersion = 3;
    } else {
      // v2 (legacy readers/tests only): XOR(face,pin), canonical under PIN alone.
      const sharedKey = await deriveCombinedKey(faceBytes, pinBytes);
      encryptedKeys = await encryptWithPinKey(keysJson, sharedKey);
      encryptedCanonical = await encryptWithPinKey(JSON.stringify(canonicalDescriptor), pinKey);
      pinVersion = 2;
    }

    pinVerifier = await encryptWithPinKey('PINOK', pinKey);
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
 * Recover keys from a blob using a face scan, PIN, and (v3) the relay-released
 * recovery share.
 *
 * Supports:
 *   pinVersion=3 (custody-split): canonical under XOR(pin,share); keys under
 *                XOR(face,pin,share). `recoveryShare` is REQUIRED — obtained
 *                from a relay via the live-face release gate, or from the local
 *                cache on a device that already recovered once.
 *   pinVersion=2 (combined key): derives sharedKey = AES(XOR(faceBytes, pinBytes))
 *   pinVersion=1 (two-layer legacy): decrypts PIN outer then face inner
 *   pinVersion=0 (face-only legacy): decrypts with face key only
 *
 * Returns null if decryption fails (wrong face, wrong PIN, or wrong share).
 */
export async function recoverKeysWithFace(
  blob: EncryptedKeyBlob,
  newDescriptor: number[],
  pin?: string,
  recoveryShare?: Uint8Array,
): Promise<RecoveryResult | null> {
  // Live-scan face key. ONLY the legacy pinVersion=0 path may use this: there
  // the payload really is sealed under a live-reproducible key, which is the
  // fragility that pinVersion≥1 exists to remove. The attempt counter is read
  // per-branch, under the key it was written with (see readAttemptState).
  const quantized = quantizeDescriptor(newDescriptor);
  const faceKey = await deriveFaceKey(quantized, blob.pub);

  // ── Custody-split blob (pinVersion === 3) ──────────────────────────────────
  if (blob.pinVersion === 3) {
    if (!pin || !recoveryShare || recoveryShare.length !== 32 || !blob.pinSalt || !blob.encryptedCanonical) return null;

    const saltBytes = Uint8Array.from(atob(blob.pinSalt), c => c.charCodeAt(0));
    const pinBytes = await derivePinRawBits(pin, saltBytes);
    const pinKey = await crypto.subtle.importKey('raw', pinBytes as unknown as BufferSource, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

    // Fast PIN check — saves the user a wrong-share round trip when it is the
    // PIN that's wrong. (An attacker can run this offline too; with v3 a
    // confirmed PIN opens nothing, which is why the verifier is still safe.)
    if (blob.pinVerifier) {
      const pv = await decryptWithPinKey(blob.pinVerifier, pinKey);
      if (pv !== 'PINOK') return null;
    }

    // Canonical needs PIN AND share — this line is the whole point of v3:
    // the step v2 let a PIN-cracker take alone now requires the factor the
    // relay only releases to a live matching face.
    const canonicalJson = await decryptWithPinKey(
      blob.encryptedCanonical,
      await xorKey(pinBytes, recoveryShare),
    );
    if (!canonicalJson) return null;

    let storedCanonical: number[];
    try { storedCanonical = JSON.parse(canonicalJson) as number[]; } catch { return null; }

    // Biometric gate on RAW descriptors (see the v2 branch for why raw), logged
    // via matchOrLog. Client-side policy here; the ENFORCED face check already
    // happened at the relay before it released the share.
    if (!matchOrLog(storedCanonical, newDescriptor)) return null;

    const storedQuantized = quantizeDescriptor(storedCanonical);
    const faceBytes = await deriveFaceRawBits(storedQuantized, blob.pub);
    const outerKey = await deriveTripleKey(faceBytes, pinBytes, recoveryShare);
    const decrypted = await decryptWithPinKey(blob.encryptedKeys, outerKey);
    if (!decrypted) return null;

    let keys: KeyPair;
    try {
      keys = JSON.parse(decrypted) as KeyPair;
      if (!keys.pub || !keys.priv || !keys.epub || !keys.epriv) return null;
    } catch { return null; }

    const resolvedFaceKey = await deriveFaceKey(storedQuantized, blob.pub);
    return { keys, faceKey: resolvedFaceKey, attemptState: await readAttemptState(blob, resolvedFaceKey) };
  }

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
