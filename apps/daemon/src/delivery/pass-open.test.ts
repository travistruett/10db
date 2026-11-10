import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  BranchName,
  mintId,
  WorkstreamState,
  type BatchId,
  type ProjectInput,
  type TaskDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  findFlowByName,
  getBatch,
  getTask,
  getWorkstream,
  insertBatch,
  insertWorkstream,
  moveTask,
  listBoardColumns,
  patchTask,
  schema,
  setTaskKeptWork,
  transitionWorkstream,
} from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { createDeliveryHarness, type DeliveryHarness } from '../../test/delivery-harness';
import { silentLogger } from '../log';
import { PASS_HOLDS_FOLDER_REASON } from '../placement';
import { systemProcesses } from '../recovery';
import {
  openPass,
  passBranchName,
  passDirtRef,
  recoverBatches,
  type PassOpenInput,
  type PutBackKeptWork,
} from './index';

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

/** A put-back that puts nothing back: the tasks these tests open have no kept work. */
const nothingKept: PutBackKeptWork = () => Promise.resolve({ applied: [], left: [] });
const LEASE = { leaseMs: 60_000, putBack: nothingKept };

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

/** Every ref under the branches 10db names and under `refs/10db/`, with what it points at. */
function tenDbRefs(): string {
  return h.git$(
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/10db/',
    'refs/10db/',
  );
}

/** Commits `content` at `path` on a new branch `name` off HEAD, and comes back. */
function sideCommit(name: string, path: string, content: string): void {
  const back = h.git$('symbolic-ref', '--short', 'HEAD');
  h.git$('switch', '-q', '-c', name);
  h.commit(path, content);
  h.git$('switch', '-q', back);
}

/** Runs git where it is meant to stop with a conflict, which exits non-zero. */
function stopsOnConflict(...args: string[]): void {
  expect(() => h.git$(...args)).toThrow();
}

