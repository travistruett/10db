import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join as inRepo } from 'node:path';
import { mintId, type ProjectInput, type TaskDto } from '@10db/contracts';
import {
  activeClaims,
  getTask,
  getTaskKeptWork,
  getWorkstream,
  insertWorkstream,
  listTaskThread,
  schema,
  setTaskKeptWork,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { openPassWorld, PASS_PROJECT, type PassWorld } from '../../test/pass-world';
import type { PassOpenDeps, PutBackKeptWork } from '../delivery';
import { joinPass } from './join';
import { putBackKeptWork } from './put-back';
import { passView } from './view';

// Workbench spec §4.3: Add Page. New tasks for page areas, and open tasks, join an open pass in its
// own job: each runs in the pass's batch with its pages claimed, and none is sent a word unasked.

const PROJECT: Partial<ProjectInput> = {
  areas: [
    ...(PASS_PROJECT.areas ?? []),
    { name: 'billing', globs: ['src/billing/**'], role: 'page', route: '/billing' },
    { name: 'home', globs: ['src/home/**'], role: 'page', route: '/' },
  ],
};

let w: PassWorld;
afterEach(() => {
  w.close();
});

const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });

function join(
  input: { pages?: string[]; taskIds?: TaskDto['id'][]; firstMessage?: string | null },
  putBack: PutBackKeptWork = nothingKept,
) {
  const deps: PassOpenDeps = { leaseMs: 60_000, putBack };
  return joinPass(
    w.h.ctx,
    w.opened.pass.id,
    {
      pages: input.pages ?? [],
      taskIds: input.taskIds ?? [],
      firstMessage: input.firstMessage ?? null,
    },
    deps,
  );
}

const builderMessages = (taskId: TaskDto['id']) =>
  listTaskThread(w.h.store.db, taskId)
    .filter((m) => m.author === 'builder')
    .map((m) => m.body);

