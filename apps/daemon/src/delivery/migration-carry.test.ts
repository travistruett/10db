import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchProject, patchWorkstream, setBatchNotice } from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import type { DeliveryContext } from './context';
import { createBaseUpdates } from './index';
import { addedTags } from './migration-carry';
import { NOTICE_KEY } from './notices';
import type { CarriedMigration } from './worktree-generated';

vi.setConfig({ testTimeout: 120_000 });

const DB = 'packages/db/drizzle';
const JOURNAL = `${DB}/meta/_journal.json`;
const CUSTOM_STUB = '-- Custom SQL migration file, put your code below! --\n';
const signal = new AbortController().signal;

let h: DeliveryHarness;

const journal = (...tags: string[]): string =>
  `${JSON.stringify({
    version: '7',
    dialect: 'sqlite',
    entries: tags.map((tag, idx) => ({ idx, version: '6', when: idx, tag, breakpoints: true })),
  })}\n`;

/** A drizzle snapshot whose schema is `tables`, under an id of its own, as `generate` writes it. */
const snapshot = (id: string, ...tables: string[]): string =>
  `${JSON.stringify({ id, prevId: `before-${id}`, version: '6', tables })}\n`;

const headOf = (dir: string): string =>
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { env: isolatedGitEnv() })
    .toString()
    .trim();

const statusOf = (dir: string): string =>
  execFileSync('git', ['-C', dir, 'status', '--porcelain', '--untracked-files=all'], {
    env: isolatedGitEnv(),
  })
    .toString()
    .trim();

function pathOf(batch: BatchDto): string {
  if (batch.worktreePath === null) throw new Error('the batch has no worktree');
  return batch.worktreePath;
}

let commits = 0;

