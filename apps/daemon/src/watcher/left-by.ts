import type { WorkstreamId } from '@10db/contracts';

/** A failed run that could still be retried, with what it said on the way out. */
export interface EndedRun {
  readonly id: WorkstreamId;
  readonly title: string;
  /** Its failure reason, its last handoff and the summaries of the calls it skipped. */
  readonly texts: readonly string[];
}

/** A character a path name can hold, so a match that runs into one names a longer path. */
const PATH_CHAR = /[\w.@/-]/;

/** Whether `text` names `name` as a whole path: not as part of a longer name around it. */
function namesWhole(text: string, name: string): boolean {
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1];
    const after = text[at + name.length];
    if (
      (before === undefined || !PATH_CHAR.test(before)) &&
      (after === undefined || !PATH_CHAR.test(after))
    )
      return true;
  }
  return false;
}

/**
 * The runs that left each path: those whose texts name it, relative to the checkout `root` or in full. A path
 * no run names is left out of the map, so its card keeps today's attribution.
 */
export function leftBy(
  paths: readonly string[],
  root: string,
  runs: readonly EndedRun[],
): Map<string, EndedRun[]> {
  const found = new Map<string, EndedRun[]>();
  if (runs.length === 0) return found;
  for (const rel of paths) {
    const full = `${root}/${rel}`;
    const leavers = runs.filter((run) =>
      run.texts.some((text) => namesWhole(text, full) || namesWhole(text, rel)),
    );
    if (leavers.length > 0) found.set(rel, leavers);
  }
  return found;
}
