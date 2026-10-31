import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { getBatch, listWorkstreams, patchWorkstream } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { isolatedGitEnv } from '../../test/fixtures';
import { createBaseUpdates, createMigrationsBase } from './index';

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const signal = new AbortController().signal;
const DRIZZLE = 'packages/db/drizzle';
const JOURNAL = `${DRIZZLE}/meta/_journal.json`;

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();
}

/** A drizzle journal holding `tags`, numbered in order as drizzle-kit writes it. */
function journal(...tags: string[]): string {
  const entries = tags.map((tag, idx) => ({
    idx,
    version: '6',
    when: idx,
    tag,
    breakpoints: true,
  }));
  return `${JSON.stringify({ version: '7', dialect: 'sqlite', entries }, null, 2)}\n`;
}

const tagsIn = (path: string): unknown =>
  (
    JSON.parse(readFileSync(join(path, JOURNAL), 'utf8')) as { entries: { tag: string }[] }
  ).entries.map((e) => e.tag);

/** Starts one task with main holding migration 0000, and waits for its batch to open. */
async function opened(mode: 'worktree' | 'shared' = 'worktree') {
  h = createDeliveryHarness(mode === 'worktree' ? { workspaceMode: 'worktree' } : {}, {
    trigger: false,
  });
  h.commit(JOURNAL, journal('0000_init'));
  h.git$('push', '-q', 'origin', 'main');
  const started = h.starter.startTask(h.addTask('Alpha').id);
  await h.jobs.idle();
  const batch = getBatch(h.store.db, started.id);
  expect(batch.state).toBe('OPEN');
  const ws: WorkstreamDto = h.only(listWorkstreams(h.store.db, { batchId: batch.id }));
  h.state.write((c) => {
    patchWorkstream(c, ws.id, null, { baseHead: batch.baseSha ?? '' });
  });
  const checkout = batch.worktreePath ?? h.repo;
  return { batch, ws, checkout, bases: createMigrationsBase(h.ctx, createBaseUpdates(h.ctx)) };
}

async function commitOnBatch(batch: BatchDto, path: string, content = `${path}\n`) {
  const checkout = batch.worktreePath ?? h.repo;
  const file = join(checkout, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  await h.git.commit({
    repo: checkout,
    paths: [path],
    message: `Add ${path}`,
    opId: `op-${path.replaceAll('/', '-')}`,
    branch: batch.branch ?? '',
  });
}

/** main gains migration 0001 after the batch was cut, as when another task's pull request merges. */
function mainGainsMigration(): string {
  h.teammatePush('main', `${DRIZZLE}/0001_track_prs.sql`, 'ALTER TABLE c ADD d text;\n');
  return h.teammatePush('main', JOURNAL, journal('0000_init', '0001_track_prs'));
}

describe("bringing main into a task's branch before it takes the migrations hazard", () => {
  it("merges main as origin has it now, so the next migration is numbered after main's latest", async () => {
    const { batch, ws, checkout, bases } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    const main = mainGainsMigration();
    expect(tagsIn(checkout)).toEqual(['0000_init']);

    expect(await bases.take(ws.id, signal)).toEqual({ kind: 'ready' });

    expect(tagsIn(checkout)).toEqual(['0000_init', '0001_track_prs']);
    expect(existsSync(join(checkout, DRIZZLE, '0001_track_prs.sql'))).toBe(true);
    expect(getBatch(h.store.db, batch.id).baseSha).toBe(main);
    expect(gitIn(checkout, 'status', '--porcelain')).toBe('');
    expect(h.cards()).toEqual([]);
  });

  it('holds the hazard back while main conflicts, on one card that says the task generates no migration until it is resolved', async () => {
    const { batch, ws, checkout, bases } = await opened();
    await commitOnBatch(batch, 'README.md', '# ours\n');
    mainGainsMigration();
    h.teammatePush('main', 'README.md', '# theirs\n');

    const held = await bases.take(ws.id, signal);
    const card = h.only(h.cards());
    expect(held).toMatchObject({ kind: 'held', inboxId: card.id });
    expect(held.kind === 'held' && held.instruction).toBe(
      "origin/main conflicts with this branch in README.md, so 10db couldn't bring it in and has not given you the migrations hazard: a migration generated now would be numbered before main's latest. Don't generate or write a migration. The builder has a card to resolve the conflict. Carry on with your other work, and call request_claim again with the same opId once it is resolved; if the migration is all that is left, ask the builder with ask_human to resolve it.",
    );
    expect(card.title).toBe('Batch "Alpha" conflicts with main');
    expect(card.body).toContain('- README.md');
    expect(card.body).toContain(
      'Task "Alpha" asked for the migrations hazard. 10db gives it only once this branch holds main, so that a migration it generates is numbered after main\'s latest: until the conflict is resolved, the task generates no migration.',
    );
    expect(tagsIn(checkout)).toEqual(['0000_init']);

    // Asked again: still one card.
    expect((await bases.take(ws.id, signal)).kind).toBe('held');
    expect(h.cards()).toHaveLength(1);

    // The builder merges by hand in the worktree; the next ask gets the hazard and the card goes.
    gitIn(
      checkout,
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '-q',
      '-X',
      'ours',
      '-m',
      'Merge main',
      'origin/main',
    );
    expect(await bases.take(ws.id, signal)).toEqual({ kind: 'ready' });
    expect(tagsIn(checkout)).toEqual(['0000_init', '0001_track_prs']);
    expect(h.cards()).toEqual([]);
  });

  it("holds the hazard back while the task's own uncommitted change is in main's way, and says to commit it, with no card", async () => {
    const { batch, ws, checkout, bases } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    h.teammatePush('main', 'README.md', '# theirs\n');
    writeFileSync(join(checkout, 'README.md'), '# a lane is still writing\n');

    expect(await bases.take(ws.id, signal)).toEqual({
      kind: 'held',
      inboxId: null,
      instruction:
        "Uncommitted changes in README.md are in the way of origin/main's newer commits, so 10db couldn't bring them in and has not given you the migrations hazard: a migration generated now would be numbered before main's latest. Don't generate or write a migration. Commit those files with the commit tool, or undo your change to them, then call request_claim again with the same opId.",
    });
    expect(h.cards()).toEqual([]);
  });

  it("never merges into the builder's own checkout", async () => {
    const { batch, ws, checkout, bases } = await opened('shared');
    await commitOnBatch(batch, 'src/api/alpha.txt');
    mainGainsMigration();
    const head = gitIn(checkout, 'rev-parse', 'HEAD');

    expect(await bases.take(ws.id, signal)).toEqual({ kind: 'ready' });

    expect(gitIn(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(tagsIn(checkout)).toEqual(['0000_init']);
  });

  it('brings main in once for asks that overlap', async () => {
    const { batch, ws, bases } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    mainGainsMigration();
    const [one, two] = await Promise.all([bases.take(ws.id, signal), bases.take(ws.id, signal)]);
    expect([one, two]).toEqual([{ kind: 'ready' }, { kind: 'ready' }]);
    const merges = h.logs.lines().filter((l) => l['msg'] === 'base merged into the batch branch');
    expect(merges).toHaveLength(1);
  });

  it('does nothing once its signal has aborted', async () => {
    const { batch, ws, checkout, bases } = await opened();
    await commitOnBatch(batch, 'src/api/alpha.txt');
    mainGainsMigration();
    const stop = new AbortController();
    stop.abort();
    expect(await bases.take(ws.id, stop.signal)).toEqual({ kind: 'aborted' });
    expect(tagsIn(checkout)).toEqual(['0000_init']);
  });
});
