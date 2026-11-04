import { closeSync, constants, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Git } from '../git';
import { journalTags, ownTags, parseTag } from './migration-numbers';
import type { RenumberedMigration } from './notices';
import { MIGRATIONS_DIR, type CarriedMigration } from './worktree-generated';

const JOURNAL = `${MIGRATIONS_DIR}meta/_journal.json`;

/** A journal or snapshot past this is not one drizzle-kit wrote for a project's migrations. */
const META_MAX_BYTES = 16 * 1024 * 1024;

/** A migration's SQL past this is not carried over. */
const SQL_MAX_BYTES = 64 * 1024 * 1024;

export type OwnMigrations =
  /** `migrations` is what to re-create, in order, after `baseTags`; none when there is nothing to carry. */
  | {
      readonly kind: 'found';
      readonly migrations: readonly CarriedMigration[];
      readonly baseTags: readonly string[];
    }
  /** The branch's migration `tag` can't be told apart, so it can't be re-created. */
  | { readonly kind: 'unreadable'; readonly tag: string; readonly why: string };

const NONE: OwnMigrations = { kind: 'found', migrations: [], baseTags: [] };

/** What `generate` writes into every snapshot whatever the schema: never part of the comparison. */
const SNAPSHOT_BOOKKEEPING: ReadonlySet<string> = new Set(['id', 'prevId', '_meta']);

/** `value` with each object's keys sorted: `--custom` copies a snapshot in another key order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => [key, sortedKeys(field)]),
  );
}

/** A snapshot's schema, comparable with another's; null when it is not a snapshot. */
export function schemaOf(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const schema = Object.entries(parsed).filter(([key]) => !SNAPSHOT_BOOKKEEPING.has(key));
    return JSON.stringify(sortedKeys(Object.fromEntries(schema)));
  } catch {
    return null;
  }
}

/**
 * The migrations `tip` added under the migrations directory that the base at `from` lacks. `--custom`
 * leaves the schema as it was, so a snapshot that repeats the one before it marks a hand-written
 * migration: the SQL can't, since its author may have replaced the stub's first line. Read from the
 * commits. Journals that can't be read leave nothing to carry, and the plain run's checks speak.
 */
export async function ownMigrations(
  git: Pick<Git, 'fileAt' | 'mergeBase'>,
  repo: string,
  tip: string,
  from: string,
): Promise<OwnMigrations> {
  const text = async (rev: string, path: string): Promise<string | null> => {
    const found = await git.fileAt(repo, rev, path, META_MAX_BYTES);
    return found.kind === 'file' ? found.text : null;
  };
  const ours = journalTags(await text(tip, JOURNAL));
  const theirs = journalTags(await text(from, JOURNAL));
  if (ours === null || theirs === null) return NONE;
  const ancestor = await git.mergeBase(repo, tip, from);
  const shared = ancestor === null ? [] : (journalTags(await text(ancestor, JOURNAL)) ?? []);
  const migrations: CarriedMigration[] = [];
  const snapshot = (number: string) => text(tip, `${MIGRATIONS_DIR}meta/${number}_snapshot.json`);
  for (const tag of ownTags(ours, theirs, shared)) {
    const parsed = parseTag(tag);
    if (parsed === null)
      return { kind: 'unreadable', tag, why: 'its tag is not one drizzle-kit writes' };
    const own = await snapshot(parsed.number);
    const schema = own === null ? null : schemaOf(own);
    if (schema === null) return { kind: 'unreadable', tag, why: 'its snapshot could not be read' };
    const before = parseTag(ours[ours.indexOf(tag) - 1] ?? '');
    const previous = before === null ? null : await snapshot(before.number);
    const custom = previous !== null && schemaOf(previous) === schema;
    migrations.push({ tag, name: parsed.name, custom });
  }
  return { kind: 'found', migrations, baseTags: theirs };
}

/** How far the generators got: `missing` is the first migration they did not make. */
export interface Carried {
  readonly renumbered: readonly RenumberedMigration[];
  readonly made: readonly { readonly migration: CarriedMigration; readonly tag: string }[];
  readonly missing: CarriedMigration | null;
}

/** Reads the worktree's journal, which the generators just wrote: it must hold the base's migrations, then `migrations`. */
export function carriedSoFar(
  repo: string,
  baseTags: readonly string[],
  migrations: readonly CarriedMigration[],
): Carried {
  let tags: string[] | null;
  try {
    tags = journalTags(readFileSync(join(repo, JOURNAL), 'utf8'));
  } catch {
    tags = null;
  }
  const now = tags ?? [];
  const after = baseTags.every((tag, i) => now[i] === tag) ? now.slice(baseTags.length) : [];
  const made: { migration: CarriedMigration; tag: string }[] = [];
  let missing: CarriedMigration | null = null;
  for (const [i, migration] of migrations.entries()) {
    const tag = after[i];
    if (tag === undefined || parseTag(tag)?.name !== migration.name) {
      missing = migration;
      break;
    }
    made.push({ migration, tag });
  }
  return {
    made,
    missing,
    renumbered: made
      .filter(({ migration, tag }) => migration.tag !== tag)
      .map(({ migration, tag }) => ({ from: migration.tag, to: tag })),
  };
}

/**
 * Puts each custom migration's SQL from `tip`, byte for byte, over the stub `--custom` wrote. The
 * generators ran the repository's scripts, so nothing there is trusted: a link in the file's place
 * or in the path to it refuses the write. Resolves with the migration it could not write, and why.
 */
export async function copyCustomSql(
  git: Pick<Git, 'bytesAt'>,
  repo: string,
  tip: string,
  made: Carried['made'],
): Promise<{ readonly tag: string; readonly why: string } | null> {
  for (const { migration, tag } of made) {
    if (!migration.custom) continue;
    const dir = join(repo, MIGRATIONS_DIR);
    try {
      const sql = await git.bytesAt(
        repo,
        tip,
        `${MIGRATIONS_DIR}${migration.tag}.sql`,
        SQL_MAX_BYTES,
      );
      if (sql === null) return { tag: migration.tag, why: 'its SQL could not be read' };
      if (`${realpathSync(dir)}/` !== join(realpathSync(repo), MIGRATIONS_DIR))
        return { tag: migration.tag, why: 'a link lies in the path to its file' };
      const fd = openSync(
        join(dir, `${tag}.sql`),
        constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW,
      );
      try {
        writeSync(fd, sql);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return {
        tag: migration.tag,
        why: error instanceof Error ? error.message : 'its SQL could not be written',
      };
    }
  }
  return null;
}
