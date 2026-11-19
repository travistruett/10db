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
import { pathOf } from '../../test/delivery-worlds';
import { DRIZZLE_CONFIG, drizzleGenerate } from '../../test/drizzle-kit';
import { isolatedGitEnv } from '../../test/fixtures';
import type { DeliveryContext } from './context';
import { createBaseUpdates } from './index';
import { NOTICE_KEY, uncarriedIn } from './notices';

/** What one harness boot and its carry may take; a test that boots more is given this for each. */
const BOOT_TIMEOUT = 120_000;
vi.setConfig({ testTimeout: BOOT_TIMEOUT });

const PACKAGE = 'packages/db';
const SCHEMA = `${PACKAGE}/src/schema.ts`;
const DB = `${PACKAGE}/drizzle`;
const JOURNAL = `${DB}/meta/_journal.json`;
const signal = new AbortController().signal;

/** The notice that a failed regeneration leaves on the batch, which asks nothing. */
const regenerateNotice = (batchId: BatchDto['id']): BatchDto['notices'][number] =>
  h.only(getBatch(h.store.db, batchId).notices.filter((n) => n.key === NOTICE_KEY.baseRegenerate));

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

const ADD_OWNER = 'ALTER TABLE `sessions` ADD `owner` text;';
const ADD_NOTE = 'ALTER TABLE `sessions` ADD `note` text;';
const ADD_SHAPE = 'ALTER TABLE `sessions` ADD `shape_id` text;';

const addNote: Step = { name: 'note', schema: schemaFile({ columns: [NOTE] }) };
const addOwner: Step = { name: 'owner', schema: schemaFile({ columns: [NOTE, OWNER] }) };
const addLogs: Step = { name: 'logs', schema: schemaFile({ after: [LOGS] }) };
/** What main adds for a second catch-up, after `addLogs`. */
const addShapeAfterLogs: Step = {
  name: 'shape',
  schema: schemaFile({ columns: [SHAPE], after: [LOGS] }),
};

/** What one catch-up leaves: the journal, the SQL of some of its migrations, and what it was told. */
interface Carried {
  readonly journal: readonly string[];
  readonly sql: Readonly<Record<string, string>>;
  /** The schema file as merged, which the steps put back. */
  readonly schema?: string;
  /** What the renumbered notice says, its only notice. */
  readonly renamed?: readonly string[];
}

/** A batch whose `steps` main's `theirs` (and then `more`) passes; each catch-up merges with no card. */
interface Carry extends Carried {
  readonly name: string;
  readonly steps: readonly Step[];
  readonly theirs: Step;
  readonly oneCommit?: boolean;
  readonly more?: Step;
  /** A second catch-up, after main adds `step`. */
  readonly again?: Carried & { readonly step: Step };
}

/** Checks one catch-up of the batch against what `carried` says it leaves. */
async function caughtUp(batch: BatchDto, label: string, carried: Carried): Promise<void> {
  expect.soft((await update(batch)).kind, label).toBe('merged');
  expect.soft(h.cards(), label).toEqual([]);
  expect.soft(journalOf(batch), label).toEqual(carried.journal);
  for (const [tag, sql] of Object.entries(carried.sql))
    expect.soft(sqlOf(batch, tag), `${label}: ${tag}`).toBe(sql);
  expect.soft(statusOf(pathOf(batch)), label).toBe('');
  if (carried.schema !== undefined)
    expect.soft(readFileSync(join(pathOf(batch), SCHEMA), 'utf8'), label).toBe(carried.schema);
  if (carried.renamed === undefined) return;
  const notice = h.only(getBatch(h.store.db, batch.id).notices);
  for (const renamed of carried.renamed) expect.soft(notice.body, label).toContain(renamed);
}

/** Runs each carry on a harness and scratch directory of its own. */
async function carries(rows: readonly Carry[]): Promise<void> {
  await eachOnItsOwn(rows, async (row) => {
    const batch = await bothSidesAdded(row.steps, row.theirs, {
      oneCommit: row.oneCommit ?? false,
    });
    if (row.more) mainAdds(row.more);
    await caughtUp(batch, row.name, row);
    if (!row.again) return;
    mainAdds(row.again.step);
    await caughtUp(batch, `${row.name}, second catch-up`, row.again);
  });
}

