/**
 * Mint for service, burn for storage — the two-sided UNIT economy.
 *
 * Lucian's design (2026-09-22):
 *
 * - emission is **inflationary**, with no fixed maximum supply;
 * - **storing content burns UNITS**, so consumption destroys what service
 *   creates;
 * - providing roughly **10x your own data** makes your storage pay for itself;
 * - a **free lifetime allowance** (1-10 GB per human), because provisioned
 *   space should exceed stored data;
 * - every new account is issued **1,000,000 UNITS** at creation.
 *
 * ## A correction to how this file was first written (Lucian, 2026-09-22)
 *
 * The first draft asserted that "a one-sided inflationary token has no
 * equilibrium and no reason to hold value", and treated a settled, capped
 * supply as the safe outcome. That is crypto orthodoxy imported as if it were
 * physics, and it is wrong for this system.
 *
 * **A deflationary currency rewards holding and punishes using.** For a
 * *utility* token whose entire purpose is to be spent on storage, that is
 * anti-purpose: the rational move becomes hoarding rather than participating.
 * It also makes late joiners pay more for the same service than early ones
 * did, permanently - which is Principle 1's access commitment failing in the
 * economics, and is the structural shape of a scheme where early holders are
 * paid by late entrants rather than by utility.
 *
 * The abundance model is also the one this architecture already runs on.
 * **Durability is a FLOW property** - content survives because the network
 * continuously re-replicates it, not because copies are hoarded. A currency
 * that must be hoarded to hold value would contradict the system it pays for.
 * Units are minted by service, destroyed by consumption, and what matters is
 * that the flow tracks real work. The total is not the interesting number.
 *
 * So: supply is unbounded by design, and that is not a risk to be mitigated.
 * What still has to be true is narrower and is measured by `flowHealth` below -
 * the mint:burn RATIO, not the supply level.
 *
 * ## Where the 10x comes from — it is physics, not economics
 *
 * `REDUNDANCY_TARGET` is 10. Storing one byte of *logical* data consumes ten
 * bytes of *physical* provision across the fleet. So a user who provides ten
 * times what they store is **space-neutral**: they put back exactly what they
 * take out. The number is not a pricing choice, it is conservation, and it
 * moves if and only if the redundancy target moves.
 *
 * Economic neutrality is a separate condition and does not follow
 * automatically, because earnings come from bytes SERVED while the burn is on
 * bytes STORED. `breakEvenProvisionRatio` computes the economic one; the design
 * goal is to set the burn rate so the two coincide, which is what
 * `burnRateForSelfPayingAt` solves for.
 *
 * Every projection here is ASSUMED in its inputs and says so (PRINCIPLES.md
 * → 5). What is measured is the *relationships*, which do not depend on
 * guessing the network's size correctly.
 */

/** Physical provision consumed by logical data, at a given redundancy. */
export function provisionForStorage(logicalBytes: number, redundancy: number): number {
  return logicalBytes * redundancy;
}

/**
 * The provision ratio at which a user is SPACE-neutral: puts back exactly the
 * physical bytes their logical data consumes. This is `redundancy`, and it is
 * where Lucian's 10x comes from.
 */
export function spaceNeutralRatio(redundancy: number): number {
  return redundancy;
}

export interface EconomyParams {
  /** Current supply. */
  supply: number;
  /** Annual emission as parts-per-million of supply. */
  inflationPpm: number;
  /** UNITS burned per byte of logical data stored, per period. */
  burnPerBytePerPeriod: number;
  /** Logical bytes stored across the whole network. */
  networkBytesStored: number;
  periodsPerYear: number;
}

export interface EconomyStep {
  minted: number;
  burned: number;
  net: number;
  supplyAfter: number;
}

/** One period of mint and burn. */
export function economyStep(p: EconomyParams): EconomyStep {
  const minted = (p.supply * p.inflationPpm) / 1_000_000 / p.periodsPerYear;
  const burned = p.networkBytesStored * p.burnPerBytePerPeriod;
  return { minted, burned, net: minted - burned, supplyAfter: p.supply + minted - burned };
}

/**
 * Where supply settles.
 *
 * Emission is proportional to supply; burn is not. So supply rises while
 * `burn > minted` is false and falls while it is true, and the fixed point is
 * where they meet:
 *
 * ```
 * supply x inflation / periods = bytesStored x burnRate
 * ```
 *
 * The consequence worth noticing: **equilibrium supply is set by how much the
 * network stores**, not by any monetary policy. Storage doubles, supply
 * doubles.
 *
 * Kept for the record, but note it answers a question this design does not
 * ask: reaching a fixed supply is not a goal here, and a token whose supply
 * keeps growing is not thereby broken (see the correction at the top).
 */
