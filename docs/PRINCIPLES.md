# NeuronWeb core principles

The standing constitution of this project, set by Lucian. Everything else in
`docs/` describes *how* the system works; this describes *what it is for* and
what may never be traded away to get there.

These are not decoration. They are a **filter**: every idea, change, piece of
research and design decision is checked against them, and one that fails is not
adopted however convenient it is. Where a principle and a deadline disagree, the
principle wins and the deadline moves.

They are also **not finished** — see Principle 5. If you are working here and
something below is wrong, vague, or missing, say so.

---

## 1. NeuronWeb is for humanity. No discrimination.

**This is primarily about ACCESS to the technology** — clarified by Lucian,
2026-09-21. Not a social-policy statement: it is a statement about who can
obtain, run, modify and deploy the software, and on what.

Three concrete commitments:

**1a. Access to the technology and its licence.** Anyone may obtain, read, run,
modify and redistribute it, with no permission to ask for and no one able to
revoke it. This is the same commitment as Principle 2 seen from the user's
side rather than the project's.

**1b. Versatility of deployment — cross-OS, cross-platform.** The software must
run wherever people are, not only where it is convenient for us to build: every
major desktop and mobile OS, browsers, headless servers, single-board
computers. A platform that cannot run a node is a population that cannot
participate, which is what discrimination means here. See Principle 3c: this
diversity is *also* the redundancy the network's durability rests on.

**1c. Expanding into Web3 IoT.** Devices are first-class participants, not an
afterthought — which is why Principle 3d says "tens of billions of users, human
AND machine". An IoT node has little storage, little CPU, intermittent power
and a bad link, so the per-node cost model has to fit inside that envelope. The
scale invariant (`O(own data + followed data)`) is what makes this possible at
all: a node that must hold `O(total network)` can never be a sensor.

**What this rules out:** a platform-exclusive build, a licence that restricts
who may run or fork it, a dependency that only exists on one OS, and a resource
floor that quietly excludes small devices. If a change would raise the minimum
machine needed to participate, that is a cost against this principle and must
be argued explicitly.

**One-human-one-account is not in tension with this.** It is a *counting* rule
so no one can drown out everybody else, applied identically to every person —
not an eligibility test. Its corollary is an accessibility duty: the biometric
gate establishes personhood, never worthiness, so a face that cannot be
captured well on a cheap camera in poor light is an accessibility bug and not
an invalid user (CLAUDE.md → *Face matching*, and the measured finding that
cross-session distance — not luminance — is what decides recoverability).

## 2. NeuronWeb will forever be free and open source.

Free as in cost and free as in freedom, permanently, for everyone.

**What this rules out, concretely:** a paid tier that buys better service; a
proprietary component that a node needs in order to participate fully; a
dependency whose licence, pricing or availability could be withdrawn; a
"reference implementation" that is really the only implementation because the
protocol was never written down.

**Where this already bites:** the storage layer may never *require* an object
store, and no default configuration may point at a commercial one — the
filesystem backend is the zero-dependency bottom layer and the CI target, and S3
is opt-in and operator-configured (CLAUDE.md → *Storage custody rules*). Engine
modules stay dependency-light (`@noble/*` only) for the same reason: every
dependency is a party who could later charge rent or disappear.

## 3. Absolute decentralisation, reached progressively.

The destination is decentralisation **in its absolute meaning** — no required
party, anywhere, in any role. The path there is deliberately **progressive**, so
that we have time to decide together which route is best rather than locking in
the first thing that works.

This principle has five parts, and they constrain each other:

**3a. No required party.** Decentralisation here means *open membership +
redundancy + no single load-bearing role* — not the absence of servers. A VPS, a
Raspberry Pi and a browser tab are all first-class as long as anyone may run
that role, several do, and none is load-bearing alone
(ARCHITECTURE.md → *Participation model*).

**3b. Progressive, not overnight.** A temporary centralisation is acceptable
**only** when it is written down, structurally prevented from shipping, and has
a named replacement. That is exactly the bargain the *Remove before production*
list in CLAUDE.md records — the dev relay proxy routes attestation through one
origin, and it is on that list with its real fix (TLS + a real `faceVerifyUrl`)
named beside it. A shortcut with no entry on that list is not progressive
decentralisation, it is just centralisation.

**3c. Runs on as many kinds of device as possible.** Browsers, phones, laptops,
single-board computers, servers. Diversity of hardware and software *is* the
redundancy; a network that only runs well on one class of machine has a single
point of failure wearing a disguise.

**3d. Tens of billions of users — human and machine — without losing
performance.** This is the scale invariant, and it is the most-tested principle
in the repo: for any node, memory/storage/bandwidth/CPU must be
`O(own data + followed data)`, never `O(total network)`. The invariant binds
what a node must **answer**, not only what it must hold (ARCHITECTURE.md →
*Fan-IN*). "Machine" is deliberate: agents and devices are users too, so the
per-account cost model must survive accounts that are not people and do not
sleep.

