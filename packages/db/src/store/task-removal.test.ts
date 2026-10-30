import {
  ConflictError,
  EventType,
  InvalidError,
  TaskHasDependentsError,
  TaskStartedError,
  TaskStatus,
  WorkstreamState as S,
  NotFoundError,
  mintId,
  type TaskId,
  type WorkstreamState,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { activeClaims } from './claims';
import { listEventsAfter } from './events';
import type { Store } from './store';
import {
  insertBatch,
  recordPullRequestStatus,
  transitionBatch,
  type PullRequestStatusInput,
} from './batches';
import { insertBoardColumn } from './board-columns';
import {
  cancelTask,
  closeTask,
  dependenciesDone,
  getTask,
  insertTask,
  listTasks,
  moveTask,
  patchTask,
  reopenTask,
  setTaskStatus,
} from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, listWorkstreams, transitionWorkstream } from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seedTask(
  projectId: ReturnType<typeof seedProject>['id'],
  title = 'A',
  dependsOn: TaskId[] = [],
) {
  return store.write((ctx) =>
    insertTask(ctx, projectId, { title, acceptanceCriteria: ['x'], areas: ['api'], dependsOn }),
  ).value;
}

/** Walks a workstream along the state machine to `to`. */
const PATHS: Record<string, WorkstreamState[]> = {
  QUEUED: [],
  RUNNING: [S.Starting, S.Running],
  WAITING_HUMAN: [S.Starting, S.Running, S.WaitingHuman],
  FAILED: [S.Starting, S.Running, S.Failed],
  CANCELLED: [S.Cancelled],
};