export function equilibriumSupply(args: {
  inflationPpm: number;
  burnPerBytePerPeriod: number;
  networkBytesStored: number;
  periodsPerYear: number;
}): number {
  const annualBurn = args.networkBytesStored * args.burnPerBytePerPeriod * args.periodsPerYear;
  if (args.inflationPpm <= 0) return Infinity;
  return (annualBurn * 1_000_000) / args.inflationPpm;
}

/**
 * How much a user must PROVIDE for their storage to pay for itself, in UNITS.
 *
 * Burn is on bytes stored; earnings are a share of the emission pool won by
 * bytes served. So:
 *
 * ```
 * stored x burnRate  =  (provided x readRatio / networkServed) x emission
 * ```
 *
 * Returns `provided / stored`. Lucian's target is that this lands near the
 * space-neutral ratio of 10 — which is a statement about the burn rate, since
 * everything else on the right is the network's behaviour rather than a choice.
 */
export function breakEvenProvisionRatio(args: {
  burnPerBytePerPeriod: number;
  /** Bytes served per byte provided, per period — the network's read intensity. */
  readRatio: number;
  /** Total bytes served by the whole network per period. */
  networkServedPerPeriod: number;
  emissionPerPeriod: number;
}): number {
  const earningsPerProvidedByte =
    (args.readRatio / args.networkServedPerPeriod) * args.emissionPerPeriod;
  if (earningsPerProvidedByte <= 0) return Infinity;
  return args.burnPerBytePerPeriod / earningsPerProvidedByte;
}

/**
 * The burn rate that makes the economic break-even land on a chosen provision
 * ratio — the calibration Lucian's "10x pays for itself" actually asks for.
 */
export function burnRateForSelfPayingAt(args: {
  targetRatio: number;
  readRatio: number;
  networkServedPerPeriod: number;
  emissionPerPeriod: number;
}): number {
  const earningsPerProvidedByte =
    (args.readRatio / args.networkServedPerPeriod) * args.emissionPerPeriod;
  return args.targetRatio * earningsPerProvidedByte;
}

/**
 * What a fresh account is worth to someone who can manufacture identities.
 *
 * The signup grant and the lifetime free allowance are both **per human**, so
 * they are priced entirely by the identity gate — and now they have an explicit
 * price tag rather than an implicit one. This function exists so that number is
 * stated rather than discovered later.
 *
 * `freeStorageYears` converts the free allowance into the UNITS it saves, since
 * the allowance is worth whatever storing that much would otherwise burn.
 */
export function sybilValueOfAccount(args: {
  signupUnits: number;
  freeBytes: number;
  burnPerBytePerPeriod: number;
  periodsPerYear: number;
  freeStorageYears: number;
}): { signup: number; freeStorage: number; total: number } {
  const freeStorage =
    args.freeBytes * args.burnPerBytePerPeriod * args.periodsPerYear * args.freeStorageYears;
  return { signup: args.signupUnits, freeStorage, total: args.signupUnits + freeStorage };
}

/**
 * How long a signup grant lasts at a given storage level.
 *
 * The number a new user actually cares about: "my 1,000,000 UNITS pay for how
 * much storage, for how long?"
 */
export function grantLifetimeYears(args: {
  signupUnits: number;
  bytesStored: number;
  burnPerBytePerPeriod: number;
  periodsPerYear: number;
}): number {
  const annualBurn = args.bytesStored * args.burnPerBytePerPeriod * args.periodsPerYear;
  return annualBurn > 0 ? args.signupUnits / annualBurn : Infinity;
}

/** Run the economy forward, to see whether it converges and how fast. */
export function simulateSupply(args: {
  startSupply: number;
  inflationPpm: number;
  burnPerBytePerPeriod: number;
  networkBytesStored: number;
  periodsPerYear: number;
  periods: number;
}): number[] {
  const out: number[] = [];
  let supply = args.startSupply;
  for (let i = 0; i < args.periods; i++) {
    const step = economyStep({ ...args, supply });
    supply = Math.max(0, step.supplyAfter);
    out.push(supply);
  }
  return out;
}

// ── The stability problem, and the fix ───────────────────────────────────────

