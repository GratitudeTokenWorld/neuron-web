import { describe, it, expect } from 'vitest';
import { utf8ToBytes, hexToBytes, bytesToHex } from '../core/hash.js';
import { publicKeyFromPrivate } from '../core/keys.js';
import { vrfProve, vrfVerify, vrfProofToHash } from './vrf.js';

/**
 * RFC 9381 Appendix B.1 — ECVRF-P256-SHA256-TAI official test vectors.
 *
 * These are the gold standard: round-trip self-consistency can pass a
 * wrong-but-consistent hash-to-curve, but matching the RFC's exact pi/beta bytes
 * proves the encode_to_curve, RFC 6979 nonce, challenge, and proof_to_hash steps
 * are all spec-correct.
 */
const VECTORS = [
  {
    name: 'Example 10 (alpha="sample")',
    sk: 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721',
    pk: '0360fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6',
    alpha: '73616d706c65',
    pi: '035b5c726e8c0e2c488a107c600578ee75cb702343c153cb1eb8dec77f4b5071b4a53f0a46f018bc2c56e58d383f2305e0975972c26feea0eb122fe7893c15af376b33edf7de17c6ea056d4d82de6bc02f',
    beta: 'a3ad7b0ef73d8fc6655053ea22f9bede8c743f08bbed3d38821f0e16474b505e',
  },
  {
    name: 'Example 11 (alpha="test")',
    sk: 'c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721',
    pk: '0360fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6',
    alpha: '74657374',
    pi: '034dac60aba508ba0c01aa9be80377ebd7562c4a52d74722e0abae7dc3080ddb56c19e067b15a8a8174905b13617804534214f935b94c2287f797e393eb0816969d864f37625b443f30f1a5a33f2b3c854',
    beta: 'a284f94ceec2ff4b3794629da7cbafa49121972671b466cab4ce170aa365f26d',
  },
  {
    name: 'Example 12 (ANSI X9.62 key)',
    sk: '2ca1411a41b17b24cc8c3b089cfd033f1920202a6c0de8abb97df1498d50d2c8',
    pk: '03596375e6ce57e0f20294fc46bdfcfd19a39f8161b58695b3ec5b3d16427c274d',
    alpha:
      '4578616d706c65207573696e67204543445341206b65792066726f6d20417070656e646978204c2e342e32206f6620414e53492e58392d36322d32303035',
    pi: '03d03398bf53aa23831d7d1b2937e005fb0062cbefa06796579f2a1fc7e7b8c667d091c00b0f5c3619d10ecea44363b5a599cadc5b2957e223fec62e81f7b4825fc799a771a3d7334b9186bdbee87316b1',
    beta: '90871e06da5caa39a3c61578ebb844de8635e27ac0b13e829997d0d95dd98c19',
  },
];

describe('ECVRF-P256-SHA256-TAI (RFC 9381 §B.1)', () => {
  for (const v of VECTORS) {
    describe(v.name, () => {
      const alpha = hexToBytes(v.alpha);

      it('derives the published public key from SK', () => {
        expect(publicKeyFromPrivate(v.sk)).toBe(v.pk);
      });

      it('vrfProve produces the exact RFC pi and beta', () => {
        const { pi, beta } = vrfProve(v.sk, alpha);
        expect(pi).toBe(v.pi);
        expect(beta).toBe(v.beta);
      });

      it('vrfVerify accepts the RFC proof and returns beta', () => {
        expect(vrfVerify(v.pk, alpha, v.pi)).toBe(v.beta);
      });

      it('vrfProofToHash recomputes beta from pi alone', () => {
        expect(vrfProofToHash(v.pi)).toBe(v.beta);
      });
    });
  }

  it('round-trips for a fresh key + arbitrary alpha', () => {
    const sk = 'a'.repeat(63) + '1';
    const pk = publicKeyFromPrivate(sk);
    const alpha = utf8ToBytes('neuron committee epoch 42 shard 7');
    const { pi, beta } = vrfProve(sk, alpha);
    expect(vrfVerify(pk, alpha, pi)).toBe(beta);
  });

  it('is deterministic — same (key, alpha) yields the same proof', () => {
    const sk = VECTORS[0]!.sk;
    const alpha = hexToBytes(VECTORS[0]!.alpha);
    expect(vrfProve(sk, alpha)).toEqual(vrfProve(sk, alpha));
  });

  it('rejects a proof under the wrong public key', () => {
    const v = VECTORS[0]!;
    const otherPk = publicKeyFromPrivate('b'.repeat(63) + '2');
    expect(vrfVerify(otherPk, hexToBytes(v.alpha), v.pi)).toBeNull();
  });

  it('rejects a proof for the wrong alpha', () => {
    const v = VECTORS[0]!;
    expect(vrfVerify(v.pk, utf8ToBytes('not sample'), v.pi)).toBeNull();
  });

  it('rejects a tampered proof (flipped byte in s)', () => {
    const v = VECTORS[0]!;
    const bytes = hexToBytes(v.pi);
    const last = bytes.length - 1;
    bytes[last] = bytes[last]! ^ 0x01;
    expect(vrfVerify(v.pk, hexToBytes(v.alpha), bytesToHex(bytes))).toBeNull();
  });

  it('rejects a tampered proof (flipped byte in Gamma)', () => {
    const v = VECTORS[0]!;
    const bytes = hexToBytes(v.pi);
    bytes[1] = bytes[1]! ^ 0x01;
    expect(vrfVerify(v.pk, hexToBytes(v.alpha), bytesToHex(bytes))).toBeNull();
  });

  it('rejects malformed proofs (wrong length, garbage) without throwing', () => {
    const v = VECTORS[0]!;
    expect(vrfVerify(v.pk, hexToBytes(v.alpha), 'deadbeef')).toBeNull();
    expect(vrfVerify(v.pk, hexToBytes(v.alpha), v.pi.slice(0, -2))).toBeNull();
    expect(vrfProofToHash('not-hex-at-all')).toBeNull();
  });
});
