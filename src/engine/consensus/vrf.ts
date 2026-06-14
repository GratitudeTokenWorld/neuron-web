import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes, concatBytes, type Hex } from '../core/hash.js';

/**
 * ECVRF-P256-SHA256-TAI — a Verifiable Random Function over NIST P-256
 * (RFC 9381, ciphersuite suite_string = 0x01, try-and-increment hash-to-curve).
 *
 * A VRF lets a key holder produce, for any input `alpha`, a pseudorandom output
 * `beta` plus a proof `pi` that ANYONE can check against the public key — without
 * the secret. Two properties make it the no-SPOF basis for committee sortition:
 *
 *   - **Uniqueness**: for a given (pubKey, alpha) there is exactly one valid beta,
 *     so a validator cannot grind its own committee membership.
 *   - **Pseudorandomness**: beta is unpredictable to anyone without the secret
 *     until pi is revealed, so no one can predict a future committee either.
 *
 * Each account's existing P-256 identity key (see {@link ../core/keys}) doubles as
 * its VRF key — no separate keypair. Built only on the already-trusted
 * `@noble/curves` P-256 primitives + SHA-256; validated against the RFC 9381
 * Appendix B.1 P-256-SHA256-TAI test vectors in `vrf.test.ts`.
 */

const Point = p256.Point;
type PointT = InstanceType<typeof Point>;
const N = p256.CURVE.n; // group order q
const PTLEN = 33; // compressed point length (point_to_string)
const CLEN = 16; // challenge length (half the field)
const QLEN = 32; // scalar length in octets (qlen / 8)

const SUITE = 0x01;
const ONE = 0x01;
const ZERO = 0x00;

// ---- small byte/scalar helpers -------------------------------------------------

function bytesToBigInt(b: Uint8Array): bigint {
  let x = 0n;
  for (const byte of b) x = (x << 8n) | BigInt(byte);
  return x;
}