describe('Add Page', () => {
  it('adds a new page and an open task, each running in the pass with its page claimed, and sends neither a word', async () => {
    w = await openPassWorld({ project: PROJECT });
    const home = w.h.addTask('Home: tidy', { areas: ['home'], description: 'Tidy the home page' });

    const joined = await join({ pages: ['billing'], taskIds: [home.id] });

    const pages = passView(w.h.store.db, w.opened.pass.id).pages;
    const billing = pages.find((p) => p.title === 'Billing: UI work');
    expect(pages.map((p) => p.title)).toEqual([
      'Settings: UI work',
      'People: UI work',
      'Home: tidy',
      'Billing: UI work',
    ]);
    expect(joined).toEqual({ joined: [home.id, billing?.taskId], waiting: [] });
    for (const [page, area] of [
      [home.id, 'home'],
      [billing?.taskId ?? home.id, 'billing'],
    ] as const) {
      const run = getWorkstream(w.h.store.db, w.runOf(getTask(w.h.store.db, page)));
      expect(run).toMatchObject({ state: 'QUEUED', batchId: w.opened.batch.id });
      expect(run.steps.map((s) => s.role)).toEqual(['implement']);
      expect(activeClaims(w.h.store.db, run.id).map((c) => c.name)).toEqual([area]);
      expect(builderMessages(page)).toEqual([]);
    }
  });

  it('sends the first message, when the builder wrote one, to every page it adds', async () => {
    w = await openPassWorld({ project: PROJECT });
    const home = w.h.addTask('Home: tidy', { areas: ['home'] });

    const { joined } = await join({
      pages: ['billing'],
      taskIds: [home.id],
      firstMessage: 'Match the settings page',
    });

    for (const taskId of joined)
      expect(builderMessages(taskId)).toEqual(['Match the settings page']);
    expect(builderMessages(w.settings.id)).toEqual([]);
  });

  it('makes a page another task holds wait for it, naming the holder', async () => {
    w = await openPassWorld({ project: PROJECT });
    const holder = w.h.addTask('Billing: copy fix', { areas: ['billing'] });
    w.h.state.write((ctx) => {
      const ws = insertWorkstream(ctx, holder.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      for (const to of ['STARTING', 'RUNNING', 'WAITING_HUMAN'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
      ctx.tx
        .insert(schema.claims)
        .values({
          id: mintId('Claim'),
          projectId: w.h.project.id,
          scope: w.h.project.id,
          workstreamId: ws.id,
          kind: 'area',
          name: 'billing',
          exclusive: true,
          leaseExpiresAt: ctx.now,
          releasedAt: null,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        })
        .run();
    });

    const { joined, waiting } = await join({ pages: ['billing'] });

    const [billing] = joined;
    expect(waiting).toEqual([{ taskId: billing, area: 'billing', heldBy: holder.id }]);
    const run = getWorkstream(w.h.store.db, w.runOf(getTask(w.h.store.db, billing ?? holder.id)));
    expect(run.notice?.line).toBe('Waiting for area billing: task "Billing: copy fix" holds it');
    expect(activeClaims(w.h.store.db, run.id)).toEqual([]);
  });

  it("puts a joining task's saved work back once it is in the pass, and a failed put-back leaves it joined", async () => {
    w = await openPassWorld({ project: PROJECT });
    const home = w.h.addTask('Home: tidy', { areas: ['home'] });
    w.h.state.write((ctx) => {
      setTaskKeptWork(ctx, home.id, { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) });
    });
    const putBacks: { taskId: string; inPass: boolean; messages: string[] }[] = [];

    await join({ taskIds: [home.id], firstMessage: 'Match the settings page' }, ({ taskId }) => {
      putBacks.push({
        taskId,
        inPass: getTask(w.h.store.db, taskId).passId != null,
        messages: builderMessages(taskId),
      });
      return Promise.reject(new Error('the folder moved'));
    });

    // No message yet while the work goes back, so the page can't start on a half-written folder.
    expect(putBacks).toEqual([{ taskId: home.id, inPass: true, messages: [] }]);
    expect(getTask(w.h.store.db, home.id).passId).toBe(w.opened.pass.id);
    expect(builderMessages(home.id)).toEqual(['Match the settings page']);
  });

  it("writes a joining task's saved work back into the folder on the pass's branch", async () => {
    w = await openPassWorld({ project: PROJECT });
    const home = w.h.addTask('Home: tidy', { areas: ['home'] });
    keptWorkOf(home, { 'src/home/page.tsx': 'home, tidied\n' });

    await join({ taskIds: [home.id] }, (input) => putBackKeptWork(w.deps, input));

    expect(readFileSync(inRepo(w.h.repo, 'src/home/page.tsx'), 'utf8')).toBe('home, tidied\n');
    expect(getTaskKeptWork(w.h.store.db, home.id)).toBeNull();
  });

  it("refuses a join while the folder is off the pass's branch, writing nothing and joining nothing", async () => {
    w = await openPassWorld({ project: PROJECT });
    const home = w.h.addTask('Home: tidy', { areas: ['home'] });
    const kept = keptWorkOf(home, { 'src/home/page.tsx': 'home, tidied\n' });
    w.h.git$('switch', '-q', 'main');

    await expect(
      join({ pages: ['billing'], taskIds: [home.id] }, (input) => putBackKeptWork(w.deps, input)),
    ).rejects.toThrow(/Your folder is on main, not the branch of pass "Polish"/);

    expect(existsSync(inRepo(w.h.repo, 'src/home/page.tsx'))).toBe(false);
    expect(getTaskKeptWork(w.h.store.db, home.id)?.keptSha).toBe(kept);
    expect(getTask(w.h.store.db, home.id).passId ?? null).toBeNull();
    expect(passView(w.h.store.db, w.opened.pass.id).pages).toHaveLength(2);
  });
});

/** Work a take-out saved for the task: `files` over the pass's start, at its kept ref. */
function keptWorkOf(task: TaskDto, files: Record<string, string>): string {
  const base = w.opened.pass.startSha;
  w.h.git$('read-tree', base);
  for (const [path, content] of Object.entries(files)) {
    const file = inRepo(w.h.repo, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  w.h.git$('add', ...Object.keys(files));
  const tree = w.h.git$('write-tree');
  w.h.git$('read-tree', 'HEAD');
  for (const path of Object.keys(files)) rmSync(inRepo(w.h.repo, path));
  const sha = w.h.git$('commit-tree', '--no-gpg-sign', tree, '-p', base, '-m', 'kept');
  w.h.git$('update-ref', `refs/10db/kept/${task.id}`, sha);
  w.h.state.write((ctx) => {
    setTaskKeptWork(ctx, task.id, { keptSha: sha, keptBaseSha: base });
  });
  return sha;
}
