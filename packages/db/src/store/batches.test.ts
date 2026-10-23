import {
  ConflictError,
  InvalidError,
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
  getProject,
  insertBatch,
  insertTask,
  insertWorkstream,
  latestDoneWorkstream,
  listBatches,
  listProjectViews,
  listWorkstreams,
  patchBatch,
  patchProject,
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
        billingMode: 'subscription',
        model: 'sonnet',
        effort: 'medium',
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
    { name: 'pull requests without a prefix', input: { delivery: 'pull_request' } },
    { name: 'a base branch that is an option', input: { baseBranch: '-delete' } },
    {
      name: 'a prefix that is not a Conventional Commit type',
      input: { delivery: 'pull_request', prTitlePrefix: 'Feature' },
    },
  ])('refuses a project with $name', ({ input }) => {
    expect(() => seedProject(store, input)).toThrow();
  });

  it('refuses a patch that leaves pull request delivery without a prefix', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { delivery: 'pull_request' })),
    ).toThrow(InvalidError);
    const patched = store.write((ctx) =>
      patchProject(ctx, project.id, { delivery: 'pull_request', prTitlePrefix: 'feat(app)' }),
    ).value;
    expect(patched).toMatchObject({ delivery: 'pull_request', prTitlePrefix: 'feat(app)' });
    expect(() =>
      store.write((ctx) => patchProject(ctx, project.id, { prTitlePrefix: null })),
    ).toThrow(InvalidError);
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
