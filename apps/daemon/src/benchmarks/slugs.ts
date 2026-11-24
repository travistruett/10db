import { Effort } from '@10db/contracts';

/**
 * The slug Artificial Analysis lists a model's effort under, or null when it lists none. The slug is the
 * catalogue's model ID with dots as hyphens, followed by `-<effort>`; the top effort is the bare slug. The ID is
 * the canonical one, so a model scores the same whichever account launches it. Only a slug AA actually lists is
 * returned, so a model it does not measure is left unscored. An OpenRouter ID names its maker first
 * (`aion-labs/aion-2.0`), which AA's slug leaves out; a router alias (`~maker/...-latest`) names no one model.
 */
export function aaSlugFor(
  model: string,
  effort: Effort,
  listed: ReadonlySet<string>,
): string | null {
  if (model.startsWith('~')) return null;
  const bare = model.slice(model.indexOf('/') + 1).replaceAll('.', '-');
  const slug = effort === Effort.Max ? bare : `${bare}-${effort}`;
  return listed.has(slug) ? slug : null;
}
