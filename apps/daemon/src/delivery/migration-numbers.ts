import { posix } from 'node:path';
import { z } from 'zod';

/** Where drizzle-kit keeps a migration directory's journal, relative to the directory. */
const JOURNAL = 'meta/_journal.json';

/** A branch's migration whose number the base already gives another one. */
export interface TakenNumber {
  /** The migration directory, relative to the repository root ('.' at the root). */
  readonly dir: string;
  readonly number: string;
  /** The branch's migration, by its tag (`0009_add_x`). */
  readonly ours: string;
  /** The base's migration with that number. */
  readonly theirs: string;
}

/** The migration directories whose drizzle journal is among `paths`, once each and sorted. */
export function journalDirs(paths: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of paths)
    if (path === JOURNAL || path.endsWith(`/${JOURNAL}`))
      dirs.add(posix.dirname(posix.dirname(path)));
  return [...dirs].sort();
}

/** The part of a drizzle journal that numbers its migrations. */
const Journal = z.object({
  entries: z.array(z.object({ idx: z.int().nonnegative(), tag: z.string().min(1) })),
});

function entriesOf(text: string | null): { idx: number; tag: string }[] | null {
  if (text === null) return null;
  try {
    const parsed = Journal.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.entries : null;
  } catch {
    return null;
  }
}

/** A migration's number as its tag spells it (`0009` of `0009_add_x`), else its index, padded. */
function numberOf(entry: { idx: number; tag: string }): string {
  return /^(\d+)_/.exec(entry.tag)?.[1] ?? String(entry.idx).padStart(4, '0');
}

/**
 * The branch's migrations in `dir` whose number the base's journal already gives a different
 * migration: two tasks generated on different bases, and migrations are numbered in order. None when
 * either journal is missing or is not one drizzle-kit wrote.
 */
export function takenNumbers(
  dir: string,
  ours: string | null,
  theirs: string | null,
): TakenNumber[] {
  const mine = entriesOf(ours);
  const base = entriesOf(theirs);
  if (mine === null || base === null) return [];
  const onBase = new Set(base.map((e) => e.tag));
  const byIndex = new Map(base.map((e) => [e.idx, e]));
  const taken: TakenNumber[] = [];
  for (const entry of mine) {
    if (onBase.has(entry.tag)) continue;
    const other = byIndex.get(entry.idx);
    if (other === undefined) continue;
    taken.push({ dir, number: numberOf(entry), ours: entry.tag, theirs: other.tag });
  }
  return taken;
}
