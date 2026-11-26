import {
  isWatchpointOff,
  type EffectiveWatchpoint,
  type ProjectWatchpointEntry,
  type Watchpoint,
  type WatchpointLoudness,
} from '@10db/contracts';

/** Where a saved watchpoint lives: the builder's list, or this project's own. */
export const WatchpointHome = { Everywhere: 'everywhere', Project: 'project' } as const;
export type WatchpointHome = (typeof WatchpointHome)[keyof typeof WatchpointHome];

/** The two lists a save sends: each is sent only when it changed. */
export interface WatchpointLists {
  readonly yours: readonly Watchpoint[];
  readonly entries: readonly ProjectWatchpointEntry[];
}

const without = <T extends { readonly key: string }>(list: readonly T[], key: string): T[] =>
  list.filter((item) => item.key !== key);

const replaced = <T extends { readonly key: string }>(list: readonly T[], item: T): T[] =>
  list.some((x) => x.key === item.key)
    ? list.map((x) => (x.key === item.key ? item : x))
    : [...list, item];

/** The row as a plain watchpoint, without where it came from. */
export function plain(row: EffectiveWatchpoint): Watchpoint {
  return {
    key: row.key,
    label: row.label,
    why: row.why,
    globs: row.globs,
    lines: row.lines,
    guidance: row.guidance,
    loudness: row.loudness,
    starter: row.starter,
  };
}

/**
 * A save of `draft` at `home`. At home Everywhere the builder's list takes it and the project drops its own
 * entry for the key; at Project the project's entry takes it, over the builder's when the key is theirs.
 */
export function saved(
  lists: WatchpointLists,
  draft: Watchpoint,
  home: WatchpointHome,
): WatchpointLists {
  if (home === WatchpointHome.Everywhere)
    return { yours: replaced(lists.yours, draft), entries: without(lists.entries, draft.key) };
  return { yours: lists.yours, entries: replaced(lists.entries, draft) };
}

/** A removal of the row: a builder's watchpoint leaves their list, a project's leaves the project's. */
export function removed(lists: WatchpointLists, row: EffectiveWatchpoint): WatchpointLists {
  if (row.from === 'you') return { yours: without(lists.yours, row.key), entries: lists.entries };
  // An override is dropped and the builder's own comes back: "Use yours".
  return { yours: lists.yours, entries: without(lists.entries, row.key) };
}

/** The row with another loudness, saved where it lives. */
export function withLoudness(
  lists: WatchpointLists,
  row: EffectiveWatchpoint,
  loudness: WatchpointLoudness,
): WatchpointLists {
  return saved(
    lists,
    { ...plain(row), loudness },
    row.from === 'you' ? WatchpointHome.Everywhere : WatchpointHome.Project,
  );
}

/** Turns the builder's watchpoint off in this project, or back on. */
export function turnedOff(lists: WatchpointLists, key: string, off: boolean): WatchpointLists {
  return {
    yours: lists.yours,
    entries: off
      ? replaced(lists.entries, { key, off: true as const })
      : without(lists.entries, key),
  };
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

/** The project's own entries that are `off` ones, with the label of the watchpoint they turn off. */
export function offEntries(
  entries: readonly ProjectWatchpointEntry[],
  yours: readonly Watchpoint[],
): { readonly key: string; readonly label: string }[] {
  return entries.filter(isWatchpointOff).map((e) => ({
    key: e.key,
    label: yours.find((w) => w.key === e.key)?.label ?? e.key,
  }));
}
