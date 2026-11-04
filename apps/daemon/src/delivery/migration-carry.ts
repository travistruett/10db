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
import { basename, dirname, join } from 'node:path';
import type { Git } from '../git';
import { journalTags, ownTags, parseTag } from './migration-numbers';
import type { RenumberedMigration } from './notices';
import { schemaOf, stepSchema } from './snapshot-schema';
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

/**
 * The migrations `tip` added under the migrations directory that the base at `from` lacks. `--custom`
 * leaves the schema as it was, so a snapshot that repeats the one before it marks a hand-written
 * migration: the SQL can't, since its author may have replaced the stub's first line. Read from the
 * commits. Journals that can't be read leave nothing to carry, and the plain run's checks speak.
 *
 * A tag both sides added says nothing by itself: each made its next number under the same `--name`.
 * It is the base's only when it is the same migration there, by its SQL and its schema, since a
 * snapshot's ids differ even so. Otherwise the branch's is its own, and the merge took the base's in
 * its place with nothing in `dropped` to show it.
 */
export async function ownMigrations(
  git: Pick<Git, 'blobAt' | 'fileAt' | 'mergeBase'>,
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
  const snapshot = (number: string, rev = tip) =>
    text(rev, `${MIGRATIONS_DIR}meta/${number}_snapshot.json`);
  const schemaAt = async (rev: string, number: string): Promise<string | null> => {
    const found = await snapshot(number, rev);
    return found === null ? null : schemaOf(found);
  };
  /** Whether `tag`, on both sides and not their ancestor, is a different migration on each. */
  const differs = async (tag: string): Promise<boolean> => {
    const number = parseTag(tag)?.number;
    if (number === undefined) return false;
    const file = `${MIGRATIONS_DIR}${tag}.sql`;
    return (
      (await git.blobAt(repo, tip, file)) !== (await git.blobAt(repo, from, file)) ||
      (await schemaAt(tip, number)) !== (await schemaAt(from, number))
    );
  };
  const contested = new Set<string>();
  for (const tag of ours)
    if (theirs.includes(tag) && !shared.includes(tag) && (await differs(tag))) contested.add(tag);
  const held = theirs.filter((tag) => !contested.has(tag));
  for (const tag of ownTags(ours, held, shared)) {
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

/** The file `drizzle-kit generate` reads the schema from, in the package that makes the migrations. */
export const SCHEMA_FILE = 'packages/db/src/schema.ts';

/** A schema file past this is not read. */
export const SCHEMA_MAX_BYTES = 16 * 1024 * 1024;

export type SchemaSteps =
  /**
   * `before` holds, for each generated migration but the last, a schema file that stands for the
   * schema at that migration, merged with the base's. The last one is made from the file as merged.
   */
  | { readonly kind: 'steps'; readonly before: ReadonlyMap<string, Buffer> }
  /** The schema as of migration `tag` can't be told, so it can't be made as a step of its own. */
  | { readonly kind: 'unknown'; readonly tag: string; readonly why: string };

/**
 * `generate` diffs the schema file as merged, so with two generated migrations the first would take
 * the changes of both and the second would make nothing. Each step needs the schema as it stood
 * at its migration, with the base's changes. The branch's snapshots at `tip` keep each step, whether
 * its commits made one migration each, one commit made several, or an earlier catch-up's regenerate
 * commit holds them all. Nothing to do for fewer than two generated migrations.
 */
export async function schemaSteps(
  git: Pick<Git, 'fileAt' | 'mergeBase'>,
  repo: string,
  tip: string,
  from: string,
  migrations: readonly CarriedMigration[],
): Promise<SchemaSteps> {
  const generated = migrations.filter((m) => !m.custom);
  const before = new Map<string, Buffer>();
  if (generated.length < 2) return { kind: 'steps', before };
  const text = async (rev: string, path: string): Promise<string | null> => {
    const found = await git.fileAt(repo, rev, path, META_MAX_BYTES);
    return found.kind === 'file' ? found.text : null;
  };
  const snapshotOf = (rev: string, number: string) =>
    text(rev, `${MIGRATIONS_DIR}meta/${number}_snapshot.json`);
  /** The snapshot of the last migration `rev` holds. */
  const latest = async (rev: string): Promise<string | null> => {
    const last = parseTag(journalTags(await text(rev, JOURNAL))?.at(-1) ?? '');
    return last === null ? null : snapshotOf(rev, last.number);
  };
  const ancestor = await git.mergeBase(repo, tip, from);
  const shared = ancestor === null ? null : await latest(ancestor);
  const theirs = await latest(from);
  for (const migration of generated.slice(0, -1)) {
    const unknown = (why: string): SchemaSteps => ({ kind: 'unknown', tag: migration.tag, why });
    const ours = await snapshotOf(tip, parseTag(migration.tag)?.number ?? '');
    if (ours === null || shared === null || theirs === null)
      return unknown('a snapshot it needs is not there');
    const schema = stepSchema(shared, ours, theirs);
    if (schema.kind === 'refused')
      return unknown(`a schema for its step could not be made: ${schema.why}`);
    before.set(migration.tag, Buffer.from(schema.text));
  }
  return { kind: 'steps', before };
}

/**
 * The runs of the generator that make `migrations`: one run with all of them, or with steps, one
 * for each stretch that is made from the same schema file. A `schema` is placed in the worktree for
 * its run; none leaves the schema file as the merge made it.
 */
export function stepRuns(
  migrations: readonly CarriedMigration[],
  before: ReadonlyMap<string, Buffer>,
): { readonly migrations: readonly CarriedMigration[]; readonly schema: Buffer | null }[] {
  if (before.size === 0) return [{ migrations, schema: null }];
  const runs: { migrations: CarriedMigration[]; schema: Buffer | null }[] = [];
  for (const migration of migrations) {
    const schema = before.get(migration.tag) ?? null;
    const last = runs.at(-1);
    if (last !== undefined && schema === null && last.schema === null)
      last.migrations.push(migration);
    else runs.push({ migrations: [migration], schema });
  }
  return runs;
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

/**
 * Those of `tags` whose name the journal at `rev` doesn't hold: all of them when it can't be read. A
 * name the journal at `base` holds as well is the base's migration, not the branch's, so with `base`
 * the name counts only as many times as `rev` holds it beyond that.
 */
export async function absentFrom(
  git: Pick<Git, 'fileAt'>,
  repo: string,
  rev: string,
  tags: readonly string[],
  base?: string,
): Promise<string[]> {
  const namesAt = async (at: string): Promise<(string | undefined)[] | null> => {
    const found = await git.fileAt(repo, at, JOURNAL, META_MAX_BYTES);
    const journal = journalTags(found.kind === 'file' ? found.text : null);
    return journal === null ? null : journal.map((t) => parseTag(t)?.name);
  };
  const names = await namesAt(rev);
  const theirs = base === undefined ? [] : await namesAt(base);
  if (names === null || theirs === null) return [...tags];
  const count = (list: readonly (string | undefined)[], name: string | undefined): number =>
    list.filter((one) => one === name).length;
  return tags.filter((tag) => {
    const name = parseTag(tag)?.name;
    return count(names, name) <= count(theirs, name);
  });
}

/**
 * Replaces the content of the existing file `path` (relative to `repo`) with `bytes`. A link in the
 * path to it, or anything but a plain file in its place (`withPlainFile`), refuses the write by
 * throwing: what ran in the worktree may have left either there.
 */
export function overwriteFile(repo: string, path: string, bytes: Buffer): void {
  const where = dirname(path);
  if (realpathSync(join(repo, where)) !== join(realpathSync(repo), where))
    throw new Error('a link lies in the path to its file');
  withPlainFile(join(repo, path), constants.O_WRONLY, (fd) => {
    ftruncateSync(fd);
    writeFileSync(fd, bytes);
  });
}

/**
 * Puts each custom migration's SQL from `tip`, byte for byte, over the stub `--custom` wrote
 * (`overwriteFile` refuses a link). Resolves with the migration it could not write, and why.
 */
export async function copyCustomSql(
  git: Pick<Git, 'bytesAt'>,
  repo: string,
  tip: string,
  made: Carried['made'],
): Promise<{ readonly tag: string; readonly why: string } | null> {
  for (const { migration, tag } of made) {
    if (!migration.custom) continue;
    try {
      const sql = await git.bytesAt(
        repo,
        tip,
        `${MIGRATIONS_DIR}${migration.tag}.sql`,
        SQL_MAX_BYTES,
      );
      if (sql === null) return { tag: migration.tag, why: 'its SQL could not be read' };
      overwriteFile(repo, `${MIGRATIONS_DIR}${tag}.sql`, sql);
    } catch (error) {
      return {
        tag: migration.tag,
        why: error instanceof Error ? error.message : 'its SQL could not be written',
      };
    }
  }
  return null;
}