**3e. Adaptable — able to assimilate new technology, and able to evolve.** The
codebase must stay easy to change, easy to sync across all nodes, and open to
absorbing better cryptography, transports and storage as they appear. **Changes
are voted on by a majority of node operators.** Two things follow that are not
yet built and must not be quietly assumed away:

- the **upgrade and code-sync mechanism** across nodes, and
- the **operator vote** that governs it — who is an operator, how a vote is
  counted, and how a node refuses an upgrade it did not ratify.

Both are open. Until they exist, any change to consensus-visible behaviour is a
change to something that will eventually need a vote, so it should be small,
reversible and documented — see the note on consensus inputs in CLAUDE.md
(`STORAGE_TIMING` is a consensus input precisely because nodes on different
profiles reject each other's blocks).

## 4. Filter the work through these principles — and test proportionately.

**4a. Screen every idea through the trinity: SECURITY → PERFORMANCE →
DECENTRALISATION, in that order.** Set by Lucian, 2026-09-21. The order is what
makes this a decision procedure rather than three competing opinions:

- **Security first.** A faster or more decentralised design that weakens the
  security model is not a trade to be weighed — it is rejected, and a different
  design is found. "Always strive for secure improvements" is the standing
  instruction, and it outranks the other two by construction.
- **Performance second.** Among designs that are equally safe, prefer the one
  that costs less per node. The scale invariant lives here.
- **Decentralisation third — not because it matters least**, but because it is
  the constraint most often reached for to justify compromising the first two.
  A design that is more decentralised and less safe loses at step 1. Where
  safety and cost are equal, take the one with no required party.

Where the three genuinely conflict, say so out loud in the commit or the
document rather than resolving it silently: a conflict is information about the
design, and burying it is how the resolution stops being reviewable.

The checklist this produces — what to screen for, and what to attack — is
[SCREENING.md](SCREENING.md). Every entry there comes from a defect this
project actually shipped.

**4b. Self-review.** After a run of significant changes, stop and re-read the
work against these principles rather than only against the tests. The question
is not "does it pass?" but "does this still build the thing described above?".
A change that improves a number while quietly adding a required party, a paid
dependency, an `O(N)` path or a barrier to joining has failed even with a green
suite.

Run the self-review when any of these is true:

- a batch of meaningful changes has landed (roughly: enough that you would
  write a handoff note about it),
- a subsystem's behaviour changed in a way another node can observe,
- a shortcut was taken that needs an entry on the *Remove before production*
  list, or
- you are about to start a new phase of work.

Write the result down where the decision lives — usually ARCHITECTURE.md or the
relevant section of CLAUDE.md — and raise anything that fails the filter with
Lucian instead of fixing it silently.

**4c. Test proportionately.** Test efficiently, not exhaustively-by-reflex:

- **Per change:** run the tests that cover what changed. `npx vitest run
  path/to/thing.test.ts` is the default, not `npm test`.
- **Full suite:** rarely — before a commit series lands, before a deploy, and
  when a change reaches across subsystems.
- **Type/build checks:** `npm run typecheck` when engine or storage types move;
  `npm run build` before anything that claims a bundle property.
- **Use a real browser when the question is a real browser question.** UX,
  usability, rendering, and anything needing visual or end-to-end confirmation
  goes through Playwright (`.claude/skills/e2e-browser-test/SKILL.md`). Every
  display defect of 2026-08-16 passed the unit suite, because each half was
  correct and only the rendered combination was wrong.
- **But prefer a logical assertion where one exists.** Whether data was wiped,
  whether a record is present, whether a count is right — that is decidable in
  code, and a screenshot only defers the judgement to a human. Keep images for
  what is genuinely visual: layout, overlay alignment, a banner covering a
  control.

## 5. The principles themselves are a work in progress.

These rules, the goals behind them and the definitions they use are meant to
improve continuously, **together with Lucian**. Ask for his input rather than
inferring; propose changes when the work exposes a gap; treat a principle that
keeps needing an exception as evidence the principle is wrong, not that the work
is.

Open questions currently sitting against these principles:

- **Who is a "node operator" for voting purposes** (Principle 3e), and how is a
  vote weighted without recreating one-machine-one-vote Sybil exposure?
- **How does code sync across nodes** without a required publisher — the
  upgrade path is itself a place a required party could sneak in.
- **Moderation.** Principle 1 is about access to the technology, so it does not
  by itself settle what the network does about abusive *content*. That decision
  has not been made, and it is a protocol question as much as a policy one.

---

## Using this document

- Referenced from [CLAUDE.md](../CLAUDE.md) (agent guidance) and
  [ARCHITECTURE.md](ARCHITECTURE.md) (design rationale). Those describe
  mechanism; this describes intent. **When they conflict, this wins** — and the
  conflict is a bug to report.
- Dated decisions that already embody these principles are recorded where they
  were made; this document does not restate them.
