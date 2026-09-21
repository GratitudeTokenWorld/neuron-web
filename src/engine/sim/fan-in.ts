/**
 * What a VERY popular account costs — inbound messages and aggregate stats.
 *
 * `scenario.ts` measures the fan-OUT direction (one writer, many readers), and
 * ARCHITECTURE.md → *Fan-IN* establishes the rule that identical answers absorb
 * fan-in. Neither covers the case Lucian raised: **an account with a billion
 * followers**.
 *
 * Follows themselves are free, and that is measured elsewhere by construction:
 * `Subscription.followed` is a local Set, never published, so a popular account
 * stores nothing per follower and its chain does not grow when someone follows
 * it. What is NOT free is everything followers then DO:
 *
 *   1. **Inbound messages** — replies, mentions, transfers. Each is different,
 *      so the "identical answers absorb fan-in" trick does not apply: no cache
 *      can serve a million distinct messages as one.
 *   2. **Aggregate stats** — a follower count is `O(followers)` to compute, and
 *      is in fact not computable at all (see `followerCountKnowability`).
 *
 * This module measures both against the ONE lever that bounds them: a receiver
 * admission rate — a throttle the receiver sets, raised for counterparties it
 * has reason to trust. Pure arithmetic over supplied constants, like
 * `projection.ts` and `storage-accounting.ts`, so its inputs stay visible.
 */

export interface InboundAssumptions {
  /** Distinct accounts sending to this one over the period. */
  senders: number;
  /** Messages each sender sends over the period. */
  messagesPerSender: number;
  /** Days modelled. */
  days: number;
  /**
   * Inbound items the receiver will ACCEPT onto its own chain per day.
   * This is the throttle. It is a number the receiver chooses, not one the
   * senders impose — which is the entire point.
   */
  claimBudgetPerDay: number;
  /** MEASURED canonical bytes of one engine block, supplied by the caller. */
  blockBytes: number;
  /** Pending-send index slots an archive keeps per recipient. */
  indexCapPerRecipient: number;
  /**
   * Slots any ONE sender may occupy in that index. Without this the cap is a
   * weapon: `indexCapPerRecipient` dust messages from one account evict every
   * real one. With it, evicting the index costs distinct IDENTITIES.
   */
  indexSlotsPerSender: number;
}

export interface InboundCost {
  /** Messages aimed at the receiver over the period. */
  messagesTotal: number;
  /** Blocks on the RECEIVER's chain if it claims everything sent to it. */
  receiverBlocksIfClaimAll: number;
  /** Blocks on the receiver's chain under its own admission rate. */
  receiverBlocksUnderPolicy: number;
  /** Bytes those blocks add to the receiver's chain. */
  receiverBytesUnderPolicy: number;
  /** Messages left unclaimed — which cost the receiver nothing at all. */
  unclaimed: number;
  /** Index entries an archive holds for this recipient, uncapped. */
  relayIndexUncapped: number;
  /** …and with the per-recipient cap applied. */
  relayIndexCapped: number;
  /**
   * Distinct identities an attacker must control to fill the index and push
   * every honest pending send out of it. Each identity costs a nullifier, i.e.
   * a human, which is the only Sybil price this system charges.
   */
  identitiesToFloodIndex: number;
}

export function inboundCost(a: InboundAssumptions): InboundCost {
  const messagesTotal = a.senders * a.messagesPerSender;
  const budget = a.claimBudgetPerDay * a.days;
  const claimed = Math.min(messagesTotal, budget);
  return {
    messagesTotal,
    receiverBlocksIfClaimAll: messagesTotal,
    receiverBlocksUnderPolicy: claimed,
    receiverBytesUnderPolicy: claimed * a.blockBytes,
    unclaimed: messagesTotal - claimed,
    relayIndexUncapped: messagesTotal,
    relayIndexCapped: Math.min(messagesTotal, a.indexCapPerRecipient),
    identitiesToFloodIndex: Math.ceil(a.indexCapPerRecipient / a.indexSlotsPerSender),
  };
}

/**
 * The cost of an aggregate stat computed over a WINDOW rather than over all
 * history — "N accounts interacted with this one in the last 30 days" instead
 * of "N followers".
 *
 * The property being measured: the result is bounded by the throttle and the
 * window, and by nothing the audience controls. A billion followers do not make
 * this number larger, because a billion followers cannot get a billion
 * interactions admitted.
 */
export function windowedStatCost(args: {
  admittedPerDay: number;
  windowDays: number;
  /** Bytes an archive keeps per counted interaction (id + timestamp). */
  entryBytes: number;
}): { entries: number; bytes: number } {
  const entries = args.admittedPerDay * args.windowDays;
  return { entries, bytes: entries * args.entryBytes };
}

/**
 * Whether an exact follower count is knowable at all.
 *
 * This is not a cost question. A follow is local state (`Subscription.follow`
 * writes to an in-memory Set and publishes nothing), so **no party anywhere
 * holds the input** to the sum. The number is not expensive; it is undefined.
 *
 * The only observable trace is shard subscription, and a shard is a partition
 * of ~`accounts / numShards` accounts — at the 10B target, ~2.4M per shard.
 * Observing it tells you someone in the mesh is interested in one of 2.4M
 * accounts, which is not a follower count. (That coarseness is a privacy
 * property, not only a measurement limit.)
 *
 * Returns the resolution of the coarsest possible observation, so the claim is
 * a number rather than an assertion.
 */
export function followerCountKnowability(args: {
  users: number;
  numShards: number;
}): { accountsPerShard: number; exactCountHolders: number } {
  return {
    accountsPerShard: Math.ceil(args.users / args.numShards),
    // Nobody. Publishing follows is what would change this, and that is the
    // O(N) design the project has already removed three times.
    exactCountHolders: 0,
  };
}
