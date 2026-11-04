import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { BatchDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchWorkstream } from '@10db/db';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { DRIZZLE_CONFIG, drizzleGenerate } from '../../test/drizzle-kit';
import { isolatedGitEnv } from '../../test/fixtures';
import type { DeliveryContext } from './context';
import { createBaseUpdates } from './index';

vi.setConfig({ testTimeout: 120_000 });

const PACKAGE = 'packages/db';
const SCHEMA = `${PACKAGE}/src/schema.ts`;
const DB = `${PACKAGE}/drizzle`;
const JOURNAL = `${DB}/meta/_journal.json`;
const signal = new AbortController().signal;

const NOTE = "  note: text('note'),";
const OWNER = "  owner: text('owner'),";
const SHAPE = "  shape_id: text('shape_id'),";
const WORKSTREAM = "  workstream_id: text('workstream_id').notNull(),";
const LOOSE_WORKSTREAM = "  workstream_id: text('workstream_id'),";
const LOGS = "export const logs = sqliteTable('logs', { id: text('id').primaryKey() });";

/**
 * `sessions` with `columns` at its end, the spot the sides add to in one test, `top` far from the rest
 * of it, and `after` it. `workstream` stands apart from both, so a change to it merges with theirs.
 */
const schemaFile = ({
  top = [],
  workstream = WORKSTREAM,
  columns = [],
  after = [],
  config = '',
}: {
  top?: readonly string[];
  workstream?: string;
  columns?: readonly string[];
  after?: readonly string[];
  config?: string;
} = {}): string =>
  [
    "import { sql } from 'drizzle-orm';",
    "import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';",
    '',
    "export const sessions = sqliteTable('sessions', {",
    "  id: text('id').primaryKey(),",
    ...top,
    "  title: text('title'),",
    workstream,
    "  body: text('body'),",
    ...columns,
    `}${config});`,
    ...after,
    '',
  ].join('\n');

/** One migration: `sql` makes it a custom one, whose schema does not move. */
interface Step {
  readonly name: string;
  readonly schema: string;
  readonly sql?: string;
  /** Takes the migration made last off first, as a task that deletes it and generates it again does. */
  readonly redo?: boolean;
}

/** Takes the last migration out of the package in `dir`: its journal entry, SQL and snapshot. */
function dropLast(dir: string): void {
  const journal = join(dir, 'drizzle/meta/_journal.json');
  const parsed = JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] };
  const tag = parsed.entries.pop()?.tag ?? '';
  writeFileSync(journal, `${JSON.stringify(parsed, null, 2)}\n`);
  rmSync(join(dir, 'drizzle', `${tag}.sql`));
  rmSync(join(dir, 'drizzle/meta', `${tag.slice(0, 4)}_snapshot.json`));
}

/** The migration directory `drizzle-kit` keeps, outside any repository. */
function generatedStep(dir: string, { name, schema, sql, redo = false }: Step): void {
  if (redo) dropLast(dir);
  writeFileSync(join(dir, 'src/schema.ts'), schema);
  drizzleGenerate(dir, name, sql !== undefined);
  if (sql === undefined) return;
  const tag = lastTag(dir);
  writeFileSync(join(dir, 'drizzle', `${tag}.sql`), sql);
}

const tagsAt = (journal: string): string[] =>
  (JSON.parse(readFileSync(journal, 'utf8')) as { entries: { tag: string }[] }).entries.map(
    (entry) => entry.tag,
  );

const lastTag = (dir: string): string =>
  tagsAt(join(dir, 'drizzle/meta/_journal.json')).at(-1) ?? '';

/** Every file of the directory `dir` holds, by the path it has in a repository. */
function filesIn(dir: string): Map<string, string> {
  const files = new Map<string, string>([
    [SCHEMA, readFileSync(join(dir, 'src/schema.ts'), 'utf8')],
  ]);
  for (const sub of ['drizzle', 'drizzle/meta'])
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true }))
      if (entry.isFile())
        files.set(
          `${PACKAGE}/${sub}/${entry.name}`,
          readFileSync(join(dir, sub, entry.name), 'utf8'),
        );
  return files;
}

