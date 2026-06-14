import { describe, it, expect } from 'vitest';
import { bytesToHex, type Hex } from '../core/hash.js';
import { publicKeyFromPrivate } from '../core/keys.js';
import {
  CommitteeFinality,
  castCommitteeVote,
  seatQuorum,
  type WeightSource,
  type CommitteeVote,
} from './finality.js';

/** Deterministic validator key from a small scalar (reproducible committees). */
function keyFromScalar(i: number): { priv: Hex; pub: Hex } {
  const bytes = new Uint8Array(32);
  let x = BigInt(i + 1);
  for (let j = 31; j >= 0; j--) {
    bytes[j] = Number(x & 0xffn);
    x >>= 8n;
  }
  const priv = bytesToHex(bytes);
  return { priv, pub: publicKeyFromPrivate(priv) };
}

const SEED = 'seedX';
const EPOCH = 5;
const N = 400;
const W = 100;
const TOTAL = N * W;
const COMMITTEE = 10; // ⇒ quorum 7 seats; ~11 deterministic seats available

const weights: WeightSource = { weightOf: () => W, totalWeight: () => TOTAL };
const seedFor = (epoch: number): string | undefined => (epoch === EPOCH ? SEED : undefined);

function newFinality() {
  return new CommitteeFinality({ committeeSize: COMMITTEE }, weights, seedFor);
}

/** All committee votes (non-null draws) for a block, in validator order. */
function committeeVotesFor(block: { hash: Hex; shard: number }): CommitteeVote[] {
  const out: CommitteeVote[] = [];
  for (let i = 0; i < N; i++) {
    const { priv, pub } = keyFromScalar(i);
    const v = castCommitteeVote(priv, pub, block, SEED, EPOCH, W, TOTAL, COMMITTEE);
    if (v) out.push(v);
  }
  return out;
}

