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
import { BuilderOwns, type BatchDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchProject, patchWorkstream, setBatchNotice } from '@10db/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { pathOf } from '../../test/delivery-worlds';
import { isolatedGitEnv } from '../../test/fixtures';
import { createInboxService, decidedByBuilder } from '../inbox';
import { LOST_MIGRATIONS_DETAIL, LostChoice } from './cards';
import type { DeliveryContext } from './context';
import { createBaseUpdates, createLostMigrationsAnswers } from './index';
import { addedTags } from './migration-carry';
import { NOTICE_KEY, uncarriedSaid } from './notices';
import type { CarriedMigration } from './worktree-generated';

/** What one harness boot and its carry may take; a test that boots more is given this for each. */
const BOOT_TIMEOUT = 120_000;
vi.setConfig({ testTimeout: BOOT_TIMEOUT });

const DB = 'packages/db/drizzle';
const JOURNAL = `${DB}/meta/_journal.json`;
const CUSTOM_STUB = '-- Custom SQL migration file, put your code below! --\n';
const signal = new AbortController().signal;

let h: DeliveryHarness;

/** What a batch's tasks were told about its migrations, apart from the regenerate notice. */
const lostNotices = (batchId: BatchDto['id']): BatchDto['notices'] =>
  getBatch(h.store.db, batchId).notices.filter((n) => n.key !== NOTICE_KEY.baseRegenerate);
/** The notice that a failed regeneration leaves on the batch, which asks nothing. */
const regenerateNotice = (batchId: BatchDto['id']): BatchDto['notices'][number] =>
  h.only(getBatch(h.store.db, batchId).notices.filter((n) => n.key === NOTICE_KEY.baseRegenerate));

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

/** Runs `run` for each row, whose `bothSidesAdded` boots a harness of its own; afterEach ends the last. */
async function eachOnItsOwn<T>(rows: readonly T[], run: (row: T) => Promise<void>): Promise<void> {
  for (const [i, row] of rows.entries()) {
    if (i > 0) h.close();
    await run(row);
  }
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

  it("leaves out what both sides had, such as a baseline the base regenerated, and what isn't a migration, unless the histories share nothing", async () => {
    expect
      .soft(
        await addedTags(git, 'repo', 'tip', 'base', [
          `${DB}/0000_old.sql`,
          `${DB}/0001_mine.sql`,
          `${DB}/notes.sql`,
          `${DB}/meta/0001_snapshot.json`,
        ]),
        'a common ancestor',
      )
      .toEqual(['0001_mine']);
    expect
      .soft(
        await addedTags({ ...git, mergeBase: () => Promise.resolve(null) }, 'repo', 'tip', 'base', [
          `${DB}/0000_old.sql`,
        ]),
        'no common ancestor',
      )
      .toEqual(['0000_old']);
  });
});