describe('cancelTask', () => {
  it('marks an unstarted task cancelled, keeps its row and announces it', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    const { value, events } = store.write((ctx) => cancelTask(ctx, task.id));
    expect(value).toMatchObject({ id: task.id, status: TaskStatus.Cancelled });
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        entityId: task.id,
        data: { status: TaskStatus.Cancelled },
      }),
    ]);
    expect(getTask(store.db, task.id).status).toBe(TaskStatus.Cancelled);
    const row = store.db.select().from(schema.tasks).all();
    expect(row.map((r) => [r.id, r.status])).toEqual([[task.id, 'cancelled']]);
    expect(
      listEventsAfter(store.db, 0, 100).some(
        (e) => e.entityId === task.id && e.type === EventType.TaskChanged,
      ),
    ).toBe(true);
  });

  it('drops the task from the project list but not from lookup by id', () => {
    const project = seedProject(store);
    const keep = seedTask(project.id, 'keep');
    const gone = seedTask(project.id, 'gone');
    store.write((ctx) => cancelTask(ctx, gone.id));
    expect(listTasks(store.db, project.id).map((t) => t.id)).toEqual([keep.id]);
    expect(getTask(store.db, gone.id).title).toBe('gone');
  });

  it('is idempotent: a second remove answers the cancelled task and emits nothing', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    store.write((ctx) => cancelTask(ctx, task.id));
    const again = store.write((ctx) => cancelTask(ctx, task.id));
    expect(again.value.status).toBe(TaskStatus.Cancelled);
    expect(again.events).toEqual([]);
  });

  it('holds no claims to release', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    store.write((ctx) => cancelTask(ctx, task.id));
    expect(store.db.select().from(schema.claims).all()).toEqual([]);
    expect(activeClaims(store.db, mintId('Workstream'))).toEqual([]);
  });

  it('answers NotFoundError for an unknown id', () => {
    expect(() => store.write((ctx) => cancelTask(ctx, mintId('Task')))).toThrow(NotFoundError);
  });

  it.each(Object.keys(PATHS))(
    'refuses a task whose workstream is %s with TaskStartedError',
    (name) => {
      const project = seedProject(store);
      const task = seedTask(project.id);
      const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
      for (const to of PATHS[name] ?? [])
        store.write((ctx) => transitionWorkstream(ctx, ws.id, { to, fence: null }));
      expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(TaskStartedError);
      expect(getTask(store.db, task.id).status).toBe(TaskStatus.Open);
    },
  );

  it('refuses a done task with TaskStartedError', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    store.db.update(schema.tasks).set({ status: TaskStatus.Done }).run();
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(TaskStartedError);
  });

  it('refuses a task an open task waits on with TaskHasDependentsError naming it', () => {
    const project = seedProject(store);
    const base = seedTask(project.id, 'base');
    seedTask(project.id, 'child', [base.id]);
    expect(() => store.write((ctx) => cancelTask(ctx, base.id))).toThrow(TaskHasDependentsError);
    expect(() => store.write((ctx) => cancelTask(ctx, base.id))).toThrow(/child/);
  });

  it('lets a task go once its dependents are cancelled', () => {
    const project = seedProject(store);
    const base = seedTask(project.id, 'base');
    const child = seedTask(project.id, 'child', [base.id]);
    store.write((ctx) => cancelTask(ctx, child.id));
    expect(store.write((ctx) => cancelTask(ctx, base.id)).value.status).toBe(TaskStatus.Cancelled);
  });

  it('removes a task waiting on an unfinished dependency', () => {
    const project = seedProject(store);
    const base = seedTask(project.id, 'base');
    const child = seedTask(project.id, 'child', [base.id]);
    expect(store.write((ctx) => cancelTask(ctx, child.id)).value.status).toBe(TaskStatus.Cancelled);
  });

  it('refuses while the project has a batch being cut', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    store.write((ctx) =>
      insertBatch(ctx, { projectId: project.id, title: 'Cutting', baseBranch: 'main' }),
    );
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(/being cut/);
    expect(getTask(store.db, task.id).status).toBe(TaskStatus.Open);
  });

  it('clears the parked column of a removed task', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    const column = store.write((ctx) =>
      insertBoardColumn(ctx, project.id, { name: 'Later' }),
    ).value;
    store.write((ctx) => moveTask(ctx, task.id, { to: column.id, after: null, before: null }));
    expect(store.write((ctx) => cancelTask(ctx, task.id)).value.boardColumnId).toBeNull();
  });

  it('refuses a removed task as a new task dependency, and edits or moves of it', () => {
    const project = seedProject(store);
    const gone = seedTask(project.id, 'gone');
    store.write((ctx) => cancelTask(ctx, gone.id));
    expect(() => seedTask(project.id, 'child', [gone.id])).toThrow(InvalidError);
    expect(() => store.write((ctx) => patchTask(ctx, gone.id, { title: 'x' }))).toThrow(
      ConflictError,
    );
    expect(() =>
      store.write((ctx) => moveTask(ctx, gone.id, { to: null, after: null, before: null })),
    ).toThrow(/removed/);
  });

  it('names the cancel route only for a live workstream', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(
      `/workstreams/${ws.id}/cancel`,
    );
    store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Cancelled, fence: null }));
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(/already run/);
  });
});

