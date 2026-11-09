import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  BranchName,
  mintId,
  WorkstreamState,
  type ProjectInput,
  type TaskDto,
} from '@10db/contracts';
import {
  activeClaims,
  getBatch,
  getTask,
  getWorkstream,
  insertBatch,
  insertWorkstream,
  moveTask,
  listBoardColumns,
  patchTask,
  schema,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { PASS_HOLDS_FOLDER_REASON } from '../placement';
import { openPass, passBranchName, passDirtRef, type PassOpenInput } from './index';

// Workbench spec §5.1, §5.3 (W9), §5.5: a pass opens on Your folder, at its HEAD, with its batch,
// its dirt record and its page claims; its batch never ships itself.

const PAGES: Partial<ProjectInput> = {
  areas: [
    { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
    { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
    { name: 'src', globs: ['src/**'], role: 'shared' },
  ],
};

let h: DeliveryHarness;
afterEach(() => {
  h.close();
});

const LEASE = { leaseMs: 60_000 };

function harness(project: Partial<ProjectInput> = {}, trigger = true): DeliveryHarness {
  h = createDeliveryHarness({ ...PAGES, ...project }, { trigger });
  return h;
}

function open(tasks: readonly TaskDto[], extra: Partial<PassOpenInput> = {}) {
  return openPass(
    h.ctx,
    { projectId: h.project.id, name: 'Polish pages', taskIds: tasks.map((t) => t.id), ...extra },
    LEASE,
  );
}

const page = (title: string, areas: string[]) => h.addTask(title, { areas });

/** The task's latest run. */
function runOf(task: TaskDto) {
  const id = getTask(h.store.db, task.id).workstreamId;
  return id === null ? undefined : getWorkstream(h.store.db, id);
}

/** Every file under the checkout (`.git` included) with its bytes and modification time. */
function snapshot(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else
        files.set(relative(root, path), `${String(stat.mtimeMs)}:${readFileSync(path, 'base64')}`);
    }
  };
  walk(root);
  return files;
}

function write(path: string, content: string): void {
  const file = join(h.repo, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('opening a pass', () => {
  it('opens on a dirty folder at HEAD: no file written, the dirt and its content recorded, the pages claimed', async () => {
    harness();
    h.commit('.gitignore', 'dist/\n');
    h.commit('src/old.ts', 'old\n');
    const startSha = h.commit('src/settings/page.tsx', 'before\n');
    write('src/settings/page.tsx', 'edited by hand\n');
    unlinkSync(join(h.repo, 'src/old.ts'));
    write('src/new.ts', 'untracked\n');
    write('dist/out.js', 'ignored\n');
    const status = h.git$('status', '--porcelain');
    const settings = page('Settings: UI work', ['settings', 'src']);
    const people = page('People: UI work', ['people']);
    const files = [...snapshot(h.repo)].filter(([path]) => !path.startsWith('.git/'));
    const index = readFileSync(join(h.repo, '.git/index'));

    const opened = await open([settings, people]);

    // Nothing in the folder was written: its files, its index and what git status says.
    expect([...snapshot(h.repo)].filter(([path]) => !path.startsWith('.git/'))).toEqual(files);
    expect(readFileSync(join(h.repo, '.git/index')).equals(index)).toBe(true);
    expect(h.git$('status', '--porcelain')).toBe(status);
    // The branch is at HEAD's commit, and HEAD names it.
    const branch = passBranchName('Polish pages', opened.pass.id);
    expect(BranchName.safeParse(branch).success).toBe(true);
    expect(branch).toMatch(/^10db\/polish-pages-[0-9a-f]{6}$/);
    expect(h.git$('symbolic-ref', 'HEAD')).toBe(`refs/heads/${branch}`);
    expect(h.git$('rev-parse', branch)).toBe(startSha);
    expect(opened.pass).toMatchObject({
      returnBranch: 'main',
      startSha,
      state: 'OPEN',
      pageCap: 4,
    });
    // Its batch is open on that branch, made by the pass, based at the start, its repo from origin.
    expect(getBatch(h.store.db, opened.batch.id)).toMatchObject({
      state: 'OPEN',
      passId: opened.pass.id,
      branch,
      baseSha: startSha,
      repo: 'acme/widgets',
      worktreePath: null,
    });
    // The dirt: each path with the hash of its content on disk, null for the deleted one; ignored
    // files are not dirt.
    expect(opened.dirt).toEqual([
      { path: 'src/new.ts', blob: h.git$('hash-object', 'src/new.ts') },
      { path: 'src/old.ts', blob: null },
      { path: 'src/settings/page.tsx', blob: h.git$('hash-object', 'src/settings/page.tsx') },
    ]);
    // Its content is kept by an unsigned commit on the start, so a file can be put back exactly.
    const ref = passDirtRef(opened.pass.id);
    expect(h.git$('rev-parse', `${ref}^`)).toBe(startSha);
    expect(h.git$('show', `${ref}:src/settings/page.tsx`)).toBe('edited by hand');
    expect(h.git$('show', `${ref}:src/new.ts`)).toBe('untracked');
    expect(() => h.git$('cat-file', '-e', `${ref}:src/old.ts`)).toThrow();
    expect(h.git$('cat-file', '-p', ref)).not.toMatch(/gpgsig/);
    // The three commits made here are not on origin's base.
    expect(opened.aheadOfBase).toBe(3);
    // Each task waits QUEUED in the pass's batch, holding its pages and areas with no role, not
    // the shared area.
    for (const [task, held] of [
      [settings, ['settings']],
      [people, ['people']],
    ] as const) {
      expect(getTask(h.store.db, task.id).passId).toBe(opened.pass.id);
      const ws = runOf(task);
      expect(ws).toMatchObject({ state: WorkstreamState.Queued, batchId: opened.batch.id });
      expect(activeClaims(h.store.db, ws?.id ?? mintId('Workstream')).map((c) => c.name)).toEqual(
        held,
      );
    }
    expect(opened.waiting).toEqual([]);
  });

  it('makes a page another task holds wait for it, naming the holder', async () => {
    harness();
    const holder = page('People: copy fix', ['people']);
    // A task waiting on a card with no session holds its claims and no lane in the folder.
    const held = h.state.write((w) => {
      const ws = insertWorkstream(w, holder.id, {
        first: { model: 'claude-sonnet-5-5', effort: 'medium' },
      });
      transitionWorkstream(w, ws.id, { to: WorkstreamState.Starting, fence: null });
      transitionWorkstream(w, ws.id, { to: WorkstreamState.Running, fence: null });
      transitionWorkstream(w, ws.id, { to: WorkstreamState.WaitingHuman, fence: null });
      w.tx
        .insert(schema.claims)
        .values({
          id: mintId('Claim'),
          projectId: h.project.id,
          scope: h.project.id,
          workstreamId: ws.id,
          kind: 'area',
          name: 'people',
          exclusive: true,
          leaseExpiresAt: w.now,
          releasedAt: null,
          createdAt: w.now,
          updatedAt: w.now,
        })
        .run();
      return ws;
    });
    const settings = page('Settings: UI work', ['settings']);
    const people = page('People: UI work', ['people']);

    const opened = await open([settings, people]);

    expect(opened.waiting).toEqual([{ taskId: people.id, area: 'people', heldBy: holder.id }]);
    const waiting = runOf(people);
    expect(waiting?.notice?.line).toBe('Waiting for area people: task "People: copy fix" holds it');
    expect(activeClaims(h.store.db, waiting?.id ?? mintId('Workstream'))).toEqual([]);
    expect(activeClaims(h.store.db, held.id).map((c) => c.name)).toEqual(['people']);
  });

  it.each<{
    name: string;
    project?: Partial<ProjectInput>;
    arrange: () => { tasks: TaskDto[]; extra?: Partial<PassOpenInput> };
    refusal: RegExp;
  }>([
    {
      name: 'a project with no page area',
      project: { areas: [{ name: 'repo', globs: ['**'] }] },
      arrange: () => ({ tasks: [page('A', ['repo'])] }),
      refusal: /has no page area/,
    },
    {
      name: 'a task with no page area',
      arrange: () => ({ tasks: [page('Shared only', ['src'])] }),
      refusal: /Shared only names no page area/,
    },
    {
      name: 'two tasks on one page',
      arrange: () => ({ tasks: [page('A', ['people']), page('B', ['people'])] }),
      refusal: /"A" and "B" both hold people/,
    },
    {
      name: 'more tasks than the page cap',
      arrange: () => ({
        tasks: [page('A', ['people']), page('B', ['settings'])],
        extra: { pageCap: 1 },
      }),
      refusal: /holds 1 pages; 2 tasks/,
    },
    {
      name: 'a page cap over six',
      arrange: () => ({ tasks: [page('A', ['people'])], extra: { pageCap: 7 } }),
      refusal: /from 1 to 6 pages/,
    },
    {
      name: 'a parked task',
      arrange: () => {
        const task = page('Parked', ['people']);
        const [column] = listBoardColumns(h.store.db, h.project.id);
        if (!column) throw new Error('the project has no human column');
        h.state.write((w) => moveTask(w, task.id, { to: column.id, after: null, before: null }));
        return { tasks: [task] };
      },
      refusal: /parked/,
    },
    {
      name: 'an unfinished batch in Your folder',
      arrange: () => {
        h.state.write((w) =>
          insertBatch(w, { projectId: h.project.id, title: 'Earlier', baseBranch: 'main' }),
        );
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /Batch "Earlier" in Your folder is still cutting/,
    },
    {
      name: 'a task running in Your folder',
      arrange: () => {
        const other = page('Running', ['src']);
        h.state.write((w) => {
          const ws = insertWorkstream(w, other.id, {
            first: { model: 'claude-sonnet-5-5', effort: 'medium' },
          });
          transitionWorkstream(w, ws.id, { to: WorkstreamState.Starting, fence: null });
        });
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /1 task is running in Your folder/,
    },
    {
      name: 'a detached HEAD',
      arrange: () => {
        h.git$('switch', '-q', '--detach', 'HEAD');
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /detached HEAD/,
    },
  ])(
    'refuses $name and leaves the folder and the database as they were',
    async ({ project, arrange, refusal }) => {
      harness(project);
      const { tasks, extra } = arrange();
      const head = h.git$('rev-parse', '--symbolic-full-name', 'HEAD');
      await expect(Promise.resolve().then(() => open(tasks, extra))).rejects.toThrow(refusal);
      await h.jobs.idle();
      expect(h.store.db.select().from(schema.passes).all()).toEqual([]);
      expect(h.git$('rev-parse', '--symbolic-full-name', 'HEAD')).toBe(head);
      expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/heads/10db/', 'refs/10db/')).toBe(
        '',
      );
    },
  );

  it('refuses a second pass while the first is open', async () => {
    harness();
    await open([page('People: UI work', ['people'])]);
    expect(() => open([page('Settings: UI work', ['settings'])])).toThrow(
      /Pass "Polish pages" is still open/,
    );
  });

  it('takes the branch back when a start slips in while git works, and the start goes on', async () => {
    harness();
    const pending = open([page('People: UI work', ['people'])]);
    // Written at once by the start, before the pass's job reaches its write.
    const started = h.starter.startTask(h.addTask('Ordinary', { areas: ['src'] }).id);
    await expect(pending).rejects.toThrow(/still cutting/);
    await h.jobs.idle();
    expect(h.store.db.select().from(schema.passes).all()).toEqual([]);
    expect(h.git$('for-each-ref', '--format=%(refname)', 'refs/10db/')).toBe('');
    // The cut queued behind the pass found the folder back on main and cut its own branch.
    expect(getBatch(h.store.db, started.id)).toMatchObject({ state: 'OPEN', passId: null });
    expect(h.git$('rev-parse', '--abbrev-ref', 'HEAD')).toBe(
      getBatch(h.store.db, started.id).branch,
    );
  });
});

describe('a pass in a local project', () => {
  it('makes its batch and its branch, where a batch start is refused, and reads no repo without origin', async () => {
    harness({ delivery: 'local' });
    expect(() =>
      h.starter.startBatch(h.project.id, {
        title: 'x',
        taskIds: [h.addTask('Ordinary', { areas: ['src'] }).id],
      }),
    ).toThrow(/delivers locally/);
    h.git$('remote', 'remove', 'origin');
    const opened = await open([page('People: UI work', ['people'])]);
    expect(getBatch(h.store.db, opened.batch.id)).toMatchObject({
      state: 'OPEN',
      passId: opened.pass.id,
      repo: null,
      baseSha: opened.pass.startSha,
    });
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(
      passBranchName('Polish pages', opened.pass.id),
    );
    expect(opened.aheadOfBase).toBeNull();
  });
});

describe("a pass's batch", () => {
  it('never ships itself when its last task is done, nor at start-up', async () => {
    harness();
    const task = page('People: UI work', ['people']);
    const opened = await open([task]);
    const ws = runOf(task);
    if (!ws) throw new Error('the pass task has no workstream');
    h.settle(ws.id, 'DONE');
    await h.jobs.idle();
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
    h.restartShipper().checkOpenBatches();
    await h.jobs.idle();
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
    expect(getWorkstream(h.store.db, ws.id).state).toBe('DONE');
  });

  it('is shipped by no ship the builder asks for', async () => {
    harness({}, false);
    const opened = await open([page('People: UI work', ['people'])]);
    expect(() => h.shipper.ship(opened.batch.id)).toThrow(/Workbench pass/);
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
  });
});

describe('other work in Your folder while a pass is open (W9)', () => {
  it('starts a folder task in a separate copy, saying why, and refuses one the builder placed in the folder', async () => {
    harness({}, false);
    await open([page('People: UI work', ['people'])]);
    const proposed = h.addTask('Ordinary', { areas: ['src'] });
    const batch = h.starter.startTask(proposed.id);
    expect(batch.worktreePath).not.toBeNull();
    expect(getTask(h.store.db, proposed.id)).toMatchObject({
      workspaceMode: 'worktree',
      placementReason: PASS_HOLDS_FOLDER_REASON,
    });
    const placed = h.addTask('Placed', { areas: ['src'] });
    h.state.write((w) => patchTask(w, placed.id, { workspaceMode: 'shared' }));
    expect(() => h.starter.startTask(placed.id)).toThrow(/Workbench pass "Polish pages"/);
    await h.jobs.idle();
  });
});