const changedFiles = (now: Map<string, string>, before: Map<string, string>): Map<string, string> =>
  new Map([...now].filter(([path, content]) => before.get(path) !== content));

let h: DeliveryHarness;
let scratch: string;
let commits = 0;

const pathOf = (batch: BatchDto): string => {
  if (batch.worktreePath === null) throw new Error('the batch has no worktree');
  return batch.worktreePath;
};

const statusOf = (dir: string): string =>
  execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], {
    env: isolatedGitEnv(),
  })
    .toString()
    .trim();

async function commitOnBatch(batch: BatchDto, files: Map<string, string>): Promise<void> {
  commits += 1;
  for (const [path, content] of files) {
    mkdirSync(dirname(join(pathOf(batch), path)), { recursive: true });
    writeFileSync(join(pathOf(batch), path), content);
  }
  await h.git.commit({
    repo: pathOf(batch),
    paths: [...files.keys()],
    message: `Commit ${String(commits)}`,
    opId: `op-steps-${String(commits)}`,
    branch: batch.branch ?? '',
  });
}

const copyOf = (from: string, name: string): string => {
  const to = join(scratch, name);
  cpSync(from, to, { recursive: true, filter: (file) => basename(file) !== 'node_modules' });
  return to;
};

/** What main holds before the batch starts, with `0000_init` made from `schemaFile()`. */
function mainPackage(): string {
  const dir = join(scratch, 'main');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'drizzle.config.ts'), DRIZZLE_CONFIG);
  generatedStep(dir, { name: 'init', schema: schemaFile() });
  return dir;
}