describe('carrying a batch over when main and the batch both added migrations', () => {
  afterEach(() => {
    h.close();
  });

  it("keeps main's migrations, re-creates the branch's after them under its name with no card, tells the batch what was renumbered, and adds what a later catch-up renumbered", async () => {
    const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
    const calls: (readonly CarriedMigration[])[] = [];
    const updates = createBaseUpdates({ ...h.ctx, generators: drizzle({ calls }) });
    const update = await updates.beforeGate(batch.id, signal);

    if (update.kind !== 'merged') throw new Error(`merged expected, got ${update.kind}`);
    expect(update.note).toContain('0001_mine → 0002_mine');
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
    const renumbered = h.only(lostNotices(batch.id));
    expect(renumbered.key).toBe(NOTICE_KEY.migrationsRenumbered);
    expect(renumbered.body).toContain('0001_mine → 0002_mine');
    expect(renumbered.body).toContain(
      "Docs that name a renumbered migration are the lane's to fix",
    );

    // A later catch-up moves it again; the notice follows it from where it started.
    h.teammatePush('main', `${DB}/0002_again.sql`, 'alter table a add e;\n');
    h.teammatePush('main', `${DB}/meta/0002_snapshot.json`, snapshot('again', 'a', 'c', 'e'));
    h.teammatePush('main', JOURNAL, journal('0000_init', '0001_theirs', '0002_again'));
    await updates.beforeGate(batch.id, signal);

    expect(h.cards()).toEqual([]);
    expect(existsSync(join(path, DB, '0003_mine.sql'))).toBe(true);
    const moved = h.only(lostNotices(batch.id));
    expect(moved.body).toContain('0001_mine → 0003_mine');
    expect(moved.body).not.toContain('0002_mine');
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

  it('commits nothing and names the migration on a notice when its generate fails, refuses the answer for a notice whose list reads, and keeps refusing while one migration is back and another is not, naming only that one', async () => {
    const batch = await bothSidesAdded([
      { tag: '0001_mine', sql: 'alter table a add b;\n' },
      { tag: '0002_mine_backfill', sql: 'update a;\n', custom: true },
    ]);
    const path = pathOf(batch);
    const updates = createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    });
    const update = await updates.beforeGate(batch.id, signal);

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
    const regenerate = regenerateNotice(batch.id);
    expect(regenerate.body).toContain('0002_mine_backfill');
    expect(regenerate.body).not.toContain('`0001_mine`');
    // Nothing renumbered: all the lane hears is what the merge lost, the migration before it included.
    const notice = h.only(lostNotices(batch.id));
    expect(notice.key).toBe(NOTICE_KEY.migrationsUncarried);
    expect(notice.body).toContain('0001_mine');
    expect(notice.body).toContain('0002_mine_backfill');
    expect(update.note).toContain('0002_mine_backfill');

    // A readable notice has no card with the answer; a card from before it was read is made by hand.
    const inbox = createInboxService({
      state: h.state,
      onParkedAnswer: () => undefined,
      onFlagAnswer: createLostMigrationsAnswers(h.ctx),
    });
    const flagged = inbox.flag({
      tier: 'ask',
      urgency: 'high',
      closesWhen: { by: 'answer' },
      decision: decidedByBuilder(BuilderOwns.OneWayDoor),
      projectId: h.project.id,
      workstreamId: null,
      title: 'Clear',
      body: 'Clear',
      detail: { [LOST_MIGRATIONS_DETAIL]: { batchId: batch.id } },
      options: [{ label: LostChoice.Clear, description: 'Clear' }],
    });
    expect(() => inbox.answer(flagged.id, { choice: LostChoice.Clear })).toThrow();
    expect(h.only(lostNotices(batch.id))).toEqual(notice);

    // The lane re-creates the generated one; the custom one is still lost.
    await commitOnBatch(batch, `${DB}/0002_mine.sql`, 'alter table a add b;\n');
    await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_theirs', '0002_mine'));

    const still = await updates.beforeGate(batch.id, signal);

    if (still.kind !== 'uncarried') throw new Error(`uncarried expected, got ${still.kind}`);
    expect(still.note).toContain('0002_mine_backfill');
    expect(still.note).not.toContain('0001_mine ');
    expect(h.only(lostNotices(batch.id)).body).not.toContain('0001_mine ');
  });

  it('stops the gate for a custom migration alone, whose loss no snapshot would show, and refuses every later gate until the branch holds the migration again, then clears what it said', async () => {
    const sql = 'update a;\n';
    const batch = await bothSidesAdded([{ tag: '0001_mine_backfill', sql, custom: true }]);
    const updates = createBaseUpdates({
      ...h.ctx,
      generators: drizzle({ failAt: 'mine_backfill' }),
    });
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('uncarried');
    expect(regenerateNotice(batch.id).body).toContain('0001_mine_backfill');

    const again = await updates.beforeGate(batch.id, signal);
    if (again.kind !== 'uncarried') throw new Error(`uncarried expected, got ${again.kind}`);
    expect(again.note).toContain('0001_mine_backfill');
    expect(again.head).toBe(headOf(pathOf(batch)));
    expect(regenerateNotice(batch.id).key).toBe(NOTICE_KEY.baseRegenerate);

    // The lane re-creates it after main's, under its name.
    await commitOnBatch(batch, `${DB}/0002_mine_backfill.sql`, sql);
    await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_theirs', '0002_mine_backfill'));
    expect((await updates.beforeGate(batch.id, signal)).kind).toBe('up_to_date');
    expect(h.cards()).toEqual([]);
    expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
  });

  describe('a lost-migrations notice whose list could not be read', () => {
    const sql = 'update a;\n';

    /**
     * A batch stopped by a lost-migrations notice stored with `record` in place of its own (none:
     * as fitNotice leaves a notice whose record was too long, or a malformed record would), and the
     * inbox that acts on answers.
     */
    async function stoppedUnreadable(record?: string) {
      const batch = await bothSidesAdded([{ tag: '0001_mine_backfill', sql, custom: true }]);
      const updates = createBaseUpdates({
        ...h.ctx,
        generators: drizzle({ failAt: 'mine_backfill' }),
      });
      await updates.beforeGate(batch.id, signal);
      const stored = h.only(lostNotices(batch.id));
      const bare = { key: stored.key, tone: stored.tone, line: stored.line, body: stored.body };
      h.state.write((w) => {
        setBatchNotice(w, batch.id, record === undefined ? bare : { ...bare, record });
      });
      const inbox = createInboxService({
        state: h.state,
        onParkedAnswer: () => undefined,
        onFlagAnswer: createLostMigrationsAnswers(h.ctx),
      });
      return { batch, updates, inbox, stored, bare };
    }

    /** The batch adds another migration, and the base takes that number too. */
    async function anotherLost(batch: BatchDto): Promise<void> {
      await commitOnBatch(batch, `${DB}/0002_more.sql`, 'update b;\n');
      await commitOnBatch(batch, `${DB}/meta/0002_snapshot.json`, snapshot('more', 'a', 'c'));
      await commitOnBatch(batch, JOURNAL, journal('0000_init', '0001_theirs', '0002_more'));
      h.teammatePush('main', `${DB}/0002_theirs_too.sql`, 'alter table a add d;\n');
      h.teammatePush('main', `${DB}/meta/0002_snapshot.json`, snapshot('too', 'a', 'c', 'd'));
      h.teammatePush('main', JOURNAL, journal('0000_init', '0001_theirs', '0002_theirs_too'));
    }

    type Stopped = Awaited<ReturnType<typeof stoppedUnreadable>>;

    it(
      'is not cleared by any gate, even with the migration back, until the builder clears it on the card, stays as it is through a later merge that loses another, and stops again after it was cleared',
      { timeout: BOOT_TIMEOUT * 3 },
      async () => {
        const rows: {
          what: string;
          record?: string;
          then: (stopped: Stopped) => Promise<void>;
        }[] = [
          {
            what: 'has no record',
            // Offers the one answer on the card, which every gate still stops at until it is given;
            // then a later merge that loses another leaves the notice as it is.
            then: async ({ batch, updates, stored, bare }) => {
              for (let gate = 0; gate < 2; gate++) {
                const again = await updates.beforeGate(batch.id, signal);
                expect(again).toMatchObject({ kind: 'uncarried', unreadable: true });
              }
              const card = h.only(h.cards());
              expect(card.options.map((o) => o.label)).toEqual([LostChoice.Clear]);
              expect(card.body).toContain('journal');

              await anotherLost(batch);
              const later = createBaseUpdates({
                ...h.ctx,
                generators: drizzle({ failAt: 'more' }),
              });
              const merged = await later.beforeGate(batch.id, signal);

              // The merge is answered in the unreadable notice's words, not with text that names a
              // stale list.
              if (merged.kind !== 'uncarried')
                throw new Error(`uncarried expected, got ${merged.kind}`);
              expect(merged.unreadable).toBe(true);
              expect(merged.note).toContain('could not be read');
              expect(merged.note).not.toContain(stored.body);
              expect(existsSync(join(pathOf(batch), DB, '0002_more.sql'))).toBe(false);
              // The list stays as it was (unreadable); only the words the builder reads change.
              expect(h.only(lostNotices(batch.id))).toEqual({ ...bare, body: uncarriedSaid(bare) });
              expect(await later.beforeGate(batch.id, signal)).toMatchObject({
                kind: 'uncarried',
                unreadable: true,
              });
            },
          },
          {
            what: 'has a record that is not JSON',
            record: 'not json',
            // Lets a gate pass once the builder clears the notice, and not before; then stops again
            // when a merge loses a migration after the notice was cleared.
            then: async ({ batch, updates, inbox }) => {
              inbox.answer(h.only(h.cards()).id, { choice: LostChoice.Clear });

              expect(getBatch(h.store.db, batch.id).notices).toEqual([]);
              expect(h.cards()).toEqual([]);
              expect((await updates.beforeGate(batch.id, signal)).kind).toBe('up_to_date');

              await anotherLost(batch);
              const merged = await createBaseUpdates({
                ...h.ctx,
                generators: drizzle({ failAt: 'more' }),
              }).beforeGate(batch.id, signal);

              expect(merged).toMatchObject({ kind: 'uncarried' });
              expect(merged).not.toHaveProperty('unreadable');
              expect(lostNotices(batch.id)).toHaveLength(1);
            },
          },
          {
            what: 'has a record that is not a list of migrations',
            record: '[{"nope":1}]',
            // Still answers for the unreadable list when the migration is back in the journal.
            then: async ({ batch, updates }) => {
              await commitOnBatch(batch, `${DB}/0002_mine_backfill.sql`, sql);
              await commitOnBatch(
                batch,
                JOURNAL,
                journal('0000_init', '0001_theirs', '0002_mine_backfill'),
              );

              expect(await updates.beforeGate(batch.id, signal)).toMatchObject({
                kind: 'uncarried',
                unreadable: true,
              });
              expect(h.only(lostNotices(batch.id)).key).toBe(NOTICE_KEY.migrationsUncarried);
            },
          },
        ];
        await eachOnItsOwn(rows, async ({ what, record, then }) => {
          const stopped = await stoppedUnreadable(record);
          const { batch, updates } = stopped;

          const again = await updates.beforeGate(batch.id, signal);

          // Does not clear it, and says its list could not be read.
          if (again.kind !== 'uncarried')
            throw new Error(`${what}: uncarried expected, got ${again.kind}`);
          expect.soft(again.note, what).toContain('could not be read');
          expect.soft(again.note, what).toContain("won't clear this notice");
          expect.soft(again.note, what).toContain('clearing the notice');
          expect.soft(again.unreadable, what).toBe(true);
          expect.soft(again.head, what).toBe(headOf(pathOf(batch)));
          expect.soft(h.cards(), what).toHaveLength(1);
          const shown = h.only(lostNotices(batch.id));
          expect.soft(shown.key, what).toBe(NOTICE_KEY.migrationsUncarried);
          // What the builder reads says abandoning ends it, not the re-create steps of a list it lost.
          expect.soft(shown.body, what).toContain('abandoning the batch');
          expect.soft(shown.body, what).not.toContain('re-creates');
          expect.soft(shown.record, what).toBe(record);

          await then(stopped);
        });
      },
    );

    it("does not tell a later merge's note or card to re-create migrations while it is unreadable", async () => {
      const { batch } = await stoppedUnreadable();
      await anotherLost(batch);
      // The generators fail for a reason that is not a carry: no migration is named by the failure.
      const updates = createBaseUpdates({
        ...h.ctx,
        generators: { regenerate: () => Promise.reject(new Error('drizzle-kit is not installed')) },
      });

      const merged = await updates.beforeGate(batch.id, signal);

      if (merged.kind !== 'uncarried') throw new Error(`uncarried expected, got ${merged.kind}`);
      expect(merged.unreadable).toBe(true);
      expect(merged.note).toContain('drizzle-kit is not installed');
      expect(merged.note).not.toMatch(/to re-create/);
      expect(merged.note).not.toContain('under the same name');
      const told = [...h.cards(), ...getBatch(h.store.db, batch.id).notices];
      expect(told.length).toBeGreaterThan(0);
      for (const said of told) {
        expect(said.body).not.toMatch(/to re-create/);
        expect(said.body).not.toContain('under the same name');
      }
    });
  });

  it(
    'stops the gate, naming the migration, when the install fails so the generators never ran, or when the generators throw',
    { timeout: BOOT_TIMEOUT * 2 },
    async () => {
      await eachOnItsOwn(
        [
          {
            what: 'the install fails',
            ctx: (): Partial<DeliveryContext> => {
              h.teammatePush('main', 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
              return {
                dependencies: { refresh: () => Promise.reject(new Error('the install blew up')) },
                generators: drizzle(),
              };
            },
          },
          {
            what: 'the generators throw',
            ctx: (): Partial<DeliveryContext> => ({
              generators: { regenerate: () => Promise.reject(new Error('no sandbox')) },
            }),
          },
        ],
        async ({ what, ctx }) => {
          const batch = await bothSidesAdded([{ tag: '0001_mine', sql: 'alter table a add b;\n' }]);
          const update = await createBaseUpdates({ ...h.ctx, ...ctx() }).beforeGate(
            batch.id,
            signal,
          );

          expect.soft(update.kind, what).toBe('uncarried');
          expect.soft(regenerateNotice(batch.id).body, what).toContain('0001_mine');
        },
      );
    },
  );

  it(
    'does not ship a batch whose only migration is custom when the shipping gate, or a launch with no gate to ask, could not carry it',
    { timeout: BOOT_TIMEOUT * 2 },
    async () => {
      await eachOnItsOwn(
        [
          {
            what: 'the shipping gate',
            stop: (): Promise<unknown> => {
              const failing = drizzle({ failAt: 'mine_backfill' });
              vi.spyOn(h.ctx.generators, 'regenerate').mockImplementation((input) =>
                failing.regenerate(input),
              );
              return Promise.resolve();
            },
            card: true,
          },
          {
            what: "a lane's launch with no gate",
            stop: (batch: BatchDto): Promise<unknown> => {
              h.state.write((c) => patchProject(c, h.project.id, { gateCommand: null }));
              return createBaseUpdates({
                ...h.ctx,
                generators: drizzle({ failAt: 'mine_backfill' }),
              }).beforeGate(batch.id, signal, { atLaunch: true });
            },
            card: false,
          },
        ],
        async ({ what, stop, card }) => {
          const batch = await bothSidesAdded([
            { tag: '0001_mine_backfill', sql: 'update a;\n', custom: true },
          ]);
          await stop(batch);
          h.settle(h.only(listWorkstreams(h.store.db, { batchId: batch.id })).id, 'DONE');
          h.shipper.checkBatch(batch.id);
          await h.jobs.idle();

          expect.soft(getBatch(h.store.db, batch.id).state, what).toBe('FAILED');
          expect.soft(h.origin$('for-each-ref', `refs/heads/${batch.branch ?? ''}`), what).toBe('');
          if (!card) return;
          expect.soft(getBatch(h.store.db, batch.id).failure, what).toBe('base_conflict');
          const shown = h.only(h.cards());
          expect.soft(shown.title, what).toContain('migration');
          expect.soft(shown.body, what).toContain('0001_mine_backfill');
          expect.soft(shown.body, what).toContain('Retry');
        },
      );
    },
  );

  it("commits nothing and names the migration on a notice when the schema of a step can't be told", async () => {
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
    const notice = regenerateNotice(batch.id);
    expect(notice.body).toContain('0001_mine');
    expect(notice.body).toContain('a schema for its step could not be made');
  });

  it('names what the merge dropped on the notice when the run is stopped before it re-creates it', async () => {
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

    expect(regenerateNotice(batch.id).body).toContain(`${DB}/0001_mine.sql`);
    // The merge stands, and the next gate finds the branch holding the base.
    expect((await createBaseUpdates(h.ctx).beforeGate(batch.id, signal)).kind).toBe('uncarried');
  });

  it(
    'refuses a FIFO the generators left, without blocking on it, and writes nothing through a link they left, at a custom migration or the journal',
    { timeout: BOOT_TIMEOUT * 4 },
    async () => {
      const SQL = `${DB}/0002_mine.sql`;
      const mkfifo = (target: string): void => {
        execFileSync('mkfifo', [target]);
      };
      await eachOnItsOwn(
        [
          { what: 'a FIFO at a custom migration', custom: true, file: SQL, make: mkfifo },
          { what: 'a FIFO at the journal', custom: false, file: JOURNAL, make: mkfifo },
          {
            what: 'a hard link at a custom migration, which truncates nothing',
            custom: true,
            file: SQL,
            make: (target: string, outside: string) => {
              linkSync(outside, target);
            },
            link: true,
          },
          {
            what: "a link where a custom migration's SQL goes",
            custom: true,
            file: SQL,
            make: (target: string, outside: string) => {
              symlinkSync(outside, target);
            },
            link: true,
          },
        ],
        async ({ what, custom, file, make, link = false }) => {
          const batch = await bothSidesAdded([
            custom
              ? { tag: '0001_mine', sql: 'update a;\n', custom: true }
              : { tag: '0001_mine', sql: 'alter table a add b;\n' },
          ]);
          const path = pathOf(batch);
          const outside = join(path, '..', 'outside.txt');
          writeFileSync(outside, 'untouched\n');
          const update = await createBaseUpdates({
            ...h.ctx,
            generators: drizzle({
              afterRun: (at) => {
                rmSync(join(at, file));
                make(join(at, file), outside);
              },
            }),
          }).beforeGate(batch.id, signal);

          expect.soft(readFileSync(outside, 'utf8'), what).toBe('untouched\n');
          expect.soft(update.kind, what).toBe('uncarried');
          if (link) expect.soft(statusOf(path), what).toBe('');
          expect.soft(regenerateNotice(batch.id).body, what).toContain('0001_mine');
        },
      );
    },
  );
});