describe('committee finality', () => {
  const block = { hash: 'ab'.repeat(32), shard: 3, accountId: 'cc'.repeat(33).slice(0, 66), previousHash: 'dd'.repeat(32) };

  it('finalizes a block once seat votes reach the absolute quorum', () => {
    const f = newFinality();
    f.registerBlock(block);
    const votes = committeeVotesFor(block);
    const quorum = seatQuorum({ committeeSize: COMMITTEE });
    expect(votes.reduce((s, v) => s + v.seats, 0)).toBeGreaterThanOrEqual(quorum);

    let cumulative = 0;
    let finalized = false;
    for (const v of votes) {
      expect(f.status(block.hash)).toBe('pending'); // not final until quorum
      const r = f.applyVote(v);
      expect(r.accepted).toBe(true);
      cumulative += v.seats;
      if (cumulative >= quorum) {
        expect(r.finalized).toBe(block.hash);
        expect(f.status(block.hash)).toBe('final');
        finalized = true;
        break;
      }
      expect(f.status(block.hash)).toBe('pending');
    }
    expect(finalized).toBe(true);
  });

  it('rejects votes with a bad signature, mismatched seats, or unknown block', () => {
    const f = newFinality();
    f.registerBlock(block);
    const v = committeeVotesFor(block)[0]!;

    expect(f.applyVote({ ...v, sig: 'ff'.repeat(64) }).reason).toBe('bad signature');
    expect(f.applyVote({ ...v, seats: v.seats + 5 }).reason).toBe('seat count mismatch');
    expect(f.applyVote({ ...v, blockHash: '00'.repeat(32) }).reason).toBe('unknown block');
  });

  it('rejects a sortition proof from the wrong epoch seed', () => {
    const f = newFinality();
    f.registerBlock(block);
    // A properly-signed vote for epoch 6 — but seedFor(6) is undefined here.
    let v6: ReturnType<typeof castCommitteeVote> = null;
    for (let i = 0; i < N && !v6; i++) {
      const { priv, pub } = keyFromScalar(i);
      v6 = castCommitteeVote(priv, pub, { hash: block.hash, shard: block.shard }, SEED, 6, W, TOTAL, COMMITTEE);
    }
    expect(f.applyVote(v6!).reason).toBe('unknown epoch seed');
  });

  it('flags equivocation when a member votes two siblings in one conflict', () => {
    const f = newFinality();
    const a = { ...block, hash: 'a'.repeat(64) };
    const b = { ...block, hash: 'b'.repeat(64) }; // same accountId:previousHash ⇒ same group
    f.registerBlock(a);
    f.registerBlock(b);

    const { priv, pub } = keyFromScalar(findWinner());
    const va = castCommitteeVote(priv, pub, { hash: a.hash, shard: block.shard }, SEED, EPOCH, W, TOTAL, COMMITTEE)!;
    const vb = castCommitteeVote(priv, pub, { hash: b.hash, shard: block.shard }, SEED, EPOCH, W, TOTAL, COMMITTEE)!;

    expect(f.applyVote(va).accepted).toBe(true);
    const r = f.applyVote(vb);
    expect(r.accepted).toBe(false);
    expect(r.equivocation).toEqual({ voterId: pub, blockA: a.hash, blockB: b.hash });
    expect(f.equivocations()).toHaveLength(1);
  });

  it('a duplicate vote (same voter, same block) is ignored, not double-counted', () => {
    const f = newFinality();
    f.registerBlock(block);
    const v = committeeVotesFor(block)[0]!;
    expect(f.applyVote(v).accepted).toBe(true);
    const seatsAfterFirst = f.seatsFor(block.hash);
    expect(f.applyVote(v).reason).toBe('duplicate vote');
    expect(f.seatsFor(block.hash)).toBe(seatsAfterFirst);
  });

  it('prunes a stalled undecided group past the retention window', () => {
    const f = newFinality();
    f.registerBlock(block);
    const v = committeeVotesFor(block)[0]!; // one vote, below quorum ⇒ stays pending
    f.applyVote(v);
    expect(f.status(block.hash)).toBe('pending');

    // Still within the window: kept.
    expect(f.pruneStale(EPOCH + 2)).toBe(0);
    expect(f.status(block.hash)).toBe('pending');

    // Past the window: the stalled group is dropped (governance falls to the
    // optimistic/challenge-window path, not committee finality).
    expect(f.pruneStale(EPOCH + 3)).toBe(1);
    expect(f.status(block.hash)).toBe('unknown');
    expect(f.applyVote(v).reason).toBe('unknown block');
  });

  it('keeps a finalized group decided after pruning, and frees its vote detail', () => {
    const f = newFinality();
    f.registerBlock(block);
    let finalized = false;
    for (const v of committeeVotesFor(block)) {
      if (f.applyVote(v).finalized) { finalized = true; break; }
    }
    expect(finalized).toBe(true);
    expect(f.seatsFor(block.hash)).toBe(0); // per-voter tally detail freed on finalize
    expect(f.pruneStale(EPOCH + 100)).toBe(0); // decided groups are not pruned
    expect(f.status(block.hash)).toBe('final'); // status survives
  });

  it('on a fork, the block that reaches quorum wins and its sibling is rejected', () => {
    const f = newFinality();
    const a = { ...block, hash: 'a'.repeat(64) };
    const b = { ...block, hash: 'b'.repeat(64) };
    f.registerBlock(a);
    f.registerBlock(b);

    // The whole committee backs block A.
    let finalized = false;
    for (const v of committeeVotesFor({ hash: a.hash, shard: block.shard })) {
      const r = f.applyVote(v);
      if (r.finalized) {
        finalized = true;
        expect(r.rejected).toContain(b.hash);
        break;
      }
    }
    expect(finalized).toBe(true);
    expect(f.status(a.hash)).toBe('final');
    expect(f.status(b.hash)).toBe('rejected');
  });
});

/** Index of the first validator that wins ≥1 seat for the test draw. */
function findWinner(): number {
  for (let i = 0; i < N; i++) {
    const { priv, pub } = keyFromScalar(i);
    const v = castCommitteeVote(priv, pub, { hash: 'ab'.repeat(32), shard: 3 }, SEED, EPOCH, W, TOTAL, COMMITTEE);
    if (v) return i;
  }
  throw new Error('no committee winner in test set');
}