function boot(): void {
  scratch = mkdtempSync(join(tmpdir(), 'migration-steps-'));
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
}

function shutDown(): void {
  h.close();
  rmSync(scratch, { recursive: true, force: true });
}

/** Runs `run` for each row on a harness and scratch directory of its own; afterEach ends the last. */
async function eachOnItsOwn<T>(rows: readonly T[], run: (row: T) => Promise<void>): Promise<void> {
  for (const [i, row] of rows.entries()) {
    if (i > 0) {
      shutDown();
      boot();
    }
    await run(row);
  }
}

describe('carrying a branch with several generated migrations over, each as its own step', () => {
  beforeEach(boot);
  afterEach(shutDown);

  it(
    "keeps the batch's after main's, under their names, with main's change in each, through a second catch-up",
    { timeout: BOOT_TIMEOUT * 4 },
    async () => {
      const bothKept: Omit<Carry, 'name' | 'oneCommit'> = {
        steps: [addNote, addOwner],
        theirs: addLogs,
        journal: ['0000_init', '0001_logs', '0002_note', '0003_owner'],
        sql: { '0002_note': ADD_NOTE, '0003_owner': ADD_OWNER },
        // The schema file the steps used is the merge's again.
        schema: schemaFile({ columns: [NOTE, OWNER], after: [LOGS] }),
        renamed: ['0001_note → 0002_note', '0002_owner → 0003_owner'],
        again: {
          step: addShapeAfterLogs,
          journal: ['0000_init', '0001_logs', '0002_shape', '0003_note', '0004_owner'],
          sql: { '0003_note': ADD_NOTE, '0004_owner': ADD_OWNER },
          renamed: ['0001_note → 0003_note'],
        },
      };
      const backfill = "UPDATE sessions SET note = 'x';\n";
      await carries([
        { name: 'a commit each', oneCommit: false, ...bothKept },
        { name: 'both in one commit', oneCommit: true, ...bothKept },
        {
          name: 'main added its column at the very spot the batch added its own',
          steps: [addNote, addOwner],
          theirs: { name: 'shape', schema: schemaFile({ columns: [SHAPE] }) },
          journal: ['0000_init', '0001_shape', '0002_note', '0003_owner'],
          sql: { '0002_note': ADD_NOTE, '0003_owner': ADD_OWNER },
        },
        {
          name: 'a custom migration between the two, carried in its place byte for byte',
          steps: [
            addNote,
            { name: 'note_backfill', schema: addNote.schema, sql: backfill },
            addOwner,
          ],
          theirs: addLogs,
          journal: ['0000_init', '0001_logs', '0002_note', '0003_note_backfill', '0004_owner'],
          sql: { '0003_note_backfill': backfill, '0004_owner': ADD_OWNER },
        },
      ]);
    },
  );

  it(
    "splits a pair split in two on purpose into two again, so the rebuild's copy of the new column applies on a seeded database",
    { timeout: BOOT_TIMEOUT * 2 },
    async () => {
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

      await eachOnItsOwn(
        [
          { name: 'a commit each', oneCommit: false },
          { name: 'one commit', oneCommit: true },
        ],
        async ({ name, oneCommit }) => {
          const batch = await bothSidesAdded(
            [addColumn, rebuild],
            { name: 'note', schema: schemaFile({ top: [NOTE] }) },
            { oneCommit },
          );

          expect.soft((await update(batch)).kind, name).toBe('merged');

          expect.soft(h.cards(), name).toEqual([]);
          expect
            .soft(journalOf(batch), name)
            .toEqual(['0000_init', '0001_note', '0002_shape_column', '0003_rebuild']);
          expect.soft(sqlOf(batch, '0002_shape_column'), name).toBe(ADD_SHAPE);
          expect.soft(sqlOf(batch, '0003_rebuild'), name).toContain('__new_sessions');
          expect.soft(sqlOf(batch, '0003_rebuild'), name).toContain('`note`');
          expect
            .soft(applied(batch, seed, read), name)
            .toEqual([{ id: 's1', workstream_id: 'w1', shape_id: null, note: null }]);
        },
      );
    },
  );

  describe('a migration regenerated under the same name', () => {
    const TAG = "  tag: text('tag'),";
    const ADD_TAG = 'ALTER TABLE `sessions` ADD `tag` text;';
    const addedOwner: Step = { name: 'owner', schema: schemaFile({ columns: [OWNER] }) };
    // Only a migration with a generated one after it is made from its own step: the last is made
    // from the schema file as merged. So here the regenerated one is never the last.
    const steps: readonly Step[] = [
      addedOwner,
      { name: 'owner', schema: schemaFile({ columns: [TAG] }), redo: true },
      { name: 'note', schema: schemaFile({ columns: [TAG, NOTE] }) },
    ];
    const addedNoteAfter: Step = {
      name: 'note',
      schema: schemaFile({ columns: [OWNER, NOTE] }),
    };
    const baseOwner: Step = { name: 'owner', schema: schemaFile({ columns: [SHAPE] }) };
    const x: Step = { name: 'x', schema: schemaFile({ top: [TAG] }) };
    const baseOwnerAfterX: Step = {
      name: 'owner',
      schema: schemaFile({ top: [TAG], columns: [SHAPE] }),
    };

    it(
      "is stepped from its last regeneration, skipped as a Regenerate commit later, never taken for the base's of that name, and re-created beside the base's very tag",
      { timeout: BOOT_TIMEOUT * 5 },
      async () => {
        await carries([
          {
            name: 'stepped from the schema of its last regeneration, not its first',
            steps,
            theirs: addLogs,
            journal: ['0000_init', '0001_logs', '0002_owner', '0003_note'],
            sql: { '0002_owner': ADD_TAG, '0003_note': ADD_NOTE },
            again: {
              // Still skipped as a Regenerate commit by the second catch-up.
              step: addShapeAfterLogs,
              journal: ['0000_init', '0001_logs', '0002_shape', '0003_owner', '0004_note'],
              sql: { '0003_owner': ADD_TAG, '0004_note': ADD_NOTE },
            },
          },
          {
            name: "not taken for the base's migration of that name under another number",
            steps: [addedOwner, addedNoteAfter],
            theirs: x,
            more: baseOwnerAfterX,
            journal: ['0000_init', '0001_x', '0002_owner', '0003_owner', '0004_note'],
            sql: { '0002_owner': ADD_SHAPE, '0003_owner': ADD_OWNER, '0004_note': ADD_NOTE },
          },
          {
            name: "re-created when the base's has its very tag and it is the batch's last",
            steps: [addNote, addOwner],
            theirs: x,
            more: baseOwnerAfterX,
            journal: ['0000_init', '0001_x', '0002_owner', '0003_note', '0004_owner'],
            sql: { '0002_owner': ADD_SHAPE, '0003_note': ADD_NOTE, '0004_owner': ADD_OWNER },
          },
          {
            name: "re-created when the base's has its very tag and another comes after it",
            steps: [addedOwner, addedNoteAfter],
            theirs: baseOwner,
            journal: ['0000_init', '0001_owner', '0002_owner', '0003_note'],
            sql: { '0001_owner': ADD_SHAPE, '0002_owner': ADD_OWNER, '0003_note': ADD_NOTE },
          },
          {
            name: 'the base’s when both sides made the same migration under the same tag',
            steps: [addedOwner, addedNoteAfter],
            theirs: addedOwner,
            journal: ['0000_init', '0001_owner', '0002_note'],
            sql: { '0001_owner': ADD_OWNER, '0002_note': ADD_NOTE },
          },
        ]);
      },
    );

    it("stays stopped after a carry that failed until the batch's own is back, beside the base's", async () => {
      const batch = await bothSidesAdded([addedOwner], baseOwner);

      expect((await update(batch, 'owner')).kind).toBe('uncarried');
      // The journal holds the name, but only as the base's.
      expect((await update(batch)).kind).toBe('uncarried');

      drizzleGenerate(join(pathOf(batch), PACKAGE), 'owner', false);
      await commitOnBatch(
        batch,
        new Map(
          [JOURNAL, `${DB}/0002_owner.sql`, `${DB}/meta/0002_snapshot.json`].map((path) => [
            path,
            readFileSync(join(pathOf(batch), path), 'utf8'),
          ]),
        ),
      );

      expect((await update(batch)).kind).toBe('up_to_date');
    });
  });

  describe('a carry that fails on a later migration than a contested one', () => {
    const ADD_SHAPE_COLUMN: Step = { name: 'owner', schema: schemaFile({ columns: [SHAPE] }) };
    const ownerThenNote: readonly Step[] = [
      { name: 'owner', schema: schemaFile({ columns: [OWNER] }) },
      { name: 'note', schema: schemaFile({ columns: [OWNER, NOTE] }) },
    ];
    const lostTags = (batch: BatchDto): string[] =>
      uncarriedIn(
        getBatch(h.store.db, batch.id).notices.find(
          (n) => n.key === NOTICE_KEY.migrationsUncarried,
        ),
      )?.map((m) => m.tag) ?? [];

    it('names the contested migration when the carry never starts, the later one being unreadable', async () => {
      const batch = await bothSidesAdded(ownerThenNote, ADD_SHAPE_COLUMN);
      await commitOnBatch(batch, new Map([[`${DB}/meta/0002_snapshot.json`, 'not a snapshot\n']]));

      expect((await update(batch)).kind).toBe('uncarried');

      expect(lostTags(batch)).toEqual(['0001_owner', '0002_note']);
    });

    it("names the contested migration too, not only the one it stopped at, and clears it only once the journal holds it beyond the base's", async () => {
      const batch = await bothSidesAdded(ownerThenNote, ADD_SHAPE_COLUMN);

      expect((await update(batch, 'note')).kind).toBe('uncarried');

      expect(lostTags(batch)).toEqual(['0001_owner', '0002_note']);

      // The stopped one is made, but the contested name is still only the base's.
      drizzleGenerate(join(pathOf(batch), PACKAGE), 'note', false);
      await commitOnBatch(
        batch,
        new Map(
          [JOURNAL, `${DB}/0002_note.sql`, `${DB}/meta/0002_snapshot.json`].map((path) => [
            path,
            readFileSync(join(pathOf(batch), path), 'utf8'),
          ]),
        ),
      );
      expect((await update(batch)).kind).toBe('uncarried');
      expect(lostTags(batch)).toEqual(['0001_owner']);
    });
  });

  it("puts the schema file back and commits nothing when a step's generate fails", async () => {
    const batch = await bothSidesAdded([addNote, addOwner], addLogs);

    expect((await update(batch, 'owner')).kind).toBe('uncarried');

    expect(statusOf(pathOf(batch))).toBe('');
    expect(readFileSync(join(pathOf(batch), SCHEMA), 'utf8')).toBe(
      schemaFile({ columns: [NOTE, OWNER], after: [LOGS] }),
    );
    expect(existsSync(join(pathOf(batch), DB, '0002_note.sql'))).toBe(false);
    expect(h.cards()).toEqual([]);
    expect(regenerateNotice(batch.id).body).toContain('0002_owner');
  });

  it(
    'commits nothing and names the step that changed what main changed another way, or that main already made',
    { timeout: BOOT_TIMEOUT * 2 },
    async () => {
      // The batch's second step undoes its first, so git merges the schema file with no conflict and
      // only the first step meets main's change.
      const withDefault = (value: string): string =>
        schemaFile({ workstream: WORKSTREAM.replace('),', `).default('${value}'),`) });
      await eachOnItsOwn(
        [
          {
            name: 'changed another way',
            steps: [
              { name: 'default', schema: withDefault('mine') },
              { name: 'owner', schema: schemaFile({ columns: [OWNER] }) },
            ],
            theirs: { name: 'theirs', schema: withDefault('theirs') },
            said: [
              '0001_default',
              'both sides changed tables.sessions.columns.workstream_id.default',
            ],
          },
          {
            name: 'already made by main',
            steps: [
              { name: 'shape', schema: schemaFile({ columns: [SHAPE] }) },
              { name: 'owner', schema: schemaFile({ columns: [SHAPE, OWNER] }) },
            ],
            theirs: { name: 'owner_too', schema: schemaFile({ columns: [OWNER] }) },
            said: ['0002_owner', 'made no migration'],
          },
        ],
        async ({ name, steps, theirs, said }) => {
          const batch = await bothSidesAdded(steps, theirs);

          expect.soft((await update(batch)).kind, name).toBe('uncarried');

          expect.soft(statusOf(pathOf(batch)), name).toBe('');
          expect.soft(h.cards(), name).toEqual([]);
          const card = regenerateNotice(batch.id);
          for (const text of said) expect.soft(card.body, name).toContain(text);
        },
      );
    },
  );
});