/**
 * **The equilibrium above is UNSTABLE, and this is the most important finding
 * in this file.**
 *
 * Emission is a percentage *of supply*; burn is a quantity *of bytes*. So on
 * either side of the fixed point the feedback pushes away from it, not toward
 * it:
 *
 * - supply below equilibrium -> minted < burned -> supply falls -> emission
 *   falls further -> **spiral to zero**;
 * - supply above equilibrium -> minted > burned -> supply rises -> emission
 *   rises further -> **runaway inflation**.
 *
 * Measured: starting at 0.1x the fixed point the supply reaches zero within
 * twenty years; starting at 10x it grows without bound. Only an exact start
 * stays put, and nothing holds it there.
 *
 * This is not a tuning problem. Any `inflationPpm` has the same shape, because
 * the instability comes from emission depending on supply while burn does not.
 *
 * **The fix: tie emission to ACTIVITY, not to supply.** Mint per byte served,
 * burn per byte stored. Both then scale with what the network does, their ratio
 * is independent of supply, and there is no feedback loop at all — supply drifts
 * with real usage instead of chasing itself.
 */
export function activityEmission(args: {
  /** Bytes served network-wide this period. */
  bytesServedPerPeriod: number;
  /** UNITS minted per byte served. */
  mintPerByteServed: number;
}): number {
  return args.bytesServedPerPeriod * args.mintPerByteServed;
}

/**
 * The same economy with activity-based emission. Supply no longer appears on
 * the right-hand side, which is the whole point.
 */
export function activityStep(args: {
  supply: number;
  bytesServedPerPeriod: number;
  mintPerByteServed: number;
  networkBytesStored: number;
  burnPerBytePerPeriod: number;
}): EconomyStep {
  const minted = activityEmission(args);
  const burned = args.networkBytesStored * args.burnPerBytePerPeriod;
  return { minted, burned, net: minted - burned, supplyAfter: args.supply + minted - burned };
}

/** Run the activity-based economy forward. */
export function simulateActivitySupply(args: {
  startSupply: number;
  bytesServedPerPeriod: number;
  mintPerByteServed: number;
  networkBytesStored: number;
  burnPerBytePerPeriod: number;
  periods: number;
}): number[] {
  const out: number[] = [];
  let supply = args.startSupply;
  for (let i = 0; i < args.periods; i++) {
    supply = Math.max(0, activityStep({ ...args, supply }).supplyAfter);
    out.push(supply);
  }
  return out;
}

/**
 * The mint rate that balances the burn exactly, under activity-based emission.
 *
 * With both sides proportional to network activity, "balanced" is a single
 * ratio rather than a supply level — and it holds at every supply, which is
 * what makes it stable.
 */
export function balancedMintPerByteServed(args: {
  networkBytesStored: number;
  burnPerBytePerPeriod: number;
  bytesServedPerPeriod: number;
}): number {
  if (args.bytesServedPerPeriod <= 0) return 0;
  return (args.networkBytesStored * args.burnPerBytePerPeriod) / args.bytesServedPerPeriod;
}

/**
 * Total UNITS issued by signup grants — which, at 1,000,000 per human, is not a
 * detail.
 *
 * At a million users that is 1e12 UNITS, and at ten billion it is 1e16. The
 * grant is therefore the network's **primary issuance mechanism**, dwarfing
 * service emission, and it makes total supply a direct function of how many
 * humans have joined. That is a defensible design — it is a universal
 * endowment — but it must be chosen deliberately rather than discovered, and it
 * puts the money supply entirely in the hands of the identity gate.
 */
export function signupIssuance(args: { humans: number; signupUnits: number }): number {
  return args.humans * args.signupUnits;
}

// ── The actual rule (Lucian, 2026-09-22) ─────────────────────────────────────

/**
 * **A fixed exchange rate between storing and serving.**
 *
 * The rule, stated plainly: *storing one byte beyond the free allowance costs
 * what serving ten bytes earns.* Provide 10 GB of SERVED traffic and you have
 * paid for 1 GB of extra storage; the two cancel exactly.
 *
 * Everything above this line modelled emission as a percentage of supply and
 * burn as an independent quantity — assumptions carried over from the existing
 * `economy/rewards.ts`, never part of this design. They produced a real result
 * (that pairing is unstable) but they were answering a question nobody asked.
 * This section models the rule as given.
 *
 * ```
 * minted per period = bytesServed x mintRate
 * burned per period = bytesStored x mintRate x COST_RATIO
 * ```
 *
 * Both sides are activity. Supply never appears on the right, so the
 * instability found above cannot arise here at all — not because it was tuned
 * away, but because there is no feedback term.
 *
 * `mintRate` is a pure denomination choice: doubling it doubles every balance
 * and changes nothing real. **The only economically meaningful parameter is
 * `COST_RATIO`**, and Lucian has set it to the redundancy factor, which is also
 * the space-conservation ratio. The economics and the physics agree by
 * construction rather than by calibration.
 */
export const COST_RATIO = 10;

/** Served bytes needed to pay for a given amount of stored data. */
export function selfPayingServedBytes(storedBytes: number, costRatio = COST_RATIO): number {
  return storedBytes * costRatio;
}

