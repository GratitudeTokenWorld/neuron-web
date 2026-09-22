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
 * A one-sided inflationary token has no equilibrium and no reason to hold
 * value. Adding a burn tied to real consumption gives it both: supply settles
 * where burn equals emission, and the settling point is a function of how much
 * the network actually stores rather than of anything anyone decrees.
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
 * doubles. That is a far better property than an inflationary token without a
 * sink, which has no fixed point at all.
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
