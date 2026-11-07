import { Effort } from '@10db/contracts';

/**
 * The slug Artificial Analysis lists a model's effort under, or null when it lists none. The slug is the
 * catalogue's model ID with dots as hyphens, followed by `-<effort>`; the top effort is the bare slug. The ID is
 * the canonical one, so a model scores the same whichever account launches it. Only a slug AA actually lists is
 * returned, so a model it does not measure is left unscored.
 */
export function aaSlugFor(
  model: string,
  effort: Effort,
  listed: ReadonlySet<string>,
): string | null {
  const bare = model.replaceAll('.', '-');
  const slug = effort === Effort.Max ? bare : `${bare}-${effort}`;
  return listed.has(slug) ? slug : null;
}