/**
 * Net supply movement in a period under the fixed-rate rule.
 *
 * Supply grows exactly when `bytesServed > costRatio x bytesStored`, i.e. when
 * the network reads more than ten times its stored volume per period. Nothing
 * else enters it — not supply, not price, not a policy knob.
 */
export function fixedRateStep(args: {
  bytesServedPerPeriod: number;
  bytesStored: number;
  mintPerByteServed: number;
  costRatio?: number;
}): EconomyStep & { inflationary: boolean } {
  const ratio = args.costRatio ?? COST_RATIO;
  const minted = args.bytesServedPerPeriod * args.mintPerByteServed;
  const burned = args.bytesStored * args.mintPerByteServed * ratio;
  return {
    minted, burned, net: minted - burned, supplyAfter: NaN,
    inflationary: args.bytesServedPerPeriod > ratio * args.bytesStored,
  };
}

/**
 * The read intensity at which the economy is exactly balanced: bytes served per
 * byte stored, per period. Equal to `costRatio` — which is the rule restated,
 * and worth having as a number because it is the one empirical question the
 * design rests on. **Does the network actually read ten times its stored volume
 * per period?** Below it the supply shrinks, above it the supply grows. Neither
 * is a failure - growth is the intended direction, since a regenerating system
 * should regenerate its unit of account too.
 */
export function balancedReadIntensity(costRatio = COST_RATIO): number {
  return costRatio;
}

/**
 * What one colluding human can mint by wash-reading, expressed as the storage
 * it buys.
 *
 * This is the attack a FIXED rate reopens and a capped pool did not have. Under
 * a pool, fake reads only dilute other providers; under a fixed rate they
 * create UNITS from nothing. The defences are the per-reader cap and the
 * distinct-reader floor (`content/read-receipts.ts`), so the yield is bounded
 * by what one attested human is allowed to claim.
 */
export function washReadStorageYield(args: {
  perReaderCapBytes: number;
  costRatio?: number;
  periodsPerYear: number;
}): { storageBytesPerPeriod: number; storageBytesPerYear: number } {
  const ratio = args.costRatio ?? COST_RATIO;
  const perPeriod = args.perReaderCapBytes / ratio;
  return { storageBytesPerPeriod: perPeriod, storageBytesPerYear: perPeriod * args.periodsPerYear };
}

/**
 * The per-reader cap at which wash-reading earns no more than the free
 * allowance simply gives away.
 *
 * The design rule that makes the attack pointless rather than merely bounded:
 * if a fake human can mint less storage than a real signup hands out for free,
 * nobody manufactures identities to wash-read — they would be working for less
 * than the door prize.
 */
export function capForWashYieldBelowFreeTier(args: {
  freeBytes: number;
  lifetimeYears: number;
  periodsPerYear: number;
  costRatio?: number;
}): number {
  const ratio = args.costRatio ?? COST_RATIO;
  const perPeriodAllowance = args.freeBytes / (args.lifetimeYears * args.periodsPerYear);
  return perPeriodAllowance * ratio;
}

/**
 * The number that actually matters under an abundance model.
 *
 * Not the supply level - that is unbounded by design and says nothing on its
 * own. What has to stay true is that the FLOW keeps tracking real work, and
 * the mint:burn ratio is that, in one number:
 *
 * - **around 1** - service and consumption are in step, and the unit is a
 *   measure of work being done;
 * - **persistently high** - units are created far faster than anything
 *   consumes them, so each buys progressively less storage and the incentive
 *   to serve erodes. This is the real failure mode, and it is about the RATIO,
 *   not about the total;
 * - **persistently low** - storage is consumed faster than service is
 *   produced, so units get scarce, stored data gets expensive, and joining
 *   gets harder over time. That is the failure the deflationary instinct is
 *   actually afraid of, and the one Principle 1 cares about.
 *
 * The band is wide on purpose. Holding this at exactly 1 would be monetary
 * policy, and monetary policy needs a policymaker - a required party this
 * project does not get to have.
 */
export function flowHealth(args: {
  mintedPerPeriod: number;
  burnedPerPeriod: number;
}): { ratio: number; verdict: 'balanced' | 'diluting' | 'tightening' } {
  if (args.burnedPerPeriod <= 0) {
    return { ratio: Infinity, verdict: args.mintedPerPeriod > 0 ? 'diluting' : 'balanced' };
  }
  const ratio = args.mintedPerPeriod / args.burnedPerPeriod;
  const verdict = ratio > 3 ? 'diluting' : ratio < 1 / 3 ? 'tightening' : 'balanced';
  return { ratio, verdict };
}
