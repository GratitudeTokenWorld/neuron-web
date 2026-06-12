import { describe, it, expect } from 'vitest';
import { generateKeyPair, sign, verify, publicKeyFromPrivate } from './keys.js';

describe('keys', () => {
  it('signs and verifies a message', () => {
    const k = generateKeyPair();
    const sig = sign('hello world', k.priv);
    expect(verify(sig, 'hello world', k.pub)).toBe(true);
  });

  it('rejects a tampered message', () => {
    const k = generateKeyPair();
    const sig = sign('hello world', k.priv);
    expect(verify(sig, 'hello world!', k.pub)).toBe(false);
  });

  it('rejects a wrong signer', () => {
    const k = generateKeyPair();
    const other = generateKeyPair();
    const sig = sign('hello', k.priv);
    expect(verify(sig, 'hello', other.pub)).toBe(false);
  });

  it('derives the public key deterministically from the private key', () => {
    const k = generateKeyPair();
    expect(publicKeyFromPrivate(k.priv)).toBe(k.pub);
  });

  it('verify returns false (never throws) on malformed input', () => {
    expect(verify('zz', 'x', 'yy')).toBe(false);
  });
});
