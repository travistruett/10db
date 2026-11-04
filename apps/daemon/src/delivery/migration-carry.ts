import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
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

/**
 * Runs `use` on `path`, opened with `flags`, once it is known to be a regular file with no other name.
 * The generators ran the repository's scripts and this runs in the daemon, outside the sandbox, on its
 * one event loop, so nothing they left is trusted: without `O_NONBLOCK` opening a FIFO would stop the
 * whole daemon, and a hard link would reach a file outside the worktree. `O_TRUNC` can't be among
 * `flags`: it would act before the check.
 */
function withPlainFile<T>(path: string, flags: number, use: (fd: number, size: number) => T): T {
  const fd = openSync(path, flags | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${basename(path)} is not a regular file`);
    if (stat.nlink !== 1) throw new Error(`${basename(path)} has another hard link`);
    return use(fd, stat.size);
  } finally {
    closeSync(fd);
  }
}

/** Reads the worktree's journal, which the generators just wrote: it must hold the base's migrations, then `migrations`. */
export function carriedSoFar(
  repo: string,
  baseTags: readonly string[],
  migrations: readonly CarriedMigration[],
): Carried {
  let tags: string[] | null;
  try {
    tags = journalTags(
      withPlainFile(join(repo, JOURNAL), constants.O_RDONLY, (fd, size) => {
        if (size > META_MAX_BYTES) throw new Error('the journal is too large');
        return readFileSync(fd, 'utf8');
      }),
    );
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
 * The tags of the `.sql` files in `dropped` that the branch at `tip` added: a file the common ancestor
 * with `from` already had came off because the base removed it, such as a baseline it regenerated, and
 * a name drizzle-kit wouldn't write is no migration.
 */
export async function addedTags(
  git: Pick<Git, 'blobAt' | 'mergeBase'>,
  repo: string,
  tip: string,
  from: string,
  dropped: readonly string[],
): Promise<string[]> {
  const ancestor = await git.mergeBase(repo, tip, from);
  const tags: string[] = [];
  for (const file of dropped.filter((f) => f.endsWith('.sql'))) {
    const tag = basename(file, '.sql');
    if (parseTag(tag) === null) continue;
    if (ancestor === null || (await git.blobAt(repo, ancestor, file)) === null) tags.push(tag);
  }
  return tags;
}

/** Those of `tags` whose name the journal at `rev` doesn't hold: all of them when it can't be read. */
export async function absentFrom(
  git: Pick<Git, 'fileAt'>,
  repo: string,
  rev: string,
  tags: readonly string[],
): Promise<string[]> {
  const found = await git.fileAt(repo, rev, JOURNAL, META_MAX_BYTES);
  const names = new Set(
    (journalTags(found.kind === 'file' ? found.text : null) ?? []).map((t) => parseTag(t)?.name),
  );
  return tags.filter((tag) => !names.has(parseTag(tag)?.name));
}

/**
 * Puts each custom migration's SQL from `tip`, byte for byte, over the stub `--custom` wrote. A link
 * in the path to the file, or anything but a plain file in its place (`withPlainFile`), refuses the
 * write. Resolves with the migration it could not write, and why.
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
      withPlainFile(join(dir, `${tag}.sql`), constants.O_WRONLY, (fd) => {
        ftruncateSync(fd);
        writeFileSync(fd, sql);
      });
    } catch (error) {
      return {
        tag: migration.tag,
        why: error instanceof Error ? error.message : 'its SQL could not be written',
      };
    }
  }
  return null;
}
