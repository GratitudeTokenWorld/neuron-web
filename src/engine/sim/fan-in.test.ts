import { describe, it, expect } from 'vitest';
import { inboundCost, windowedStatCost, followerCountKnowability } from './fan-in.js';
import { buildSenderChain, wireBytes } from './counterparty.js';

/**
 * Hypotheses about an account with a billion followers, each with the result
 * that would disprove it (PRINCIPLES.md → 5). These tests ARE the falsifiers.
 */

/** MEASURED — canonical wire bytes of a real signed block, as elsewhere in sim/. */
const BLOCK_BYTES = Math.ceil(
  (() => {
    const chain = buildSenderChain(64, 32);
    return chain.blocks.slice(1).reduce((s, b) => s + wireBytes(b), 0) / (chain.blocks.length - 1);
  })(),
);

const BASE = {
  messagesPerSender: 1,
  days: 30,
  // ASSUMED: 200 inbound items a day is far past what a human reads, and is
  // the number the receiver picks. Sensitivity is exercised below.
  claimBudgetPerDay: 200,
  blockBytes: BLOCK_BYTES,
  indexCapPerRecipient: 1_000,
  indexSlotsPerSender: 4,
};

describe('H-F1: inbound cost is set by the receiver, not by the audience', () => {
  it('costs the receiver the same at a million senders and at a billion', () => {
    const big = inboundCost({ ...BASE, senders: 1_000_000 });
    const huge = inboundCost({ ...BASE, senders: 1_000_000_000 });

    // The falsifier: if the receiver's own chain grew with the audience, the
    // pull model would be broken and this assertion would fail.
    expect(huge.receiverBlocksUnderPolicy).toBe(big.receiverBlocksUnderPolicy);
    expect(huge.receiverBlocksUnderPolicy).toBe(6_000); // 200/day × 30 days

    // And the difference is enormous, which is the point of having a policy.
    expect(huge.receiverBlocksIfClaimAll).toBe(1_000_000_000);
    expect(huge.receiverBlocksIfClaimAll / huge.receiverBlocksUnderPolicy).toBeGreaterThan(160_000);
  });

  it('is a CEILING, not a floor — a quiet account pays for what it actually got', () => {
    // The first draft of the test above asserted that a thousand senders and a
    // billion cost the same, and it failed, correctly: the cost is
    // min(demand, budget). Writing the throttle as a flat charge would have
    // made every small account pay a celebrity's price.
    const quiet = inboundCost({ ...BASE, senders: 1_000 });
    expect(quiet.receiverBlocksUnderPolicy).toBe(1_000);
    expect(quiet.unclaimed).toBe(0);
  });

  it('leaves the unclaimed remainder costing the receiver nothing', () => {
    const c = inboundCost({ ...BASE, senders: 1_000_000_000 });
    // Unclaimed sends stay on the SENDER's chain, where they were already
    // written and already paid for. Nothing accrues to the receiver until it
    // chooses to claim — which is what makes a queue different from a list.
    expect(c.unclaimed).toBe(1_000_000_000 - 6_000);
    expect(c.receiverBytesUnderPolicy).toBe(6_000 * BLOCK_BYTES);
  });

  it('is sensitive to the budget and to nothing else', () => {
    // Doubling the throttle doubles the cost; multiplying the audience by 1e6
    // changes it by zero. That asymmetry is the whole claim.
    const a = inboundCost({ ...BASE, senders: 1_000_000, claimBudgetPerDay: 200 });
    const b = inboundCost({ ...BASE, senders: 1_000_000, claimBudgetPerDay: 400 });
    const c = inboundCost({ ...BASE, senders: 1_000_000_000_000, claimBudgetPerDay: 200 });
    expect(b.receiverBlocksUnderPolicy).toBe(a.receiverBlocksUnderPolicy * 2);
    expect(c.receiverBlocksUnderPolicy).toBe(a.receiverBlocksUnderPolicy);
  });
});

describe('H-F2: the archive index is the O(senders) structure, and a cap moves the cost to identities', () => {
  it('is unbounded without a cap', () => {
    const c = inboundCost({ ...BASE, senders: 1_000_000_000 });
    // This is the honest finding: the client is fine, the ARCHIVE is not.
    expect(c.relayIndexUncapped).toBe(1_000_000_000);
    expect(c.relayIndexCapped).toBe(1_000);
  });

  it('prices index eviction in identities, not in messages', () => {
    // Without a per-sender share, one account's dust fills the index and every
    // honest pending send is pushed out — the cap becomes the attack.
    const unfair = inboundCost({ ...BASE, senders: 1, indexSlotsPerSender: 1_000 });
    expect(unfair.identitiesToFloodIndex).toBe(1);

    // With it, flooding costs distinct identities, and an identity costs a
    // nullifier — i.e. a human. That is the only Sybil price this system has.
    const fair = inboundCost({ ...BASE, senders: 1_000_000 });
    expect(fair.identitiesToFloodIndex).toBe(250);

    // Sensitivity: the attacker's price is linear in the cap and inverse in the
    // per-sender share, so both are real security parameters and neither is a
    // performance knob to be tuned casually.
    const wider = inboundCost({ ...BASE, senders: 1_000_000, indexCapPerRecipient: 10_000 });
    expect(wider.identitiesToFloodIndex).toBe(2_500);
  });
});

describe('H-F3: an exact follower count is undefined, not merely expensive', () => {
  it('has no holder anywhere in the network', () => {
    const k = followerCountKnowability({ users: 10_000_000_000, numShards: 4096 });
    // Falsifier: if any party could be named that holds the input, this is 1+
    // and the number becomes a cost question instead of a knowability one.
    expect(k.exactCountHolders).toBe(0);
    // The coarsest observable is shard interest, which covers ~2.4M accounts.
    expect(k.accountsPerShard).toBeGreaterThan(2_000_000);
  });

  it('replaces it with a windowed stat bounded by the throttle', () => {
    const stat = windowedStatCost({ admittedPerDay: 200, windowDays: 30, entryBytes: 40 });
    expect(stat.entries).toBe(6_000);
    expect(stat.bytes).toBe(240_000);

    // The property that matters: the audience does not appear in the formula.
    // A billion followers cannot enlarge this, because a billion followers
    // cannot get more than `admittedPerDay` interactions admitted.
    const same = windowedStatCost({ admittedPerDay: 200, windowDays: 30, entryBytes: 40 });
    expect(same.entries).toBe(stat.entries);
  });
});