async function commitOnBatch(batch: BatchDto, file: string, content: string | Buffer) {
  commits += 1;
  const target = join(pathOf(batch), file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  await h.git.commit({
    repo: pathOf(batch),
    paths: [file],
    message: `Add ${file}`,
    opId: `op-carry-${String(commits)}`,
    branch: batch.branch ?? '',
  });
}

/** Main holds `0000_init`, then the batch's `mine` and a teammate's `0001_theirs` land on each side. */
async function bothSidesAdded(
  mine: readonly { tag: string; sql: string | Buffer; custom?: boolean }[],
): Promise<BatchDto> {
  h = createDeliveryHarness({ workspaceMode: 'worktree' }, { trigger: false });
  h.commit(
    'packages/db/package.json',
    `${JSON.stringify({ name: '@10db/db', scripts: { generate: 'drizzle-kit generate' } })}\n`,
  );
  h.commit(JOURNAL, journal('0000_init'));
  h.commit(`${DB}/meta/0000_snapshot.json`, snapshot('s0', 'a'));
  h.commit(`${DB}/0000_init.sql`, 'create table a;\n');
  h.git$('push', '-q', 'origin', 'main');
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  const ws = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.state.write((c) => {
    patchWorkstream(c, ws.id, null, { baseHead: batch.baseSha ?? '' });
  });
  const tables = ['a'];
  const tags = ['0000_init'];
  for (const [i, { tag, sql, custom }] of mine.entries()) {
    if (custom !== true) tables.push(tag);
    tags.push(tag);
    await commitOnBatch(batch, `${DB}/${tag}.sql`, sql);
    await commitOnBatch(
      batch,
      `${DB}/meta/${tag.slice(0, 4)}_snapshot.json`,
      snapshot(`mine${String(i)}`, ...tables),
    );
    await commitOnBatch(batch, JOURNAL, journal(...tags));
  }
  h.teammatePush('main', `${DB}/0001_theirs.sql`, 'alter table a add c;\n');
  h.teammatePush('main', `${DB}/meta/0001_snapshot.json`, snapshot('theirs', 'a', 'c'));
  h.teammatePush('main', JOURNAL, journal('0000_init', '0001_theirs'));
  return batch;
}

/**
 * What the package's `generate` does in a worktree, at the process boundary: each step takes the next
 * free number, a custom one writes drizzle-kit's stub, and a generated one writes what the schema
 * adds. `migration-steps.test.ts` runs the real one.
 */
function drizzle(
  input: {
    calls?: (readonly CarriedMigration[])[];
    /** The name whose step stops the run, as a failed drizzle-kit exits non-zero. */
    failAt?: string;
    afterRun?: (path: string) => void;
  } = {},
): DeliveryContext['generators'] {
  return {
    regenerate: ({ path, migrations = [] }) => {
      input.calls?.push(migrations);
      const file = join(path, JOURNAL);
      const tags = (
        JSON.parse(readFileSync(file, 'utf8')) as { entries: { tag: string }[] }
      ).entries.map((e) => e.tag);
      for (const { name, custom } of migrations) {
        if (name === input.failAt)
          return Promise.resolve({
            kind: 'failed',
            exitCode: 1,
            timedOut: false,
            tail: 'drizzle-kit failed',
            logPath: join(path, 'generate.log'),
          });
        const number = String(tags.length).padStart(4, '0');
        const tag = `${number}_${name}`;
        tags.push(tag);
        writeFileSync(join(path, DB, `${tag}.sql`), custom ? CUSTOM_STUB : `-- made ${name}\n`);
        writeFileSync(join(path, DB, `meta/${number}_snapshot.json`), snapshot(tag, 'a', 'c'));
        writeFileSync(file, journal(...tags));
      }
      input.afterRun?.(path);
      return Promise.resolve({ kind: 'done', logPath: join(path, 'generate.log') });
    },
  };
}

describe('which files a merge dropped are migrations the branch added', () => {
  const ancestor = 'the-merge-base';
  const git = {
    mergeBase: () => Promise.resolve(ancestor),
    blobAt: (_repo: string, rev: string, file: string) =>
      Promise.resolve(rev === ancestor && file.endsWith('0000_old.sql') ? 'blob' : null),
  };

  it("leaves out what both sides had, such as a baseline the base regenerated, and what isn't a migration", async () => {
    expect(
      await addedTags(git, 'repo', 'tip', 'base', [
        `${DB}/0000_old.sql`,
        `${DB}/0001_mine.sql`,
        `${DB}/notes.sql`,
        `${DB}/meta/0001_snapshot.json`,
      ]),
    ).toEqual(['0001_mine']);
  });

  it('keeps them all when the histories share nothing', async () => {
    expect(
      await addedTags({ ...git, mergeBase: () => Promise.resolve(null) }, 'repo', 'tip', 'base', [
        `${DB}/0000_old.sql`,
      ]),
    ).toEqual(['0000_old']);
  });
});

describe('carrying a batch over when main and the batch both added migrations', () => {
  afterEach(() => {
    h.close();
  });

  it("keeps main's migrations and re-creates the branch's after them, under its name, with no card", async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const calls: (readonly CarriedMigration[])[] = [];
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ calls }),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('merged');
    expect(h.cards()).toEqual([]);
    expect(calls).toEqual([[{ tag: '0001_mine', name: 'mine', custom: false }]]);
    const path = pathOf(batch);
    expect(statusOf(path)).toBe('');
    expect(readFileSync(join(path, DB, '0000_init.sql'), 'utf8')).toBe('create table a;\n');
    expect(readFileSync(join(path, DB, '0001_theirs.sql'), 'utf8')).toBe('alter table a add c;\n');
    expect(existsSync(join(path, DB, '0001_mine.sql'))).toBe(false);
    expect(readFileSync(join(path, DB, '0002_mine.sql'), 'utf8')).toBe('-- made mine\n');
    expect(readFileSync(join(path, JOURNAL), 'utf8')).toBe(
      journal('0000_init', '0001_theirs', '0002_mine'),
    );
  });

  it("copies a --custom migration's SQL byte for byte, numbered after the migration it followed", async () => {
    // Not valid UTF-8, with no newline at the end: text handling would change these bytes.
    const sql = Buffer.concat([
      Buffer.from('-- backfill\r\nupdate a set b = 1; -- '),
      Buffer.from([0xff, 0xfe]),
    ]);
    const batch = await bothSidesAdded([
      { tag: '0001_mine', sql: 'alter table a add b;\n' },
      { tag: '0002_mine_backfill', sql, custom: true },
    ]);
    const calls: (readonly CarriedMigration[])[] = [];
    await createBaseUpdates({ ...h.ctx, generators: drizzle({ calls }) }).beforeGate(
      batch.id,
      signal,
    );

    expect(h.cards()).toEqual([]);
    expect(calls).toEqual([
      [
        { tag: '0001_mine', name: 'mine', custom: false },
        { tag: '0002_mine_backfill', name: 'mine_backfill', custom: true },
      ],
    ]);
    const path = pathOf(batch);
    expect(statusOf(path)).toBe('');
    expect(readFileSync(join(path, DB, '0003_mine_backfill.sql')).equals(sql)).toBe(true);
    expect(readFileSync(join(path, JOURNAL), 'utf8')).toBe(
      journal('0000_init', '0001_theirs', '0002_mine', '0003_mine_backfill'),
    );
  });

  it('commits nothing and names the migration on a card when its generate fails', async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine', sql: 'alter table a add b;\n' },
      { tag: '0002_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    const path = pathOf(batch);
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    }).beforeGate(batch.id, signal);

    if (update.kind !== 'uncarried') throw new Error(`uncarried expected, got ${update.kind}`);
    // The merge's head: no commit of regenerated files on top of it.
    expect(update.head).toBe(headOf(path));
    expect(
      execFileSync('git', ['-C', path, 'show', '-s', '--format=%P', 'HEAD'], {
        env: isolatedGitEnv(),
      })
        .toString()
        .trim()
        .split(' '),
    ).toHaveLength(2);
    expect(statusOf(path)).toBe('');
    expect(existsSync(join(path, DB, '0002_mine.sql'))).toBe(false);
    const card = h.only(h.cards());
    expect(card.body).toContain('0002_mine_backfill');
    expect(card.body).not.toContain('`0001_mine`');
    // Nothing renumbered: all the lane hears is what the merge lost, the migration before it included.
    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice.key).toBe(NOTICE_KEY.migrationsUncarried);
    expect(notice.body).toContain('0001_mine');
    expect(notice.body).toContain('0002_mine_backfill');
    expect(update.note).toContain('0002_mine_backfill');
  });

  it('stops the gate for a custom migration alone, whose loss no snapshot would show', async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(h.only(h.cards()).body).toContain('0001_mine_backfill');
  });

  it('refuses every later gate until the branch holds the migration again, then clears what it said', async () => {
    const sql = 'update a;\n';
    const batch = await bothSidesAdded([{ tag: '0001_mine_backfill', sql, custom: true }]);
    const updates = createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    });
    await updates.beforeGate(batch.id, signal);

    const again = await updates.beforeGate(batch.id, signal);
    if (again.kind !== 'uncarried') throw new Error(`uncarried expected, got ${again.kind}`);
    expect(again.note).toContain('0001_mine_backfill');
    expect(again.head).toBe(headOf(pathOf(batch)));
    expect(h.cards()).toHaveLength(1);

    // The lane re-creates it after main's, under its name.
    await commitOnBatch(batch, `${DB}/0002_mine_backfill.sql`, sql);
    await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_theirs', '0002_mine_backfill'));
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('up_to_date');
    expect(h.cards()).toEqual([]);
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });

  it.each([
    ['has no record', undefined],
    ['has a record that is not JSON', 'not json'],
    ['has a record that is not a list of migrations', '[{"nope":1}]'],
  ])(
    'does not clear a lost-migrations notice that %s, and says its list could not be read',
    async (_what, record) => {
      const batch = await bothSidesAdded([
        { tag: '0001_mine_backfill', sql: 'update a;\n', custom: true },
      ]);
      const updates = createBaseUpdates({
        ...h.ctx,
        generators: drizzle({ failAt: 'mine_backfill' }),
      });
      await updates.beforeGate(batch.id, signal);
      // As fitNotice leaves a notice whose record was too long, or a malformed record would.
      const stored = h.only(getBatch(h.store.db, batch.id).notices);
      const bare = { key: stored.key, tone: stored.tone, line: stored.line, body: stored.body };
      h.state.write((w) => {
        setBatchNotice(w, batch.id, record === undefined ? bare : { ...bare, record });
      });

      const again = await updates.beforeGate(batch.id, signal);

      if (again.kind !== 'uncarried') throw new Error(`uncarried expected, got ${again.kind}`);
      expect(again.note).toContain('could not be read');
      expect(again.head).toBe(headOf(pathOf(batch)));
      expect(h.cards()).toHaveLength(1);
      expect(h.only(getBatch(h.store.db, batch.id).notices).key).toBe(
        NOTICE_KEY.migrationsUncarried,
      );
    },
  );

  it('keeps refusing while one migration is back and another is not, and names only that one', async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine', sql: 'alter table a add b;\n' },
      { tag: '0002_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    const updates = createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    });
    await updates.beforeGate(batch.id, signal);
    await commitOnBatch(batch, `${DB}/0002_mine.sql`, 'alter table a add b;\n');
    await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_theirs', '0002_mine'));

    const update = await updates.beforeGate(batch.id, signal);

    if (update.kind !== 'uncarried') throw new Error(`uncarried expected, got ${update.kind}`);
    expect(update.note).toContain('0002_mine_backfill');
    expect(update.note).not.toContain('0001_mine ');
    expect(h.only(getBatch(h.store.db, batch.id).notices).body).not.toContain('0001_mine ');
  });

  it('stops the gate when the install fails, so the generators never ran', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
    const update = await createBaseUpdates({
      ...h.ctx,
      dependencies: { refresh: () => Promise.reject(new Error('the install blew up')) },
      generators: drizzle(),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it('stops the gate when the generators throw', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: { regenerate: () => Promise.reject(new Error('no sandbox')) },
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it('does not ship a batch whose only migration is custom when the shipping gate could not carry it', async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    const failing = drizzle({ failAt: 'mine_backfill' });
    vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation((input) =>
      failing.regenerate(input),
    );
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: batch.id })).id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id)).toMatchObject({
      state: 'FAILED',
      failure: 'base_conflict',
    });
    expect(h.origin$('for-each-ref', `refs/heads/${batch.branch ?? ''}`)).toBe('');
    const card = h.only(h.cards());
    expect(card.title).toContain('migration');
    expect(card.body).toContain('0001_mine_backfill');
    expect(card.body).toContain('Retry');
  });

  it("does not ship, with no gate to ask, what a lane's launch could not carry", async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
    await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    }).beforeGate(batch.id, signal, { atLaunch: true });
    h.settle(h.only(listWorkstreams(h.store.db, { batchId: batch.id })).id, 'DONE');
    h.shipper.checkBatch(batch.id);
    await h.jobs.idle();

    expect(getBatch(h.store.db, batch.id).state).toBe('FAILED');
    expect(h.origin$('for-each-ref', `refs/heads/${batch.branch ?? ''}`)).toBe('');
  });

  it("commits nothing and names the migration on a card when the schema of a step can't be told", async () => {
    // Two generated migrations, whose snapshots here hold no schema a step could be made from.
    const batch = await bothSidesAdded([
      { tag: '0001_mine', sql: 'alter table a add b;\n' },
      { tag: '0002_second', sql: 'alter table a add d;\n' },
    ]);
    const path = pathOf(batch);
    const calls: (readonly CarriedMigration[])[] = [];
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ calls }),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(calls).toEqual([]);
    expect(statusOf(path)).toBe('');
    expect(existsSync(join(path, DB, '0002_mine.sql'))).toBe(false);
    const card = h.only(h.cards());
    expect(card.body).toContain('0001_mine');
    expect(card.body).toContain('a schema for its step could not be made');
  });

  it('names what the merge dropped on the card when the run is stopped before it re-creates it', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const stop = new AbortController();
    await createBaseUpdates({
      ...h.ctx,
      generators: {
        regenerate: () => {
          stop.abort();
          return Promise.resolve({ kind: 'aborted' });
        },
      },
    }).beforeGate(batch.id, stop.signal);

    expect(h.only(h.cards()).body).toContain(`${DB}/0001_mine.sql`);
    // The merge stands, and the next gate finds the branch holding the base.
    expect((await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).kind).toBe('uncarried');
  });

  it('refuses a FIFO the generators left at a custom migration, without blocking on it', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'update a;\n', custom: true }]);
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({
        afterRun: (at) => {
          rmSync(join(at, DB, '0002_mine.sql'));
          execFileSync('mkfifo', [join(at, DB, '0002_mine.sql')]);
        },
      }),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it('refuses a FIFO the generators left at the journal, without blocking on it', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({
        afterRun: (at) => {
          rmSync(join(at, JOURNAL));
          execFileSync('mkfifo', [join(at, JOURNAL)]);
        },
      }),
    }).beforeGate(batch.id, signal);

    expect(update.kind).toBe('uncarried');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it('truncates nothing through a hard link the generators left at a custom migration', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'update a;\n', custom: true }]);
    const path = pathOf(batch);
    const outside = join(path, '..', 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    const update = await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({
        afterRun: (at) => {
          rmSync(join(at, DB, '0002_mine.sql'));
          linkSync(outside, join(at, DB, '0002_mine.sql'));
        },
      }),
    }).beforeGate(batch.id, signal);

    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    expect(update.kind).toBe('uncarried');
    expect(statusOf(path)).toBe('');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it("writes nothing through a link the generators left where a custom migration's SQL goes", async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'update a;\n', custom: true }]);
    const path = pathOf(batch);
    const outside = join(path, '..', 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    await createBaseUpdates({
      ...h.ctx,
      generators: drizzle({
        afterRun: (at) => {
          rmSync(join(at, DB, '0002_mine.sql'));
          symlinkSync(outside, join(at, DB, '0002_mine.sql'));
        },
      }),
    }).beforeGate(batch.id, signal);

    expect(readFileSync(outside, 'utf8')).toBe('untouched\n');
    expect(statusOf(path)).toBe('');
    expect(h.only(h.cards()).body).toContain('0001_mine');
  });

  it('tells the batch which migrations were renumbered and to what, and leaves docs to its lane', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const update = await createBaseUpdates({ ...h.ctx, generators: drizzle() }).beforeGate(
      batch.id,
      signal,
    );

    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice.key).toBe(NOTICE_KEY.migrationsRenumbered);
    expect(notice.body).toContain('0001_mine → 0002_mine');
    expect(notice.body).toContain("Docs that name a renumbered migration are the lane's to fix");
    if (update.kind !== 'merged') throw new Error(`merged expected, got ${update.kind}`);
    expect(update.note).toContain('0001_mine → 0002_mine');
  });

  it('adds what a later catch-up renumbered to what the batch was told, following a migration moved twice', async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const updates = createBaseUpdates({ ...h.ctx, generators: drizzle() });
    await updates.beforeGate(batch.id, signal);
    h.teammatePush('main', `${DB}/0002_again.sql`, 'alter table a add e;\n');
    h.teammatePush('main', `${DB}/meta/0002_snapshot.json`, snapshot('again', 'a', 'c', 'e'));
    h.teammatePush('main', JOURNAL, journal('0000_init', '0001_theirs', '0002_again'));
    await updates.beforeGate(batch.id, signal);

    expect(h.cards()).toEqual([]);
    expect(existsSync(join(pathOf(batch), DB, '0003_mine.sql'))).toBe(true);
    const notice = h.only(getBatch(h.store.db, batch.id).notices);
    expect(notice.body).toContain('0001_mine → 0003_mine');
    expect(notice.body).not.toContain('0002_mine');
  });
});
