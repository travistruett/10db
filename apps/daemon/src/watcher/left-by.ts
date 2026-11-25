import type { WorkstreamId } from '@10db/contracts';

/** A failed run that can still be retried, with what it said as it failed. */
export interface EndedRun {
  readonly id: WorkstreamId;
  readonly title: string;
  /** When it failed, in epoch milliseconds. */
  readonly failedAt: number;
  /** Its failure reason, what its last handoff says of its progress and code, and the calls it skipped. */
  readonly texts: readonly string[];
}

/** At most this many paths are matched in one raise; past it every path keeps the running lanes. */
export const LEFT_BY_MAX_PATHS = 100;

/** Every string inside `value`, each as written: no JSON escaping runs a newline into the path after it. */
export function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === 'object')
    return Object.values(value).flatMap(stringLeaves);
  return [];
}

/** A character a path name can hold, so a match that runs into one names a longer path. */
const PATH_CHAR = /[\w.@/-]/;

const endsBefore = (text: string, at: number): boolean => {
  const before = text[at - 1];
  if (before === undefined || !PATH_CHAR.test(before)) return true;
  // `./docs/x` names `docs/x`.
  const dotBefore = text[at - 3];
  return text.slice(at - 2, at) === './' && (dotBefore === undefined || !PATH_CHAR.test(dotBefore));
};

const endsAfter = (text: string, end: number): boolean => {
  const after = text[end];
  if (after === undefined || !PATH_CHAR.test(after)) return true;
  // A full stop or comma that closes a sentence is not part of the name.
  const next = text[end + 1];
  return (after === '.' || after === ',') && (next === undefined || !PATH_CHAR.test(next));
};

/** Whether `text` names `name` as a whole path: not as part of a longer name around it. */
function namesWhole(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1))
    if (endsBefore(text, at) && endsAfter(text, at + name.length)) return true;
  return false;
}

/**
 * The runs that left each path: those that named it, relative to the checkout `root` or in full, and failed no
 * earlier than the path was last written (`writtenAt`, epoch milliseconds; null when it can't be read, which
 * names no run). A path no run left is left out of the map, so its card names the lanes running when the write
 * was seen.
 */
export function leftBy(
  paths: readonly string[],
  root: string,
  runs: readonly EndedRun[],
  writtenAt: (rel: string) => number | null,
): Map<string, EndedRun[]> {
  const found = new Map<string, EndedRun[]>();
  if (runs.length === 0 || paths.length > LEFT_BY_MAX_PATHS) return found;
  for (const rel of paths) {
    const full = `${root}/${rel}`;
    const named = runs.filter((run) =>
      run.texts.some((text) => namesWhole(text, full) || namesWhole(text, rel)),
    );
    if (named.length === 0) continue;
    const written = writtenAt(rel);
    if (written === null) continue;
    const leavers = named.filter((run) => written <= run.failedAt);
    if (leavers.length > 0) found.set(rel, leavers);
  }
  return found;
}
