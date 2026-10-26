import type { ModelProfileDto } from '@10db/contracts';

/** The profiles an account offers: those whose alias it lists, or every one when it lists none (spec §3). */
export function offeredProfiles(
  profiles: readonly ModelProfileDto[],
  aliases: readonly string[] | undefined,
): ModelProfileDto[] {
  return aliases === undefined ? [...profiles] : profiles.filter((p) => aliases.includes(p.model));
}
