import { WHOLE_REPOSITORY_GLOBS, type AreaDef } from '@10db/contracts';

/** An area whose globs take in the whole repository: as a scope it says no more than This Project. */
export function coversWholeRepository(area: AreaDef): boolean {
  return WHOLE_REPOSITORY_GLOBS.every((glob) => area.globs.includes(glob));
}

/** The areas a record can be scoped to: every one but those that are the whole project. */
export function scopeAreas(areas: readonly AreaDef[]): string[] {
  return areas.filter((area) => !coversWholeRepository(area)).map((area) => area.name);
}

/** How an area scope reads, in a list and in a choice. */
export const areaScopeLabel = (name: string): string => `Only in ${name}`;