/** `steps` on the batch, a commit each or all in `oneCommit`, and main's own `theirs` on main. */
async function bothSidesAdded(
  steps: readonly Step[],
  theirs: Step,
  { oneCommit = false }: { oneCommit?: boolean } = {},
): Promise<BatchDto> {
  const main = mainPackage();
  h.commit('.gitignore', 'node_modules\n');
  h.commit(
    `${PACKAGE}/package.json`,
    `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
  );
  h.commit(`${PACKAGE}/drizzle.config.ts`, DRIZZLE_CONFIG);
  for (const [path, content] of filesIn(main)) h.commit(path, content);
  h.git$('push', '-q', 'origin', 'main');
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.state.write((c) => {
    patchWorkstream(c, ws.id, null, { baseHead: batch.baseSha ?? '' });
  });

  const ours = copyOf(main, 'ours');
  const held = filesIn(ours);
  let before = held;
  for (const step of steps) {
    generatedStep(ours, step);
    if (!oneCommit) await commitOnBatch(batch, changedFiles(filesIn(ours), before));
    before = filesIn(ours);
  }
  if (oneCommit) await commitOnBatch(batch, changedFiles(filesIn(ours), held));

  mainAdds(theirs);
  return batch;
}

/** Makes `step` in main's package and pushes what it changed. */
function mainAdds(step: Step): void {
  const dir = join(scratch, 'main');
  const before = filesIn(dir);
  generatedStep(dir, step);
  for (const [path, content] of changedFiles(filesIn(dir), before))
    h.teammatePush('main', path, content);
}

/** What the package's `generate` does, at the process boundary: the real drizzle-kit, run in the worktree. */
const drizzle = (failAt?: string): DeliveryContext['generators'] => ({
  regenerate: ({ path, migrations = [] }) => {
    for (const { name, custom } of migrations) {
      if (name === failAt)
        return Promise.resolve({
          kind: 'failed',
          exitCode: 1,
          timedOut: false,
          tail: 'drizzle-kit failed',
          logPath: join(path, 'generate.log'),
        });
      drizzleGenerate(join(path, PACKAGE), name, custom);
    }
    return Promise.resolve({ kind: 'done', logPath: join(path, 'generate.log') });
  },
});

const journalOf = (batch: BatchDto): string[] => tagsAt(join(pathOf(batch), JOURNAL));
const sqlOf = (batch: BatchDto, tag: string): string =>
  readFileSync(join(pathOf(batch), DB, `${tag}.sql`), 'utf8');

const update = (batch: BatchDto, failAt?: string) =>
  createBaseUpdates({ ...h.ctx, generators: drizzle(failAt) }).beforeGate(batch.id, signal);

/** Runs the worktree's migrations in journal order on a real database, `seed` after the first. */
function applied(batch: BatchDto, seed: string, read: string): unknown[] {
  const database = new Database(join(scratch, `${String((commits += 1))}.sqlite`));
  try {
    for (const [i, tag] of journalOf(batch).entries()) {
      for (const statement of sqlOf(batch, tag).split('--> statement-breakpoint'))
        database.exec(statement);
      if (i === 0) database.exec(seed);
    }
    return database.prepare(read).all();
  } finally {
    database.close();
  }
}

const addNote: Step = { name: 'note', schema: schemaFile({ columns: [NOTE] }) };
const addOwner: Step = { name: 'owner', schema: schemaFile({ columns: [NOTE, OWNER] }) };
const addLogs: Step = { name: 'logs', schema: schemaFile({ after: [LOGS] }) };

describe('carrying a branch with several generated migrations over, each as its own step', () => {
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'migration-steps-'));
    h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  });

  afterEach(() => {
    h.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each([
    { name: 'a commit each', oneCommit: false },
    { name: 'both in one commit', oneCommit: true },
  ])(
    "keeps both after main's, under their names, with main's change in each: $name",
    async ({ oneCommit }) => {
      const batch = await bothSidesAdded([addNote, addOwner], addLogs, { oneCommit });

      expect((await update(batch)).kind).toBe('merged');

      expect(h.cards()).toEqual([]);
      expect(journalOf(batch)).toEqual(['0000_init', '0001_logs', '0002_note', '0003_owner']);
      expect(sqlOf(batch, '0002_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
      expect(sqlOf(batch, '0003_owner')).toBe('ALTER TABLE `sessions` ADD `owner` text;');
      // The schema file the steps used is the merge's again.
      expect(statusOf(pathOf(batch))).toBe('');
      expect(readFileSync(join(pathOf(batch), SCHEMA), 'utf8')).toBe(
        schemaFile({ columns: [NOTE, OWNER], after: [LOGS] }),
      );
      const notice = h.only(getBatch(h.store.db, batch.id).notices);
      expect(notice.body).toContain('0001_note → 0002_note');
      expect(notice.body).toContain('0002_owner → 0003_owner');
    },
  );

  it('carries both when main added its column at the very spot the batch added its own', async () => {
    const batch = await bothSidesAdded([addNote, addOwner], {
      name: 'shape',
      schema: schemaFile({ columns: [SHAPE] }),
    });

    expect((await update(batch)).kind).toBe('merged');

    expect(h.cards()).toEqual([]);
    expect(journalOf(batch)).toEqual(['0000_init', '0001_shape', '0002_note', '0003_owner']);
    expect(sqlOf(batch, '0002_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
    expect(sqlOf(batch, '0003_owner')).toBe('ALTER TABLE `sessions` ADD `owner` text;');
    expect(statusOf(pathOf(batch))).toBe('');
  });

  describe.each([
    { name: 'a commit each', oneCommit: false },
    { name: 'one commit', oneCommit: true },
  ])('a pair split in two on purpose, in $name', ({ oneCommit }) => {
    const looseOwner = `, (t) => [check('one_owner', sql\`(\${t.workstream_id} IS NULL) <> (\${t.shape_id} IS NULL)\`)]`;
    const addColumn: Step = { name: 'shape_column', schema: schemaFile({ columns: [SHAPE] }) };
    const rebuild: Step = {
      name: 'rebuild',
      schema: schemaFile({
        workstream: LOOSE_WORKSTREAM,
        columns: [SHAPE],
        config: looseOwner,
      }),
    };
    const seed = "INSERT INTO sessions (id, workstream_id) VALUES ('s1', 'w1');";
    const read = 'SELECT id, workstream_id, shape_id, note FROM sessions';

    it("stays two, so the rebuild's copy of the new column applies on a seeded database", async () => {
      const batch = await bothSidesAdded(
        [addColumn, rebuild],
        { name: 'note', schema: schemaFile({ top: [NOTE] }) },
        { oneCommit },
      );

      expect((await update(batch)).kind).toBe('merged');

      expect(h.cards()).toEqual([]);
      expect(journalOf(batch)).toEqual([
        '0000_init',
        '0001_note',
        '0002_shape_column',
        '0003_rebuild',
      ]);
      expect(sqlOf(batch, '0002_shape_column')).toBe('ALTER TABLE `sessions` ADD `shape_id` text;');
      expect(sqlOf(batch, '0003_rebuild')).toContain('__new_sessions');
      expect(sqlOf(batch, '0003_rebuild')).toContain('`note`');
      expect(applied(batch, seed, read)).toEqual([
        { id: 's1', workstream_id: 'w1', shape_id: null, note: null },
      ]);
    });
  });

  it.each([
    { name: 'a commit each', oneCommit: false },
    { name: 'both in one commit', oneCommit: true },
  ])('keeps them separate through a second catch-up: $name', async ({ oneCommit }) => {
    const batch = await bothSidesAdded([addNote, addOwner], addLogs, { oneCommit });
    await update(batch);
    mainAdds({ name: 'shape', schema: schemaFile({ columns: [SHAPE], after: [LOGS] }) });

    expect((await update(batch)).kind).toBe('merged');

    expect(h.cards()).toEqual([]);
    expect(journalOf(batch)).toEqual([
      '0000_init',
      '0001_logs',
      '0002_shape',
      '0003_note',
      '0004_owner',
    ]);
    expect(sqlOf(batch, '0003_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
    expect(sqlOf(batch, '0004_owner')).toBe('ALTER TABLE `sessions` ADD `owner` text;');
    expect(statusOf(pathOf(batch))).toBe('');
    expect(h.only(getBatch(h.store.db, batch.id).notices).body).toContain('0001_note → 0003_note');
  });

  describe('a migration regenerated under the same name', () => {
    const TAG = "  tag: text('tag'),";
    const first: Step = { name: 'owner', schema: schemaFile({ columns: [NOTE, OWNER] }) };
    const again: Step = {
      name: 'owner',
      schema: schemaFile({ columns: [NOTE, TAG] }),
      redo: true,
    };

    it('is stepped from the schema of its last regeneration, not its first', async () => {
      const batch = await bothSidesAdded([addNote, first, again], addLogs);

      expect((await update(batch)).kind).toBe('merged');

      expect(h.cards()).toEqual([]);
      expect(journalOf(batch)).toEqual(['0000_init', '0001_logs', '0002_note', '0003_owner']);
      expect(sqlOf(batch, '0002_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
      expect(sqlOf(batch, '0003_owner')).toBe('ALTER TABLE `sessions` ADD `tag` text;');
      expect(statusOf(pathOf(batch))).toBe('');
    });

    it('is still skipped as a Regenerate commit by the second catch-up', async () => {
      const batch = await bothSidesAdded([addNote, first, again], addLogs);
      await update(batch);
      mainAdds({ name: 'shape', schema: schemaFile({ columns: [SHAPE], after: [LOGS] }) });

      expect((await update(batch)).kind).toBe('merged');

      expect(h.cards()).toEqual([]);
      expect(journalOf(batch)).toEqual([
        '0000_init',
        '0001_logs',
        '0002_shape',
        '0003_note',
        '0004_owner',
      ]);
      expect(sqlOf(batch, '0003_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
      expect(sqlOf(batch, '0004_owner')).toBe('ALTER TABLE `sessions` ADD `tag` text;');
      expect(statusOf(pathOf(batch))).toBe('');
    });

    it("is not taken for the branch's when the base once had a migration of that name", async () => {
      const batch = await bothSidesAdded([addNote, first], {
        name: 'owner',
        schema: schemaFile({ columns: [SHAPE] }),
      });

      expect((await update(batch)).kind).toBe('merged');

      expect(h.cards()).toEqual([]);
      expect(journalOf(batch)).toEqual(['0000_init', '0001_owner', '0002_note', '0003_owner']);
      expect(sqlOf(batch, '0001_owner')).toBe('ALTER TABLE `sessions` ADD `shape_id` text;');
      expect(sqlOf(batch, '0002_note')).toBe('ALTER TABLE `sessions` ADD `note` text;');
      expect(sqlOf(batch, '0003_owner')).toBe('ALTER TABLE `sessions` ADD `owner` text;');
      expect(statusOf(pathOf(batch))).toBe('');
    });
  });

  it('carries a custom migration between the two in its place, byte for byte', async () => {
    const backfill = "UPDATE sessions SET note = 'x';\n";
    const batch = await bothSidesAdded(
      [addNote, { name: 'note_backfill', schema: addNote.schema, sql: backfill }, addOwner],
      addLogs,
    );

    await update(batch);

    expect(h.cards()).toEqual([]);
    expect(journalOf(batch)).toEqual([
      '0000_init',
      '0001_logs',
      '0002_note',
      '0003_note_backfill',
      '0004_owner',
    ]);
    expect(sqlOf(batch, '0003_note_backfill')).toBe(backfill);
    expect(sqlOf(batch, '0004_owner')).toBe('ALTER TABLE `sessions` ADD `owner` text;');
    expect(statusOf(pathOf(batch))).toBe('');
  });

  it("puts the schema file back and commits nothing when a step's generate fails", async () => {
    const batch = await bothSidesAdded([addNote, addOwner], addLogs);

    expect((await update(batch, 'owner')).kind).toBe('uncarried');

    expect(statusOf(pathOf(batch))).toBe('');
    expect(readFileSync(join(pathOf(batch), SCHEMA), 'utf8')).toBe(
      schemaFile({ columns: [NOTE, OWNER], after: [LOGS] }),
    );
    expect(existsSync(join(pathOf(batch), DB, '0002_note.sql'))).toBe(false);
    expect(h.only(h.cards()).body).toContain('0002_owner');
  });

  it('commits nothing and names the step when it changed what main changed another way', async () => {
    // The batch's second step undoes its first, so git merges the schema file with no conflict and
    // only the first step meets main's change.
    const withDefault = (value: string): string =>
      schemaFile({ workstream: WORKSTREAM.replace('),', `).default('${value}'),`) });
    const batch = await bothSidesAdded(
      [
        { name: 'default', schema: withDefault('mine') },
        { name: 'owner', schema: schemaFile({ columns: [OWNER] }) },
      ],
      { name: 'theirs', schema: withDefault('theirs') },
    );

    expect((await update(batch)).kind).toBe('uncarried');

    expect(statusOf(pathOf(batch))).toBe('');
    const card = h.only(h.cards());
    expect(card.body).toContain('0001_default');
    expect(card.body).toContain('both sides changed tables.sessions.columns.workstream_id.default');
  });

  it('commits nothing and names the second when main already made its change', async () => {
    const batch = await bothSidesAdded(
      [
        { name: 'shape', schema: schemaFile({ columns: [SHAPE] }) },
        { name: 'owner', schema: schemaFile({ columns: [SHAPE, OWNER] }) },
      ],
      { name: 'owner_too', schema: schemaFile({ columns: [OWNER] }) },
    );

    expect((await update(batch)).kind).toBe('uncarried');

    expect(statusOf(pathOf(batch))).toBe('');
    const card = h.only(h.cards());
    expect(card.body).toContain('0002_owner');
    expect(card.body).toContain('made no migration');
  });
});
