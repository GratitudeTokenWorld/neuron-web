import type { Hex } from '../core/hash.js';
import type { ValidatorRegistry } from './validators.js';
import type { Equivocation } from './vote.js';

/**
 * Slashing — the "skin in the game" that turns nothing-at-stake into something.
 *
 * A validator that equivocates (votes for two blocks in the same conflict) has
 * produced cryptographic evidence against itself. Slashing burns its entire bond
 * and bars it. This is what makes turnout-capture and double-vote attacks
 * economically self-defeating.
 */

export interface SlashRecord {
  voterId: Hex;
  burned: bigint;
  reason: string;
}

export function slashForEquivocation(registry: ValidatorRegistry, eq: Equivocation): SlashRecord {
  const burned = registry.slash(eq.voterId);
  return { voterId: eq.voterId, burned, reason: `equivocation in conflict ${eq.groupKey}` };
}

/** Apply slashing for a batch of equivocations, once per distinct validator. */
export function applyEquivocationSlashes(
  registry: ValidatorRegistry,
  equivocations: readonly Equivocation[],
): SlashRecord[] {
  const seen = new Set<Hex>();
  const records: SlashRecord[] = [];
  for (const eq of equivocations) {
    if (seen.has(eq.voterId)) continue;
    seen.add(eq.voterId);
    records.push(slashForEquivocation(registry, eq));
  }
  return records;
}
