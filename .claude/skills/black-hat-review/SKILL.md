---
name: black-hat-review
description: Attack neuron-web the way an adversary would, on the testnet, before mainnet exists — Sybil/identity, reward theft, custody free-riding, relay resource exhaustion, consensus forks, recovery bypass. Use when reviewing anything security-critical, when a change touches identity/custody/rewards/consensus/relay endpoints, or when asked to security-test, threat-model or "think like an attacker". Produces findings with a concrete attack path, not a checklist of worries.
---

# Attacking neuron-web before someone else does

Set by Lucian, 2026-09-21: **when testing security, think like a black hat, to
find the problems before the real ones do on mainnet.**

The point is the *posture*, not a checklist. A reviewer asks "is this
correct?"; an attacker asks "what do I get if I lie here, and what stops me?".
Those produce different findings from the same code, and only the second kind
gets found by the people who are actually looking.

Dev mode is the window. Chain and relay data are disposable, there are no real
users and no real money, and Lucian has said to wipe freely — so **break
things now**, at the only time breaking them is free.

## How to run a pass

1. **Pick a target worth attacking.** Money, identity, and anything that
   deletes data. Not "all the code".
2. **Write the attacker's goal in one sentence.** "Earn rewards without
   storing anything." "Hold two accounts as one human." "Make a relay delete a
   file it should keep." "Exhaust a relay's memory from one laptop." If you
   cannot state the goal, you are reviewing, not attacking.
3. **Find the trust boundary.** Every value that crosses it is a value the
   attacker controls. Ask what the receiver does with it *before* verifying.
4. **Follow the value, not the call graph.** Who computes this number? Who
   could compute it differently? What is checked against it?
5. **Build the attack if it is cheap.** A test that performs the attack is
   worth ten paragraphs about whether it would work. The v2 key-blob weakness
   was settled by running a 4-digit brute force, not by arguing.
6. **Report the ceiling honestly.** Where an attack is *expensive* rather than
   *impossible*, say which. Overstating a defence is how it stops being
   improved.

## Where this system's value actually is

The targets, roughly by what an attacker gains:

- **Identity / Sybil.** Consensus weight is age-weighted personhood, so
  minting humans mints power. Known ceiling: `/face-verify/verify` accepts a
  client-supplied 128-float descriptor and has never seen a camera — liveness
  is enforced entirely client-side. The relay's real defences are the per-IP
  cap and `FACE_MAX`. Do not describe the trajectory proof as liveness-proof.
- **Rewards.** Anything self-reported that meters a payout. Ask: who says how
  many bytes are held, and what would a lie be worth?
- **Custody.** Getting paid for bytes you do not hold; making someone else
  delete bytes they should keep. A receipt is a *claim*; a spot-check is
  evidence.
- **Consensus.** Equivocation freezes an account permanently — which is a
  weapon if you can make someone else fork. Two writers on one chain is the
  cheap version.
- **Relays.** They are the shared, always-on surface: unbounded per-key state,
  unauthenticated endpoints, amplification (one cheap request causing expensive
  work elsewhere), and anything that makes a relay fetch or broadcast on
  command.
- **Recovery.** The share-release gate is the one rate limit a client wipe
  cannot reset. Attack the ordering, the replay, and the backoff, not the
  crypto.

## What counts as a finding

A finding names **the attacker's goal, the concrete path, and what it costs
them**. "This is unvalidated" is not a finding; "an unvalidated X lets me do Y
for the price of Z" is.

Rank by what it buys the attacker, not by how clever it is:

1. Steals value, mints identity, or destroys data → fix before anything else.
2. Degrades the network for others (exhaustion, amplification) → fix.
3. Leaks information → weigh.
4. Requires capabilities an attacker plausibly lacks → record the ceiling,
   move on.

Everything found this way goes in [docs/SCREENING.md](../../../docs/SCREENING.md)
with what it cost, so the next pass starts from a real list rather than a
blank page.

## Traps specific to this codebase

- **The control is the vector.** Both memory leaks found so far were in rate
  limiters, whose bookkeeping is keyed by exactly the thing an attacker varies.
  Screen anti-abuse code first, not last.
- **A silent `return` hides an attack as well as a bug.** If a rejection does
  not log, you cannot tell a refused attack from one that never arrived.
- **Verifiers must rebuild the payload**, never trust it from the message. A
  signature over attacker-chosen bytes proves nothing about the fields you
  then read.
- **Unsigned fields ride inside signed records.** The account record's `_sig`
  covers four fields; everything else in it was unauthenticated, and was being
  read into ledger state.
- **Dev-only bypasses are real attack surface if they ship.** The synthetic
  face and the dev relay proxy are both on CLAUDE.md's remove-before-production
  list. Re-check that list is still true before any build.
