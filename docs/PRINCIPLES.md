# NeuronWeb core principles

The constitution of this project, set by Lucian. It says what NeuronWeb is
**for**, and what may never be traded away to get there.

It deliberately says nothing about *how* anything works. Mechanism, procedure,
thresholds and open engineering questions live in
[ARCHITECTURE.md](ARCHITECTURE.md), [SCREENING.md](SCREENING.md),
[CLAUDE.md](../CLAUDE.md), [SUPERNODE.md](SUPERNODE.md) and the rest of
`docs/`. If something here can be falsified by reading the code, it is in the
wrong document.

These are a **filter**, not decoration: every idea, change and piece of research
is checked against them, and one that fails is not adopted however convenient it
is. Where a principle and a deadline disagree, the principle wins and the
deadline moves.

---

## 1. NeuronWeb is for humanity. No discrimination.

Principally a statement about **ACCESS** (clarified by Lucian, 2026-09-21): who
may obtain, read, run, modify and deploy the software, and on what. Anyone,
anywhere, on any class of device — desktop, phone, browser, headless server,
single-board computer, and onward into Web3 IoT, where machines are first-class
users rather than an afterthought.

**A platform that cannot run a node is a population that cannot participate.**
Raising the minimum machine needed to take part is a cost against this
principle: it must be argued in the open, never absorbed silently.

One-human-one-account is a **counting** rule, applied identically to everyone so
that nobody can drown out everybody else. It is never an eligibility test, and
anything that makes a real person harder to admit is a defect rather than a
filter working correctly.

## 2. NeuronWeb will forever be free and open source.

Free as in cost and free as in freedom, permanently, for everyone.

No paid tier, no proprietary component a participant needs, no dependency whose
licence, price or availability could later be withdrawn, and no protocol that
exists only as one implementation.

## 3. Absolute decentralisation, reached progressively.

The destination is decentralisation in its **absolute** meaning — no required
party, anywhere, in any role. The path is deliberately **progressive**, so that
we have time to choose the best route together rather than locking in the first
thing that works.

- **No required party.** Open membership, redundancy, and no single
  load-bearing role — not the absence of servers.
- **Progressive, not overnight.** A temporary centralisation is acceptable only
  when it is written down, structurally prevented from shipping, and has a named
  replacement. Without all three it is not progress toward decentralisation, it
  is just centralisation.
- **Runs on as many kinds of device as possible.** Diversity of hardware and
  software *is* the redundancy.
- **Tens of billions of users, human and machine, without losing performance.**
  What a node spends must follow what that node chose — its own data and what it
  follows — never the size of the network, and never merely the passage of time.
- **Adaptable.** Easy to change, easy to sync across nodes, and open to
  absorbing better technology as it appears. Changes are ratified by a majority
  of node operators.

What decentralisation buys here, above all, is **flexibility and the speed with
which the network adapts** to a substrate that is always growing and always
volatile, so that redundancy is restored in real time. Tidiness is secondary;
restored redundancy is not.

## 4. Filter the work through these principles.

**Screen every idea through the trinity — SECURITY → PERFORMANCE →
DECENTRALISATION, in that order** (Lucian, 2026-09-21). The order is what makes
it a decision procedure rather than three competing opinions: security is a
**gate**, not a weight. A faster or more decentralised design that weakens the
security model is rejected and a different design is found. Where the three
genuinely conflict, say so out loud rather than resolving it silently — a
conflict is information about the design, and burying it is how the resolution
stops being reviewable.

**Self-review after a batch of meaningful work**, against the principles and not
only against the tests. A change can improve a number while quietly adding a
required party, a paid dependency, an unbounded path or a barrier to joining,
and still pass a green suite.

**Test proportionately** — enough to answer the question actually being asked,
and in the medium that can answer it.

*Procedure: [SCREENING.md](SCREENING.md) — what to screen for, what to attack,
and when the self-review is due. Testing cadence: [CLAUDE.md](../CLAUDE.md).*

## 5. Use the scientific method for every estimation, calculation and projection.

Numbers decide architecture here, so a number produced carelessly is worse than
no number at all: it ends the argument without settling it.

State the hypothesis, and what result would disprove it. Say where every input
came from. Never present a projection as a measurement. Show what the conclusion
is sensitive to. Make it reproducible by someone who doubts it.

**"We do not know yet" is a finding**, and it belongs in the document beside
what it would take to find out.

*Procedure: [SCREENING.md](SCREENING.md) → Numbers without provenance.*

## 6. The principles evolve with Lucian.

These rules, the goals behind them and the definitions they use are meant to
improve continuously, **together with Lucian**: ask for his input rather than
inferring it, propose changes when the work exposes a gap, and treat a principle
that keeps needing an exception as evidence that the principle is wrong, not
that the work is.

---

## Using this document

Every other document describes mechanism; this one describes intent. **When they
conflict, this wins** — and the conflict is a bug to report.

Open questions standing against these principles are tracked where they will be
answered, not here: ARCHITECTURE.md → *Hard problems / honest open risks*.