describe('closeTask', () => {
  function failedTask(projectId: ReturnType<typeof seedProject>['id'], title = 'A') {
    const task = seedTask(projectId, title);
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    for (const to of PATHS['FAILED'] ?? [])
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to, fence: null }));
    return { task, ws };
  }

  it('closes a task whose latest run failed: cancelled, off the list, run history kept', () => {
    const project = seedProject(store);
    const { task, ws } = failedTask(project.id);
    const { value, events } = store.write((ctx) => closeTask(ctx, task.id));
    expect(value.status).toBe(TaskStatus.Cancelled);
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        entityId: task.id,
        data: { status: TaskStatus.Cancelled },
      }),
    ]);
    expect(listTasks(store.db, project.id)).toEqual([]);
    expect(listWorkstreams(store.db, {}).map((w) => [w.id, w.state])).toEqual([[ws.id, S.Failed]]);
  });

  it('clears the parked column', () => {
    const project = seedProject(store);
    const { task } = failedTask(project.id);
    const column = store.write((ctx) =>
      insertBoardColumn(ctx, project.id, { name: 'Later' }),
    ).value;
    store.db
      .update(schema.tasks)
      .set({ boardColumnId: column.id })
      .where(eq(schema.tasks.id, task.id))
      .run();
    expect(store.write((ctx) => closeTask(ctx, task.id)).value.boardColumnId).toBeNull();
  });

  it('is idempotent once closed', () => {
    const project = seedProject(store);
    const { task } = failedTask(project.id);
    store.write((ctx) => closeTask(ctx, task.id));
    const again = store.write((ctx) => closeTask(ctx, task.id));
    expect(again.value.status).toBe(TaskStatus.Cancelled);
    expect(again.events).toEqual([]);
  });

  it.each(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'CANCELLED'])(
    'refuses a task whose latest run is %s',
    (name) => {
      const project = seedProject(store);
      const task = seedTask(project.id);
      const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
      for (const to of PATHS[name] ?? [])
        store.write((ctx) => transitionWorkstream(ctx, ws.id, { to, fence: null }));
      expect(() => store.write((ctx) => closeTask(ctx, task.id))).toThrow(ConflictError);
      expect(getTask(store.db, task.id).status).toBe(TaskStatus.Open);
    },
  );

  it('refuses a task that never ran', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    expect(() => store.write((ctx) => closeTask(ctx, task.id))).toThrow(/hasn't failed/);
  });

  it('closes a task whose newest run failed after an earlier one was cancelled', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    const first = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    store.write((ctx) => transitionWorkstream(ctx, first.id, { to: S.Cancelled, fence: null }));
    const second = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    for (const to of PATHS['FAILED'] ?? [])
      store.write((ctx) => transitionWorkstream(ctx, second.id, { to, fence: null }));
    expect(store.write((ctx) => closeTask(ctx, task.id)).value.status).toBe(TaskStatus.Cancelled);
  });

  it('refuses a done task', () => {
    const project = seedProject(store);
    const { task } = failedTask(project.id);
    store.db.update(schema.tasks).set({ status: TaskStatus.Done }).run();
    expect(() => store.write((ctx) => closeTask(ctx, task.id))).toThrow(ConflictError);
  });

  it('refuses while open tasks wait on it, naming them', () => {
    const project = seedProject(store);
    const { task } = failedTask(project.id, 'base');
    seedTask(project.id, 'child one', [task.id]);
    seedTask(project.id, 'child two', [task.id]);
    const attempt = () => store.write((ctx) => closeTask(ctx, task.id));
    expect(attempt).toThrow(TaskHasDependentsError);
    expect(attempt).toThrow(/child one, child two/);
    expect(attempt).toThrow(/closed/);
    expect(getTask(store.db, task.id).status).toBe(TaskStatus.Open);
  });

  it('lets a task go once its dependents are removed', () => {
    const project = seedProject(store);
    const { task } = failedTask(project.id, 'base');
    const child = seedTask(project.id, 'child', [task.id]);
    store.write((ctx) => cancelTask(ctx, child.id));
    expect(store.write((ctx) => closeTask(ctx, task.id)).value.status).toBe(TaskStatus.Cancelled);
  });

  it('answers NotFoundError for an unknown id', () => {
    expect(() => store.write((ctx) => closeTask(ctx, mintId('Task')))).toThrow(NotFoundError);
  });
});

