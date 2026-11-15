import { AreaRole, type AreaDef } from '@10db/contracts';

/**
 * The project's areas with each page that has no label given the label the setup guessed for the
 * page of the same name. A label already there stays, and nothing else of an area changes. Answers
 * null when no page gains a label. Pure.
 */
export function withGuessedLabels(
  areas: readonly AreaDef[],
  proposed: readonly AreaDef[],
): AreaDef[] | null {
  const guesses = new Map<string, string>();
  for (const area of proposed)
    if (area.role === AreaRole.Page && area.label !== undefined) guesses.set(area.name, area.label);
  const next: AreaDef[] = [];
  let gained = 0;
  for (const area of areas) {
    const label =
      area.role === AreaRole.Page && area.label === undefined ? guesses.get(area.name) : undefined;
    if (label === undefined) next.push(area);
    else {
      next.push({ ...area, label });
      gained += 1;
    }
  }
  return gained > 0 ? next : null;
}
