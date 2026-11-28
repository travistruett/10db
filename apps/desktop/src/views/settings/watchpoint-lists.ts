import {
  isWatchpointOff,
  WatchpointLoudness,
  WatchpointCoverageState,
  type ProjectWatchpointEntry,
  type Watchpoint,
  type WatchpointCoverage,
} from '@10db/contracts';

/** A list with `item` in place of the one with its key, or added at the end. */
export function withItem<T extends { readonly key: string }>(list: readonly T[], item: T): T[] {
  return list.some((x) => x.key === item.key)
    ? list.map((x) => (x.key === item.key ? item : x))
    : [...list, item];
}

export function withoutKey<T extends { readonly key: string }>(
  list: readonly T[],
  key: string,
): T[] {
  return list.filter((item) => item.key !== key);
}

/** A key for a new watchpoint from its name, kept apart from every key in use. */
export function keyFor(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '') || 'watchpoint';
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}-${String(n)}`;
  return key;
}

/** When It Matches for one of the builder's watchpoints in a project: follow it, set it here, or turn it off here. */
export const ProjectChoice = {
  Default: 'default',
  Show: WatchpointLoudness.Show,
  Ask: WatchpointLoudness.Ask,
  Hold: WatchpointLoudness.Hold,
  Off: 'off',
} as const;
export type ProjectChoice = (typeof ProjectChoice)[keyof typeof ProjectChoice];

/** One row of a project's page: one of the builder's watchpoints, or one of the project's own. */
export interface ProjectRow {
  readonly key: string;
  /** What the row shows: the project's copy when it has one, else the builder's. */
  readonly shown: Watchpoint;
  /** The builder's watchpoint the row follows; null for the project's own. */
  readonly yours: Watchpoint | null;
  /** The project's entry under the key: a copy, an `off`, or none. */
  readonly entry: ProjectWatchpointEntry | null;
}

/** The builder's watchpoints in their order, each as this project has it, then the project's own. */
export function projectRows(
  yours: readonly Watchpoint[],
  entries: readonly ProjectWatchpointEntry[],
): ProjectRow[] {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const known = new Set(yours.map((w) => w.key));
  const followed = yours.map((watchpoint): ProjectRow => {
    const entry = byKey.get(watchpoint.key) ?? null;
    const shown = entry === null || isWatchpointOff(entry) ? watchpoint : entry;
    return { key: watchpoint.key, shown, yours: watchpoint, entry };
  });
  const own = entries.flatMap((entry): ProjectRow[] =>
    isWatchpointOff(entry) || known.has(entry.key)
      ? []
      : [{ key: entry.key, shown: entry, yours: null, entry }],
  );
  return [...followed, ...own];
}

/**
 * The keys a project's page counts as taken: yours and the project's own. An `off` entry for a key no longer in
 * your list hides nothing, so it takes no key, and a watchpoint saved under that key replaces it.
 */
export function keysInUse(
  yours: readonly Watchpoint[],
  entries: readonly ProjectWatchpointEntry[],
): Set<string> {
  const known = new Set(yours.map((w) => w.key));
  return new Set([
    ...known,
    ...entries.filter((e) => !isWatchpointOff(e) || known.has(e.key)).map((e) => e.key),
  ]);
}

/** Whether the project keeps its own copy of one of the builder's watchpoints. */
export function isOverride(row: ProjectRow): boolean {
  return row.yours !== null && row.entry !== null && !isWatchpointOff(row.entry);
}

export function isOffHere(row: ProjectRow): boolean {
  return row.entry !== null && isWatchpointOff(row.entry);
}

/** The row's When It Matches: Default, Off, or the loudness of the project's copy. */
export function choiceOf(row: ProjectRow): ProjectChoice | WatchpointLoudness {
  if (row.entry === null) return ProjectChoice.Default;
  if (isWatchpointOff(row.entry)) return ProjectChoice.Off;
  return row.entry.loudness;
}

/**
 * The project's entries after a When It Matches choice on one of the builder's: Default drops the project's
 * entry, Off writes an `off`, and Show, Ask or Hold keeps a copy at that loudness (the project's own copy, if it has one).
 */
export function withChoice(
  entries: readonly ProjectWatchpointEntry[],
  row: ProjectRow,
  choice: ProjectChoice,
): ProjectWatchpointEntry[] {
  if (choice === ProjectChoice.Default) return withoutKey(entries, row.key);
  if (choice === ProjectChoice.Off) return withItem(entries, { key: row.key, off: true as const });
  return withItem(entries, { ...row.shown, loudness: choice });
}

/**
 * Finds a watchpoint's count in a coverage query. While the query is on its way there is none (the count shows a
 * skeleton). A failed query, or an answer with no entry for the key, reads as not counted, so no skeleton waits forever.
 */
export function coverageLookup(query: {
  readonly data: readonly WatchpointCoverage[] | undefined;
  readonly isError: boolean;
}): (key: string) => WatchpointCoverage | undefined {
  const notCounted = (key: string): WatchpointCoverage => ({
    key,
    files: 0,
    examples: [],
    state: WatchpointCoverageState.Unreadable,
    asks: false,
    partial: false,
    repoFiles: 0,
  });
  return (key) => {
    if (query.isError) return notCounted(key);
    if (query.data === undefined) return undefined;
    return query.data.find((c) => c.key === key) ?? notCounted(key);
  };
}