/** Start-up's batch recovery, as the daemon runs it after a restart. */
const recover = () =>
  recoverBatches({
    state: h.state,
    git: h.git,
    inbox: h.inbox,
    processes: systemProcesses,
    shipper: h.shipper,
    starter: h.starter,
    logger: silentLogger,
  });

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
    {
      name: 'a folder on a 10db branch no task names',
      arrange: () => {
        h.git$('switch', '-q', '-c', '10db/leftover-abc123');
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /Your folder is on 10db\/leftover-abc123, a 10db branch no task names/,
    },
    {
      name: 'a merge in progress',
      arrange: () => {
        h.commit('src/people/a.ts', 'base\n');
        sideCommit('other', 'src/people/a.ts', 'theirs\n');
        h.commit('src/people/a.ts', 'ours\n');
        stopsOnConflict('merge', '-q', 'other');
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /in the middle of a merge/,
    },
    {
      name: 'a cherry-pick in progress',
      arrange: () => {
        h.commit('src/people/a.ts', 'base\n');
        sideCommit('other', 'src/people/a.ts', 'theirs\n');
        h.commit('src/people/a.ts', 'ours\n');
        stopsOnConflict('cherry-pick', 'other');
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /in the middle of a cherry-pick/,
    },
    {
      name: 'a rebase in progress',
      arrange: () => {
        h.commit('src/people/a.ts', 'base\n');
        sideCommit('other', 'src/people/a.ts', 'theirs\n');
        h.commit('src/people/a.ts', 'ours\n');
        stopsOnConflict('rebase', '-q', 'other');
        return { tasks: [page('A', ['people'])] };
      },
      refusal: /in the middle of a rebase/,
    },
  ])(
    'refuses $name and leaves the folder and the database as they were',
    async ({ project, arrange, refusal }) => {
      harness(project);
      const { tasks, extra } = arrange();
      const head = h.git$('rev-parse', '--symbolic-full-name', 'HEAD');
      const refs = tenDbRefs();
      await expect(open(tasks, extra)).rejects.toThrow(refusal);
      await h.jobs.idle();
      expect(h.store.db.select().from(schema.passes).all()).toEqual([]);
      expect(h.git$('rev-parse', '--symbolic-full-name', 'HEAD')).toBe(head);
      expect(tenDbRefs()).toBe(refs);
    },
  );

  it("refuses a folder left on a finished batch's branch, saying which", async () => {
    harness({}, false);
    const started = h.only(
      h.starter.startBatch(h.project.id, {
        title: 'Greetings',
        taskIds: [h.addTask('Alpha', { areas: ['src'] }).id],
      }),
    );
    await h.jobs.idle();
    const batch = getBatch(h.store.db, started.id);
    h.commit('src/alpha.ts', 'alpha\n');
    // An edit in the folder keeps the abandoned batch's switch back from running.
    write('src/alpha.ts', 'edited by hand\n');
    h.shipper.abandon(batch.id);
    await h.jobs.idle();
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(batch.branch);
    const refs = tenDbRefs();
    await expect(open([page('People: UI work', ['people'])])).rejects.toThrow(
      `Your folder is on ${batch.branch ?? ''}, the branch of batch "Greetings"`,
    );
    await h.jobs.idle();
    expect(h.store.db.select().from(schema.passes).all()).toEqual([]);
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(batch.branch);
    expect(tenDbRefs()).toBe(refs);
  });

  it('refuses a second pass while the first is open', async () => {
    harness();
    await open([page('People: UI work', ['people'])]);
    await expect(open([page('Settings: UI work', ['settings'])])).rejects.toThrow(
      /Pass "Polish pages" is still open/,
    );
  });

  it('opens with nested repositories in the folder, leaving them out of the dirt and its commit alike', async () => {
    harness();
    write('src/people/page.tsx', 'edited\n');
    // One nested repository with no commit, one with a commit: git would refuse the first and keep
    // the second as a submodule entry.
    h.git$('init', '-q', join(h.repo, 'empty-nested'));
    const nested = join(h.repo, 'vendor/nested');
    h.git$('init', '-q', nested);
    for (const [key, value] of [
      ['maintenance.auto', 'false'],
      ['gc.auto', '0'],
      ['user.name', 'Test'],
      ['user.email', 'test@example.com'],
    ] as const)
      h.git$('-C', nested, 'config', key, value);
    writeFileSync(join(nested, 'lib.ts'), 'lib\n');
    h.git$('-C', nested, 'add', 'lib.ts');
    h.git$('-C', nested, 'commit', '-q', '-m', 'nested');

    const opened = await open([page('People: UI work', ['people'])]);

    expect(opened.dirt.map((d) => d.path)).toEqual(['src/people/page.tsx']);
    const ref = passDirtRef(opened.pass.id);
    const tree = h.git$('diff-tree', '-r', '--name-only', '--no-commit-id', `${ref}^`, ref);
    expect(tree).toBe('src/people/page.tsx');
    expect(existsSync(join(h.repo, 'empty-nested/.git'))).toBe(true);
  });

  it('answers with no count of commits ahead of the base when git cannot count them, and the pass stays open', async () => {
    harness();
    // origin's base names an object the repository does not have, so git can count nothing from it.
    writeFileSync(join(h.repo, '.git/refs/remotes/origin/main'), `${'1'.repeat(40)}\n`);
    const opened = await open([page('People: UI work', ['people'])]);
    expect(opened.aheadOfBase).toBeNull();
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
    expect(h.logs.lines().some((l) => l['msg'] === 'commits ahead of the base not counted')).toBe(
      true,
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

describe("a pass task's plan and its saved work", () => {
  it("runs only the project's implement step, and puts back each task's saved work once the pass is open", async () => {
    harness();
    const full = findFlowByName(h.store.db, 'full');
    const criteria = ['one', 'two', 'three', 'four'];
    const settings = h.addTask('Settings: UI work', {
      areas: ['settings'],
      acceptanceCriteria: criteria,
    });
    const people = page('People: UI work', ['people']);
    h.state.write((w) => {
      patchTask(w, settings.id, { flowId: full?.id ?? null, riskTags: ['migration'] });
      setTaskKeptWork(w, people.id, { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) });
    });
    const putBacks: { repo: string; taskId: string; head: string; inPass: boolean }[] = [];
    const opened = await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'Polish pages', taskIds: [settings.id, people.id] },
      {
        leaseMs: 60_000,
        putBack: ({ repo, taskId }) => {
          putBacks.push({
            repo,
            taskId,
            head: h.git$('symbolic-ref', '--short', 'HEAD'),
            inPass: getTask(h.store.db, taskId).passId != null,
          });
          return Promise.resolve({ applied: [], left: [] });
        },
      },
    );

    // No plan, plan review, review or QA step: a pass has one review, of its pull request.
    for (const task of [settings, people])
      expect(runOf(task)?.steps.map((step) => step.role)).toEqual(['implement']);
    // Only the task with saved work is put back, on the pass's branch, once it is in the pass.
    expect(putBacks).toEqual([
      {
        repo: h.project.repoPath,
        taskId: people.id,
        head: passBranchName('Polish pages', opened.pass.id),
        inPass: true,
      },
    ]);
  });

  it('opens even when a put-back fails: the pass is written', async () => {
    harness();
    const people = page('People: UI work', ['people']);
    h.state.write((w) => {
      setTaskKeptWork(w, people.id, { keptSha: 'b'.repeat(40), keptBaseSha: 'a'.repeat(40) });
    });
    const opened = await openPass(
      h.ctx,
      { projectId: h.project.id, name: 'Polish pages', taskIds: [people.id] },
      { leaseMs: 60_000, putBack: () => Promise.reject(new Error('merge-tree failed')) },
    );
    expect(opened.pass.state).toBe('OPEN');
    expect(getTask(h.store.db, people.id).passId).toBe(opened.pass.id);
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

  it.each<{ name: string; act: (batchId: BatchId, workstreamId: WorkstreamId) => unknown }>([
    { name: 'Ship', act: (b) => h.shipper.ship(b) },
    { name: 'Ship anyway', act: (b) => h.shipper.shipAnyway(b) },
    { name: 'Ship without it', act: (b, w) => h.shipper.shipWithout(b, w) },
    { name: 'Abandon', act: (b) => h.shipper.abandon(b) },
  ])('is refused by $name: only its pass ships or abandons it', async ({ act }) => {
    harness({}, false);
    const task = page('People: UI work', ['people']);
    const opened = await open([task]);
    const ws = runOf(task);
    if (!ws) throw new Error('the pass task has no workstream');
    h.settle(ws.id, 'DONE');
    expect(() => act(opened.batch.id, ws.id)).toThrow(/Workbench pass/);
    await h.jobs.idle();
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(opened.batch.branch);
  });

  it("is left to its pass by start-up's recovery when the folder is off its branch", async () => {
    harness({}, false);
    const opened = await open([page('People: UI work', ['people'])]);
    // The builder switched the folder while the daemon was down.
    h.git$('switch', '-q', 'main');
    const report = await recover();
    expect(report.failed).toEqual([]);
    expect(getBatch(h.store.db, opened.batch.id).state).toBe('OPEN');
    expect(h.cards()).toEqual([]);
  });
});

describe('a pass task', () => {
  it('starts as no ordinary work while its pass holds it', async () => {
    harness({}, false);
    const task = page('People: UI work', ['people']);
    await open([task]);
    const ws = runOf(task);
    if (!ws) throw new Error('the pass task has no workstream');
    h.settle(ws.id, 'CANCELLED');
    expect(() => h.starter.startTask(task.id)).toThrow(/in the Workbench pass "Polish pages"/);
    await h.jobs.idle();
    expect(runOf(task)?.id).toBe(ws.id);
  });
});

describe('a pass a crash left with no row', () => {
  /** What `openPassBranch` leaves when the daemon dies before the pass's write. */
  async function orphan(): Promise<{ branch: string; dirtRef: string }> {
    const id = mintId('Pass');
    const branch = passBranchName('Polish pages', id);
    const dirtRef = passDirtRef(id);
    await h.git.openPassBranch({ repo: h.repo, branch, dirtRef, message: 'the dirt' });
    return { branch, dirtRef };
  }

  it('is taken back at start-up: HEAD names its branch again, no file written', async () => {
    harness({}, false);
    write('src/people/page.tsx', 'edited by hand\n');
    const files = [...snapshot(h.repo)].filter(([path]) => !path.startsWith('.git/'));
    const { branch } = await orphan();
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(branch);
    await recover();
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(tenDbRefs()).toBe('');
    expect([...snapshot(h.repo)].filter(([path]) => !path.startsWith('.git/'))).toEqual(files);
    expect(h.cards()).toEqual([]);
  });

  it('loses its dirt record at start-up when the stop came before its branch was made', async () => {
    harness({}, false);
    const { branch } = await orphan();
    // What the stop leaves when it comes between the dirt's ref and the branch.
    h.git$('symbolic-ref', 'HEAD', 'refs/heads/main');
    h.git$('update-ref', '-d', `refs/heads/${branch}`);
    await recover();
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(tenDbRefs()).toBe('');
    expect(h.cards()).toEqual([]);
  });

  it('is named on a card when work was committed on its branch, and left as it is', async () => {
    harness({}, false);
    const { branch, dirtRef } = await orphan();
    const tip = h.commit('src/people/page.tsx', 'kept\n');
    await recover();
    expect(h.git$('symbolic-ref', '--short', 'HEAD')).toBe(branch);
    expect(h.git$('rev-parse', branch)).toBe(tip);
    expect(h.git$('rev-parse', '--verify', '-q', dirtRef)).not.toBe('');
    const card = h.only(h.cards().filter((c) => c.title.includes(branch)));
    expect(card.body).toContain('main');
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