function bigIntToBytes(x: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function mod(x: bigint, m: bigint): bigint {
  const r = x % m;
  return r < 0n ? r + m : r;
}

// ---- point (de)serialisation ---------------------------------------------------

/** point_to_string: SEC1 compressed encoding (33 bytes). */
function pointToBytes(p: PointT): Uint8Array {
  return p.toBytes(true);
}

/** string_to_point: decode a compressed point; null on any invalid/off-curve input. */
function bytesToPoint(b: Uint8Array): PointT | null {
  try {
    return Point.fromHex(bytesToHex(b));
  } catch {
    return null;
  }
}

/**
 * Public-scalar multiply (scalars c, s in verification are public, not secret):
 * reduces mod N and returns the identity for a zero scalar (which `multiply`
 * would otherwise reject).
 */
function mul(p: PointT, scalar: bigint): PointT {
  const k = mod(scalar, N);
  if (k === 0n) return Point.ZERO;
  return p.multiplyUnsafe(k);
}

// ---- RFC 9381 §5.4.1.1 — ECVRF_encode_to_curve_try_and_increment --------------

/**
 * Hash `alpha` to a curve point deterministically (try-and-increment). The salt is
 * the encoded public key, binding H to the verifier's key as the spec requires.
 */
function encodeToCurveTAI(pkBytes: Uint8Array, alpha: Uint8Array): PointT {
  for (let ctr = 0; ctr <= 0xff; ctr++) {
    const hashStr = sha256(
      concatBytes(new Uint8Array([SUITE, ONE]), pkBytes, alpha, new Uint8Array([ctr]), new Uint8Array([ZERO])),
    );
    // arbitrary_string_to_point: prepend 0x02 (even-y compressed prefix) and decode.
    const h = bytesToPoint(concatBytes(new Uint8Array([0x02]), hashStr));
    if (h && !h.is0()) return h;
  }
  // 256 consecutive misses is cryptographically impossible for SHA-256.
  throw new Error('ECVRF encode_to_curve: exhausted counter');
}

// ---- RFC 6979 §3.2 — deterministic nonce (per RFC 9381 §5.4.2.1) ---------------

function bits2int(b: Uint8Array): bigint {
  // qlen (256) == 8*len(b) (256) for P-256, so no truncation is needed.
  return bytesToBigInt(b);
}

function bits2octets(b: Uint8Array): Uint8Array {
  return bigIntToBytes(mod(bits2int(b), N), QLEN);
}

function nonceRFC6979(x: bigint, hString: Uint8Array): bigint {
  const h1 = sha256(hString);
  const xOct = bigIntToBytes(x, QLEN);
  const hOct = bits2octets(h1);

  // Typed loosely (ArrayBufferLike) so reassignment from hmac() — whose return
  // generic differs from a freshly-allocated Uint8Array — typechecks cleanly.
  let V: Uint8Array<ArrayBufferLike> = new Uint8Array(32).fill(0x01);
  let K: Uint8Array<ArrayBufferLike> = new Uint8Array(32).fill(0x00);
  K = hmac(sha256, K, concatBytes(V, new Uint8Array([0x00]), xOct, hOct));
  V = hmac(sha256, K, V);
  K = hmac(sha256, K, concatBytes(V, new Uint8Array([0x01]), xOct, hOct));
  V = hmac(sha256, K, V);

  for (;;) {
    V = hmac(sha256, K, V); // T = V (QLEN bytes == one HMAC block covers qlen bits)
    const k = bits2int(V);
    if (k >= 1n && k < N) return k;
    K = hmac(sha256, K, concatBytes(V, new Uint8Array([0x00])));
    V = hmac(sha256, K, V);
  }
}

// ---- RFC 9381 §5.4.3 — ECVRF_challenge_generation ------------------------------

function challengeGeneration(points: PointT[]): bigint {
  const parts: Uint8Array[] = [new Uint8Array([SUITE, 0x02])];
  for (const p of points) parts.push(pointToBytes(p));
  parts.push(new Uint8Array([ZERO]));
  const cString = sha256(concatBytes(...parts));
  return bytesToBigInt(cString.slice(0, CLEN));
}

// ---- RFC 9381 §5.2 — proof_to_hash --------------------------------------------

function proofToHash(gamma: PointT): Uint8Array {
  // cofactor = 1 for P-256, so cofactor*Gamma = Gamma.
  return sha256(concatBytes(new Uint8Array([SUITE, 0x03]), pointToBytes(gamma), new Uint8Array([ZERO])));
}

// ---- public API ----------------------------------------------------------------

export interface VrfProof {
  /** The proof pi (Gamma‖c‖s), hex — 81 bytes. */
  pi: Hex;
  /** The VRF output beta, hex — 32 bytes. Equals {@link vrfProofToHash}(pi). */
  beta: Hex;
}

/**
 * Produce a VRF proof + output for `alpha` under the P-256 secret key `privHex`.
 * Deterministic: the same (key, alpha) always yields the same (pi, beta).
 */
export function vrfProve(privHex: Hex, alpha: Uint8Array): VrfProof {
  const x = mod(bytesToBigInt(hexToBytes(privHex)), N);
  const Y = Point.BASE.multiply(x);
  const pkBytes = pointToBytes(Y);

  const H = encodeToCurveTAI(pkBytes, alpha);
  const hBytes = pointToBytes(H);
  const gamma = H.multiply(x);

  const k = nonceRFC6979(x, hBytes);
  const c = challengeGeneration([Y, H, gamma, Point.BASE.multiply(k), H.multiply(k)]);
  const s = mod(k + c * x, N);

  const pi = concatBytes(pointToBytes(gamma), bigIntToBytes(c, CLEN), bigIntToBytes(s, QLEN));
  return { pi: bytesToHex(pi), beta: bytesToHex(proofToHash(gamma)) };
}

interface DecodedProof {
  gamma: PointT;
  c: bigint;
  s: bigint;
}

/** ECVRF_decode_proof: split + validate pi; null on malformed input. */
function decodeProof(pi: Uint8Array): DecodedProof | null {
  if (pi.length !== PTLEN + CLEN + QLEN) return null;
  const gamma = bytesToPoint(pi.slice(0, PTLEN));
  if (!gamma) return null;
  const c = bytesToBigInt(pi.slice(PTLEN, PTLEN + CLEN));
  const s = bytesToBigInt(pi.slice(PTLEN + CLEN));
  if (s >= N) return null;
  return { gamma, c, s };
}

/**
 * Verify a VRF proof `pi` for `alpha` under public key `pubHex` (compressed P-256).
 * Returns the VRF output beta (hex) iff valid, else null. Never throws.
 */
export function vrfVerify(pubHex: Hex, alpha: Uint8Array, piHex: Hex): Hex | null {
  let Y: PointT | null;
  try {
    Y = bytesToPoint(hexToBytes(pubHex));
  } catch {
    return null;
  }
  if (!Y || Y.is0()) return null;

  let dec: DecodedProof | null;
  try {
    dec = decodeProof(hexToBytes(piHex));
  } catch {
    return null;
  }
  if (!dec) return null;
  const { gamma, c, s } = dec;

  const H = encodeToCurveTAI(pointToBytes(Y), alpha);
  // U = s*B - c*Y ; V = s*H - c*Gamma
  const U = mul(Point.BASE, s).add(mul(Y, c).negate());
  const V = mul(H, s).add(mul(gamma, c).negate());
  const cPrime = challengeGeneration([Y, H, gamma, U, V]);

  if (cPrime !== c) return null;
  return bytesToHex(proofToHash(gamma));
}

/** Recompute beta directly from a proof (no verification). Null on malformed pi. */
export function vrfProofToHash(piHex: Hex): Hex | null {
  let dec: DecodedProof | null;
  try {
    dec = decodeProof(hexToBytes(piHex));
  } catch {
    return null;
  }
  if (!dec) return null;
  return bytesToHex(proofToHash(dec.gamma));
}
