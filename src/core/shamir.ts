/**
 * Shamir secret sharing over GF(256), fixed at threshold k=2.
 *
 * Used to split the pinVersion=3 recovery share (see face-store.ts) across the
 * attester relays so that NO single relay holds the third key factor: one share
 * is information-theoretically independent of the secret (for every candidate
 * secret there is exactly one polynomial producing the observed share), so a
 * rogue or compromised relay learns nothing, and an attacker must pass TWO
 * independent face-gated, backoff-limited release endpoints instead of one.
 *
 * k is fixed at 2 deliberately:
 *  - it is the smallest threshold that denies a single custodian, and
 *  - with the dev topology of three attesters (two cloud relays + the local
 *    dev relay) it keeps one-relay-down recovery working (any 2 of 3), which
 *    TESTPLAN T5 requires. A general-k implementation would be more code to
 *    review in a security-critical path for no present benefit.
 *
 * Per byte: pick random r, share for x-coordinate x is  y = s ⊕ mul(r, x).
 * Reconstruction from (x1,y1),(x2,y2) is Lagrange at 0:
 *   s = y1·x2/(x1⊕x2) ⊕ y2·x1/(x1⊕x2)
 * (in GF(256) addition IS xor, and x1⊕x2 ≠ 0 whenever x1 ≠ x2).
 *
 * x = 0 is reserved: it would make the share equal the secret. Callers use
 * x ≥ 1; the wire format's legacy "full secret" records are represented as
 * x = 0 upstream (recovery-share.ts) and never touch this module.
 */

/** GF(256) log/exp tables, generator 3, reduction polynomial 0x11b (AES field). */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by the generator 3: x·3 = x·2 ⊕ x, with reduction
    x = (x << 1) ^ x;
    if (x & 0x100) x ^= 0x11b;
  }
  // Duplicate so mul() can index exp[la+lb] without a mod 255.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function div(a: number, b: number): number {
  if (b === 0) throw new Error('GF(256) division by zero');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export interface ShamirShare {
  /** x-coordinate, 1..255 — identifies the share, safe to store beside it. */
  x: number;
  /** y-values, same length as the secret. */
  data: Uint8Array;
}

/**
 * Split `secret` into `n` shares (x = 1..n), any 2 of which reconstruct it.
 * Fresh randomness per byte; callers must ship each share to a DIFFERENT
 * custodian — two shares in one place defeat the whole construction.
 */
export function shamirSplit(secret: Uint8Array, n: number): ShamirShare[] {
  if (n < 2 || n > 255) throw new Error('shamirSplit: n must be 2..255');
  const r = crypto.getRandomValues(new Uint8Array(secret.length));
  const shares: ShamirShare[] = [];
  for (let x = 1; x <= n; x++) {
    const data = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i++) data[i] = secret[i] ^ mul(r[i], x);
    shares.push({ x, data });
  }
  return shares;
}

/** Reconstruct the secret from any two DISTINCT shares of one split. */
export function shamirCombine(a: ShamirShare, b: ShamirShare): Uint8Array {
  if (a.x === b.x) throw new Error('shamirCombine: shares must have distinct x');
  if (a.data.length !== b.data.length) throw new Error('shamirCombine: length mismatch');
  const denom = a.x ^ b.x;
  // Lagrange basis at 0 — constants across all bytes, so hoisted.
  const ca = div(b.x, denom);
  const cb = div(a.x, denom);
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = mul(a.data[i], ca) ^ mul(b.data[i], cb);
  }
  return out;
}
