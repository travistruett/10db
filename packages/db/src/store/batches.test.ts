import {
  ConflictError,
  mintId,
  UNFINISHED_BATCH_STATES,
  type BatchId,
  type BatchState,
  type ProjectId,
  type ProjectInput,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  createTestStore,
  currentBatch,
  deleteCuttingBatch,
  findUnfinishedBatch,
  getBatch,
  getBatchRow,
  clearWorktreePath,
  findBatchByWorktreePath,
  getProject,
  getWorkstream,
  insertBatch,
  insertTask,
  insertWorkstream,
  latestDoneWorkstream,
  listBatches,
  listCheckoutReturns,
  listLiveWorktrees,
  listUnfinishedBatches,
  listProjectViews,
  listWorkstreams,
  patchBatch,
  patchProject,
  seedAccount,
  seedProject,
  transitionBatch,
  transitionWorkstream,
  type Store,
} from './index';

let store: Store;
let close: () => void;
beforeEach(() => {
  ({ store, close } = createTestStore());
});
afterEach(() => {
  close();
});

const AT = '2026-10-21T12:00:00.000Z';
const prProject = () =>
  seedProject(store, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
const newBatch = (projectId: ProjectId, title = 'Greetings') =>
  store.write((ctx) => insertBatch(ctx, { projectId, title, baseBranch: 'main' })).value;
const move = (id: BatchId, ...states: BatchState[]) => {
  for (const to of states) store.write((ctx) => transitionBatch(ctx, id, { to }));
};
const addTask = (projectId: ProjectId, title = 'Alpha') =>
  store.write((ctx) =>
    insertTask(ctx, projectId, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;

/** Bypasses the repository, so only the partial unique index stands between two unfinished rows. */
function rawBatch(projectId: ProjectId, state: BatchState): void {
  store.db
    .insert(schema.batches)
    .values({
      id: mintId('Batch'),
      projectId,
      title: 'raw',
      state,
      baseBranch: 'main',
      createdAt: AT,
      updatedAt: AT,
    })
    .run();
}

/** drizzle wraps the SQLite error; its cause carries the constraint's name. */
function sqliteMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} ${error.cause.message}` : error.message;
}

describe('batches', () => {
  it('inserts a CUTTING batch with no branch yet and emits batch.updated', () => {
    const project = prProject();
    const { value: batch, events } = store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'Greetings', baseBranch: 'main' }),
    );
    expect(batch).toMatchObject({
      projectId: project.id,
      title: 'Greetings',
      state: 'CUTTING',
      branch: null,
      baseBranch: 'main',
      baseSha: null,
      repo: null,
      prUrl: null,
      failure: null,
    });
    expect(events.map((e) => [e.type, e.entityType, e.entityId])).toEqual([
      ['batch.updated', 'batch', batch.id],
    ]);
  });

  it('refuses a second unfinished batch in a project, naming the first', () => {
    const project = prProject();
    newBatch(project.id, 'First');
    expect(() => newBatch(project.id, 'Second')).toThrow(ConflictError);
    expect(() => newBatch(project.id, 'Second')).toThrow(/First/);
    expect(newBatch(prProject().id).state).toBe('CUTTING');
  });

  it.each(UNFINISHED_BATCH_STATES)(
    'the unique index refuses a second unfinished batch while one is %s',
    (state) => {
      const project = prProject();
      rawBatch(project.id, state);
      let error: unknown = null;
      try {
        rawBatch(project.id, 'CUTTING');
      } catch (caught) {
        error = caught;
      }
      expect(sqliteMessage(error)).toMatch(/UNIQUE constraint failed: batches\.project_id/);
    },
  );

  it.each<BatchState>(['SHIPPED', 'CLOSED', 'ABANDONED'])(
    'allows a new batch beside a %s one',
    (state) => {
      const project = prProject();
      rawBatch(project.id, state);
      expect(newBatch(project.id).state).toBe('CUTTING');
    },
  );

  it('moves only along the batch state machine and records each move', () => {
    const batch = newBatch(prProject().id);
    expect(() => store.write((ctx) => transitionBatch(ctx, batch.id, { to: 'SHIPPING' }))).toThrow(
      ConflictError,
    );
    const { events } = store.write((ctx) =>
      transitionBatch(ctx, batch.id, {
        to: 'OPEN',
        patch: { branch: '10db/greetings-0a1b2c3d', baseSha: 'a'.repeat(40), repo: 'acme/widgets' },
        reason: 'branch cut',
      }),
    );
    expect(getBatch(store.db, batch.id)).toMatchObject({
      state: 'OPEN',
      branch: '10db/greetings-0a1b2c3d',
      repo: 'acme/widgets',
    });
    expect(events[0]?.data).toEqual({ from: 'CUTTING', to: 'OPEN', reason: 'branch cut' });
  });

  it('keeps the gate pid on the row, out of the DTO, and emits on every change', () => {
    const batch = newBatch(prProject().id);
    const { value, events } = store.write((ctx) =>
      patchBatch(ctx, batch.id, {
        gatePid: 4242,
        gatePidStart: 'Tue Oct 21 12:00:00 2026',
        gateExitCode: 0,
      }),
    );
    expect(value.gateExitCode).toBe(0);
    expect(value).not.toHaveProperty('gatePid');
    expect(getBatchRow(store.db, batch.id)).toMatchObject({ gatePid: 4242 });
    expect(events.map((e) => e.type)).toEqual(['batch.updated']);
  });

  it('deletes only a CUTTING batch, and says so in an event', () => {
    const batch = newBatch(prProject().id);
    const { events } = store.write((ctx) => {
      deleteCuttingBatch(ctx, batch.id, 'the checkout is dirty');
    });
    expect(listBatches(store.db)).toEqual([]);
    expect(events[0]?.data).toEqual({ from: 'CUTTING', to: null, reason: 'the checkout is dirty' });
    const open = newBatch(prProject().id);
    move(open.id, 'OPEN');
    expect(() =>
      store.write((ctx) => {
        deleteCuttingBatch(ctx, open.id, 'too late');
      }),
    ).toThrow(ConflictError);
  });

  it("reports a project's unfinished batch as current, else its latest", () => {
    const project = prProject();
    expect(currentBatch(store.db, project.id)).toBeNull();
    const first = newBatch(project.id, 'First');
    move(first.id, 'OPEN', 'SHIPPING', 'CLOSED');
    expect(findUnfinishedBatch(store.db, project.id)).toBeUndefined();
    expect(currentBatch(store.db, project.id)?.id).toBe(first.id);
    const second = newBatch(project.id, 'Second');
    expect(currentBatch(store.db, project.id)?.id).toBe(second.id);
    expect(listProjectViews(store.db).find((p) => p.id === project.id)?.currentBatch?.id).toBe(
      second.id,
    );
    expect(listBatches(store.db, { projectId: project.id }).map((b) => b.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("lists a batch's workstreams and finds a task's latest done workstream", () => {
    const project = prProject();
    const batch = newBatch(project.id);
    move(batch.id, 'OPEN');
    const task = addTask(project.id);
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id })).value;
    expect(ws.batchId).toBe(batch.id);
    expect(listWorkstreams(store.db, { batchId: batch.id }).map((w) => w.id)).toEqual([ws.id]);
    expect(latestDoneWorkstream(store.db, task.id)).toBeUndefined();
    store.write((ctx) => {
      for (const to of ['STARTING', 'RUNNING', 'VERIFYING', 'DONE'] as const)
        transitionWorkstream(ctx, ws.id, { to, fence: null });
    });
    expect(latestDoneWorkstream(store.db, task.id)?.batchId).toBe(batch.id);
  });
});

describe('worktree batches', () => {
  const worktreeProject = () =>
    seedProject(store, {
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      workspaceMode: 'worktree',
    });
  const newWorktree = (projectId: ProjectId, title: string, path = `/wt/${title}`) =>
    store.write((ctx) =>
      insertBatch(ctx, { projectId, title, baseBranch: 'main', worktreePath: path }),
    ).value;

  it('a project holds one unfinished shared batch and any number of worktree batches', () => {
    const worktree = worktreeProject();
    const a = newWorktree(worktree.id, 'A');
    const b = newWorktree(worktree.id, 'B');
    expect([a.worktreePath, b.worktreePath]).toEqual(['/wt/A', '/wt/B']);
    const shared = prProject();
    newBatch(shared.id, 'First');
    expect(() => newBatch(shared.id, 'Second')).toThrow(ConflictError);
  });

  it('the unique index refuses a second unfinished shared batch but not a worktree one', () => {
    const project = prProject();
    const raw = (path: string | null) =>
      store.db.$client
        .prepare(
          `INSERT INTO batches (id, project_id, title, state, base_branch, worktree_path, created_at, updated_at)
           VALUES (?, ?, 'raw', 'OPEN', 'main', ?, ?, ?)`,
        )
        .run(mintId('Batch'), project.id, path, AT, AT);
    raw(null);
    raw('/wt/one');
    raw('/wt/two');
    expect(() => raw(null)).toThrow(/UNIQUE constraint failed: batches\.project_id/);
  });

  it('findUnfinishedBatch ignores worktree batches, open or shipped', () => {
    const project = worktreeProject();
    const open = newWorktree(project.id, 'Open');
    const done = newWorktree(project.id, 'Done');
    move(done.id, 'OPEN', 'SHIPPING', 'SHIPPED');
    expect(findUnfinishedBatch(store.db, project.id)).toBeUndefined();
    expect(open.worktreePath).not.toBeNull();
  });

  it('listUnfinishedBatches answers every unfinished batch, newest first', () => {
    const project = worktreeProject();
    const a = newWorktree(project.id, 'A');
    const b = newWorktree(project.id, 'B');
    const done = newWorktree(project.id, 'Done');
    move(done.id, 'OPEN', 'SHIPPING', 'CLOSED');
    expect(listUnfinishedBatches(store.db, project.id).map((x) => x.id)).toEqual([b.id, a.id]);
    expect(listProjectViews(store.db).find((p) => p.id === project.id)?.openBatches).toHaveLength(
      2,
    );
  });

  it('currentBatch is the newest unfinished batch, else the latest', () => {
    const shared = prProject();
    const only = newBatch(shared.id);
    expect(currentBatch(store.db, shared.id)?.id).toBe(only.id);

    const many = worktreeProject();
    newWorktree(many.id, 'A');
    newWorktree(many.id, 'B');
    const newest = newWorktree(many.id, 'C');
    expect(currentBatch(store.db, many.id)?.id).toBe(newest.id);

    const finished = worktreeProject();
    newWorktree(finished.id, 'A');
    const latest = newWorktree(finished.id, 'B');
    for (const batch of listUnfinishedBatches(store.db, finished.id))
      move(batch.id, 'OPEN', 'SHIPPING', 'CLOSED');
    expect(currentBatch(store.db, finished.id)?.id).toBe(latest.id);
  });

  it('listLiveWorktrees keeps an ABANDONED batch whose path is set and drops a cleared one', () => {
    const project = worktreeProject();
    const kept = newWorktree(project.id, 'Kept');
    const cleared = newWorktree(project.id, 'Cleared');
    move(kept.id, 'OPEN', 'ABANDONED');
    move(cleared.id, 'OPEN', 'ABANDONED');
    store.write((ctx) => clearWorktreePath(ctx, cleared.id));
    newBatch(prProject().id);
    expect(listLiveWorktrees(store.db).map((b) => b.id)).toEqual([kept.id]);
  });

  it('listCheckoutReturns lists only finished batches that still hold a return place, newest first', () => {
    const project = prProject();
    const remember = (id: BatchId) =>
      store.write((ctx) =>
        patchBatch(ctx, id, { returnBranch: 'main', returnSha: 'a'.repeat(40) }),
      );
    const ended: Record<string, BatchId> = {};
    for (const [title, states] of [
      ['Shipped', ['OPEN', 'SHIPPING', 'SHIPPED']],
      ['Closed', ['OPEN', 'SHIPPING', 'CLOSED']],
      ['Abandoned', ['OPEN', 'ABANDONED']],
      ['Detached', ['OPEN', 'ABANDONED']],
      ['Cleared', ['OPEN', 'ABANDONED']],
      ['Never recorded', ['OPEN', 'ABANDONED']],
    ] as const) {
      const batch = newBatch(project.id, title);
      if (title !== 'Never recorded') remember(batch.id);
      move(batch.id, ...states);
      ended[title] = batch.id;
    }
    const detached = ended['Detached'];
    const cleared = ended['Cleared'];
    if (!detached || !cleared) throw new Error('batches expected');
    store.write((ctx) => patchBatch(ctx, detached, { returnBranch: null }));
    store.write((ctx) => patchBatch(ctx, cleared, { returnBranch: null, returnSha: null }));
    const open = newBatch(project.id, 'Open');
    remember(open.id);
    move(open.id, 'OPEN');
    expect(listCheckoutReturns(store.db).map((b) => [b.title, b.returnBranch])).toEqual([
      ['Detached', null],
      ['Abandoned', 'main'],
      ['Closed', 'main'],
      ['Shipped', 'main'],
    ]);
  });

  it('findBatchByWorktreePath matches the stored path exactly', () => {
    const project = worktreeProject();
    const batch = newWorktree(project.id, 'A', '/wt/exact');
    expect(findBatchByWorktreePath(store.db, '/wt/exact')?.id).toBe(batch.id);
    expect(findBatchByWorktreePath(store.db, '/wt/exact/')).toBeUndefined();
    expect(findBatchByWorktreePath(store.db, '/wt/exac')).toBeUndefined();
  });

  it('clearWorktreePath clears the path and emits batch.updated', () => {
    const batch = newWorktree(worktreeProject().id, 'A');
    const { value, events } = store.write((ctx) => clearWorktreePath(ctx, batch.id));
    expect(value.worktreePath).toBeNull();
    expect(getBatch(store.db, batch.id).worktreePath).toBeNull();
    expect(events.map((e) => [e.type, e.entityId, e.data])).toEqual([
      ['batch.updated', batch.id, { changed: ['worktreePath'] }],
    ]);
  });

  it('deleteCuttingBatch cancels and detaches the workstreams of a cutting batch', () => {
    const project = worktreeProject();
    const batch = newWorktree(project.id, 'A');
    const tasks = [addTask(project.id, 'T1'), addTask(project.id, 'T2')];
    const streams = tasks.map(
      (task) => store.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id })).value,
    );
    const { events } = store.write((ctx) => {
      deleteCuttingBatch(ctx, batch.id, 'refused');
    });
    expect(listBatches(store.db)).toEqual([]);
    for (const ws of streams) {
      const after = getWorkstream(store.db, ws.id);
      expect(after.state).toBe('CANCELLED');
      expect(after.batchId).toBeNull();
    }
    expect(events.filter((e) => e.type === 'workstream.changed')).toHaveLength(2);
    for (const task of tasks) {
      const again = store.write((ctx) => insertWorkstream(ctx, task.id));
      expect(again.value.state).toBe('QUEUED');
    }
  });
});

describe('project delivery', () => {
  it('defaults to local delivery on main with no prefix', () => {
    expect(seedProject(store)).toMatchObject({
      delivery: 'local',
      baseBranch: 'main',
      prTitlePrefix: null,
    });
  });

  it('fills the column defaults for a row written without the delivery columns', () => {
    const id = mintId('Project');
    const account = seedAccount(store, { kind: 'claude_subscription', label: 'raw' });
    store.db
      .insert(schema.projects)
      .values({
        id,
        name: 'raw',
        repoPath: '/tmp/raw-delivery',
        gateCommand: 'true',
        areas: [],
        hazards: [],
        maxLanes: 1,
        provider: 'claude',
        accountId: account.id,
        handoffPct: 40,
        nudgePct: 50,
        humanWaitMinutes: 10,
        createdAt: AT,
        updatedAt: AT,
      })
      .run();
    expect(getProject(store.db, id)).toMatchObject({
      delivery: 'local',
      baseBranch: 'main',
      prTitlePrefix: null,
    });
  });

  it.each<{ name: string; input: Partial<ProjectInput> }>([
    { name: 'a base branch that is an option', input: { baseBranch: '-delete' } },
    {
      name: 'a prefix that is not a Conventional Commit type',
      input: { delivery: 'pull_request', prTitlePrefix: 'Feature' },
    },
  ])('refuses a project with $name', ({ input }) => {
    expect(() => seedProject(store, input)).toThrow();
  });

  it('lets pull request delivery run with no prefix, and clears one', () => {
    const project = seedProject(store);
    const bare = store.write((ctx) =>
      patchProject(ctx, project.id, { delivery: 'pull_request' }),
    ).value;
    expect(bare).toMatchObject({ delivery: 'pull_request', prTitlePrefix: null });
    const patched = store.write((ctx) =>
      patchProject(ctx, project.id, { prTitlePrefix: 'feat(app)' }),
    ).value;
    expect(patched).toMatchObject({ delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    const cleared = store.write((ctx) =>
      patchProject(ctx, project.id, { prTitlePrefix: null }),
    ).value;
    expect(cleared).toMatchObject({ delivery: 'pull_request', prTitlePrefix: null });
  });

  it('creates a pull request project with no prefix', () => {
    expect(seedProject(store, { delivery: 'pull_request' })).toMatchObject({
      delivery: 'pull_request',
      prTitlePrefix: null,
    });
  });

  it.each<{ name: string; arrange: (projectId: ProjectId) => void }>([
    {
      name: 'an active workstream',
      arrange: (projectId) => {
        const task = addTask(projectId);
        store.write((ctx) => insertWorkstream(ctx, task.id));
      },
    },
    { name: 'an unfinished batch', arrange: (projectId) => newBatch(projectId) },
  ])('refuses to change delivery while the project has $name', ({ arrange }) => {
    const project = seedProject(store);
    arrange(project.id);
    expect(() =>
      store.write((ctx) =>
        patchProject(ctx, project.id, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' }),
      ),
    ).toThrow(ConflictError);
  });
});
