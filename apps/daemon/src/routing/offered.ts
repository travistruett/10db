import { MODEL_TIERS } from './catalogue';
import type { ModelProfileDto } from '@10db/contracts';

/** The profiles an account offers: those whose alias it lists, or every one when it lists none (spec §3). */
export function offeredProfiles(
  profiles: readonly ModelProfileDto[],
  aliases: readonly string[] | undefined,
): ModelProfileDto[] {
  return aliases === undefined ? [...profiles] : profiles.filter((p) => aliases.includes(p.model));
}

/**
 * The Claude Code aliases among the profiles an account offers, each once and weakest first: what a
 * conversation's model picker lists (Shape spec §5.1). A profile off for routing is still a model the
 * builder may choose by hand.
 */
export function offeredModels(profiles: readonly ModelProfileDto[]): string[] {
  const held = new Set(profiles.map((p) => p.model));
  return MODEL_TIERS.map((t) => t.model).filter((model) => held.has(model));
}
