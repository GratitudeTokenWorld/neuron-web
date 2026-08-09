import { describe, it, expect } from 'vitest';
import {
  buildSenderChain,
  buildPacket,
  verifyPacket,
  measureCounterparty,
  wireBytes,
} from './counterparty.js';

const POLICY = { min: 1, requiredTypes: ['personhood'] as const };

describe('G2 — counterparty verification by proof, not chain replication', () => {
  it('a recipient verifies a payment from the compact packet alone', () => {
    const chain = buildSenderChain(64, 32, 'cafe01');
    const packet = buildPacket(chain, 32);
    expect(verifyPacket(packet, 'cafe01', POLICY)).toEqual({ ok: true });
  });

  it('packet cost grows O(log n) while chain replication grows O(n)', () => {
    const lengths = [16, 64, 256, 1024];
    const costs = measureCounterparty(lengths);

    // eslint-disable-next-line no-console
    console.log('\n  chain len   full-chain KB   packet KB   proof hashes   saving');
    for (const c of costs) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${String(c.chainLength).padEnd(11)} ${(c.fullChainBytes / 1024).toFixed(1).padEnd(15)} ${(c.packetBytes / 1024).toFixed(2).padEnd(11)} ${String(c.proofHashes).padEnd(14)} ${(c.fullChainBytes / c.packetBytes).toFixed(1)}x`,
      );
    }

    const first = costs[0]!;
    const last = costs[costs.length - 1]!;
    const chainGrowth = last.fullChainBytes / first.fullChainBytes;
    const packetGrowth = last.packetBytes / first.packetBytes;

    // Chain replication grew ~linearly with the 64x length sweep …
    expect(chainGrowth).toBeGreaterThan(32);
    // … the packet grew only logarithmically (2 audit paths of ~log2(n) hashes each).
    expect(packetGrowth).toBeLessThan(3);
    for (const c of costs) {
      expect(c.proofHashes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(c.chainLength)));
    }
  });

  it('rejects tampering: wrong recipient, altered amount, foreign proof', () => {
    const chain = buildSenderChain(32, 16, 'cafe01');
    const packet = buildPacket(chain, 16);

    // Not addressed to us.
    expect(verifyPacket(packet, 'beef02', POLICY).ok).toBe(false);

    // Amount altered after signing — content hash breaks.
    const forgedAmount = {
      ...packet,
      sendBlock: { ...packet.sendBlock, amount: 999_999n },
    };
    expect(verifyPacket(forgedAmount, 'cafe01', POLICY).ok).toBe(false);

    // A send block swapped in from a DIFFERENT chain (valid in isolation, but not
    // committed by this head's accumulator root) — the inclusion proof catches it.
    const other = buildSenderChain(32, 16, 'cafe01');
    const swapped = {
      ...packet,
      sendBlock: other.blocks[16]!,
      sendInclusionProof: other.accumulator.proofHex(16),
    };
    const swappedResult = verifyPacket(swapped, 'cafe01', POLICY);
    expect(swappedResult.ok).toBe(false);
    expect(swappedResult.reason).toContain('different account');

    // Truncated proof.
    const truncated = { ...packet, sendInclusionProof: packet.sendInclusionProof.slice(1) };
    expect(verifyPacket(truncated, 'cafe01', POLICY).ok).toBe(false);
  });

  it('steady state: recipient keeps O(1) per counterparty, not the chain', () => {
    // What the recipient must RETAIN after claiming: its own receive block. The
    // packet itself is discardable post-verification (re-servable by any holder);
    // even keeping it is O(log n). Compare both against the chain it replaced.
    const chain = buildSenderChain(1024, 512, 'cafe01');
    const packet = buildPacket(chain, 512);
    const chainBytes = chain.blocks.reduce((sum, b) => sum + wireBytes(b), 0);
    expect(wireBytes(packet)).toBeLessThan(chainBytes / 50);
  });
});
