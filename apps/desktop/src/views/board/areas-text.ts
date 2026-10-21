import { AreaDef } from '@10db/contracts';

export type ParsedAreas =
  { readonly ok: true; readonly areas: AreaDef[] } | { readonly ok: false; readonly error: string };

/**
 * Parses the project form's areas box: one area per line, written `name: glob, glob`.
 * Blank lines are ignored. Errors name the line so the builder can fix it.
 */
export function parseAreas(text: string): ParsedAreas {
  const areas: AreaDef[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '') continue;
    const where = `Line ${String(index + 1)}`;
    const colon = line.indexOf(':');
    if (colon === -1)
      return { ok: false, error: `${where}: write each area as "name: glob, glob"` };
    const name = line.slice(0, colon).trim();
    if (!AreaDef.shape.name.safeParse(name).success) {
      return {
        ok: false,
        error: `${where}: "${name}" must use lowercase letters, digits and hyphens`,
      };
    }
    const globs = line
      .slice(colon + 1)
      .split(',')
      .map((glob) => glob.trim())
      .filter((glob) => glob !== '');
    if (globs.length === 0)
      return { ok: false, error: `${where}: area ${name} needs at least one glob` };
    if (areas.some((area) => area.name === name))
      return { ok: false, error: `${where}: area ${name} is listed twice` };
    areas.push({ name, globs });
  }
  if (areas.length === 0) return { ok: false, error: 'Add at least one area' };
  return { ok: true, areas };
}

/** The inverse of parseAreas, for showing a project's areas. */
export function formatAreas(areas: readonly AreaDef[]): string {
  return areas.map((area) => `${area.name}: ${area.globs.join(', ')}`).join('\n');
}

/** One acceptance criterion per non-blank line. */
export function criteriaLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