describe('a task whose pull request closed without merging', () => {
  const PR = 'https://github.com/o/r/pull/7';
  const read = (state: 'open' | 'closed' | 'merged'): PullRequestStatusInput => ({
    state,
    checks: 'passing',
    failingChecks: [],
    checkedAt: '2026-10-29T12:00:00.000Z',
    unknownReason: null,
  });

  /** A task whose run is DONE in a SHIPPED batch whose pull request reads `state`. */
  function inReview(projectId: ReturnType<typeof seedProject>['id'], state: 'open' | 'closed') {
    const task = seedTask(projectId, 'A');
    const batch = store.write((ctx) =>
      insertBatch(ctx, { projectId, title: 'B', baseBranch: 'main' }),
    ).value;
    for (const to of ['OPEN', 'SHIPPING'] as const)
      store.write((ctx) => transitionBatch(ctx, batch.id, { to }));
    store.write((ctx) => transitionBatch(ctx, batch.id, { to: 'SHIPPED', patch: { prUrl: PR } }));
    const ws = store.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id })).value;
    for (const to of [S.Starting, S.Running, S.Verifying, S.Done])
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to, fence: null }));
    store.write((ctx) => {
      setTaskStatus(ctx, task.id, 'done');
    });
    store.write((ctx) => recordPullRequestStatus(ctx, batch.id, read(state)));
    return { task, batch };
  }

  it('is in review while the pull request is open, and back with the builder once it closes', () => {
    const project = seedProject(store);
    const { task, batch } = inReview(project.id, 'open');
    expect(getTask(store.db, task.id).boardStatus).toBe('in_review');
    store.write((ctx) => recordPullRequestStatus(ctx, batch.id, read('closed')));
    expect(getTask(store.db, task.id).boardStatus).toBe('blocked');
    store.write((ctx) => recordPullRequestStatus(ctx, batch.id, read('merged')));
    expect(getTask(store.db, task.id).boardStatus).toBe('done');
  });

  it('counts a failed run that shipped anyway as done once its pull request merges, so dependents start', () => {
    const project = seedProject(store);
    const { task, batch } = inReview(project.id, 'open');
    const child = seedTask(project.id, 'child', [task.id]);
    // Ship anyway: the run failed, the task never reached done, and its batch shipped.
    store.db
      .update(schema.tasks)
      .set({ status: TaskStatus.Open })
      .where(eq(schema.tasks.id, task.id))
      .run();
    store.db.update(schema.workstreams).set({ state: S.Failed }).run();
    expect(getTask(store.db, task.id).boardStatus).toBe('in_review');
    expect(dependenciesDone(store.db, child.id)).toBe(false);
    store.write((ctx) => recordPullRequestStatus(ctx, batch.id, read('merged')));
    expect(getTask(store.db, task.id).boardStatus).toBe('done');
    expect(getTask(store.db, child.id).boardStatus).toBe('ready');
    expect(dependenciesDone(store.db, child.id)).toBe(true);
  });

  it('can be closed: it leaves the list and keeps its run', () => {
    const project = seedProject(store);
    const { task } = inReview(project.id, 'closed');
    const { value } = store.write((ctx) => closeTask(ctx, task.id));
    expect(value.status).toBe(TaskStatus.Cancelled);
    expect(listTasks(store.db, project.id)).toEqual([]);
    expect(listWorkstreams(store.db, { projectId: project.id })).toHaveLength(1);
  });

  it('can be reopened: open again, in Ready, announced', () => {
    const project = seedProject(store);
    const { task } = inReview(project.id, 'closed');
    const { value, events } = store.write((ctx) => reopenTask(ctx, task.id));
    expect(value).toMatchObject({ status: TaskStatus.Open, boardStatus: 'ready' });
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityId: task.id,
        data: { status: TaskStatus.Open },
      }),
    ]);
  });

  it('can be reopened and then started again', () => {
    const project = seedProject(store);
    const { task } = inReview(project.id, 'closed');
    store.write((ctx) => reopenTask(ctx, task.id));
    const again = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    expect(again.state).toBe(S.Queued);
  });

  it('judges a reopened task by its new run, not the earlier closed pull request', () => {
    const project = seedProject(store);
    const { task } = inReview(project.id, 'closed');
    store.write((ctx) => reopenTask(ctx, task.id));
    // The new run finishes before it is put in a batch.
    const again = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
    for (const to of [S.Starting, S.Running, S.Verifying, S.Done])
      store.write((ctx) => transitionWorkstream(ctx, again.id, { to, fence: null }));
    store.write((ctx) => {
      setTaskStatus(ctx, task.id, 'done');
    });
    expect(() => store.write((ctx) => closeTask(ctx, task.id))).toThrow(ConflictError);
    expect(() => store.write((ctx) => reopenTask(ctx, task.id))).toThrow(ConflictError);
  });

  it('is not closed or reopened while its pull request is open', () => {
    const project = seedProject(store);
    const { task } = inReview(project.id, 'open');
    expect(() => store.write((ctx) => closeTask(ctx, task.id))).toThrow(ConflictError);
    expect(() => store.write((ctx) => reopenTask(ctx, task.id))).toThrow(ConflictError);
  });

  it('refuses a reopen for a task that never shipped', () => {
    const project = seedProject(store);
    const task = seedTask(project.id);
    expect(() => store.write((ctx) => reopenTask(ctx, task.id))).toThrow(ConflictError);
  });

  it('answers NotFoundError for an unknown id', () => {
    expect(() => store.write((ctx) => reopenTask(ctx, mintId('Task')))).toThrow(NotFoundError);
  });
});
