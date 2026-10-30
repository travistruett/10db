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
import { insertBatch } from './batches';
import { insertBoardColumn } from './board-columns';
import {
  cancelTask,
  closeTask,
  getTask,
  insertTask,
  listTasks,
  moveTask,
  patchTask,
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
