import {
  BoardStatus,
  ConflictError,
  EventType,
  TaskHasDependentsError,
  TaskStartedError,
  TaskStatus,
  WorkstreamState as S,
  NotFoundError,
  mintId,
  type TaskId,
  type WorkstreamId,
  type WorkstreamState,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertBoardColumn } from './board-columns';
import { countLanes, getWorkstream, insertWorkstream, transitionWorkstream } from './workstreams';
import { holdTask, resumeTask } from './holds';
import { insertSession } from './sessions';
import type { Store } from './store';
import { cancelTask, getTask, insertTask, listTasks, moveTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

function seedQueued(title = 'A', dependsOn: TaskId[] = []) {
  const project = seedProject(store);
  return seedQueuedIn(project.id, title, dependsOn);
}

function seedQueuedIn(
  projectId: ReturnType<typeof seedProject>['id'],
  title: string,
  dependsOn: TaskId[] = [],
) {
  const task = store.write((ctx) =>
    insertTask(ctx, projectId, { title, acceptanceCriteria: ['x'], areas: ['api'], dependsOn }),
  ).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { projectId, task, ws };
}

function walk(wsId: WorkstreamId, states: WorkstreamState[]) {
  for (const to of states)
    store.write((ctx) => transitionWorkstream(ctx, wsId, { to, fence: null }));
}

describe('holdTask', () => {
  it('holds a queued task that has not run: the run is HELD and the task shows as blocked', () => {
    const { task, ws } = seedQueued();
    const { value, events } = store.write((ctx) => holdTask(ctx, task.id));
    expect(value).toMatchObject({ id: ws.id, state: S.Held });
    expect(getWorkstream(store.db, ws.id).state).toBe(S.Held);
    expect(getTask(store.db, task.id)).toMatchObject({
      status: TaskStatus.Open,
      boardStatus: BoardStatus.Blocked,
      workstreamId: ws.id,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.WorkstreamChanged,
        entityId: ws.id,
        data: { from: S.Queued, to: S.Held, reason: 'held by the builder' },
      }),
    ]);
  });

  it('leaves the queue and takes no lane', () => {
    const { task } = seedQueued();
    store.write((ctx) => holdTask(ctx, task.id));
    expect(countLanes(store.db).global).toBe(0);
  });

  it('holding a held task answers it again and emits nothing', () => {
    const { task, ws } = seedQueued();
    store.write((ctx) => holdTask(ctx, task.id));
    const again = store.write((ctx) => holdTask(ctx, task.id));
    expect(again.value.id).toBe(ws.id);
    expect(again.events).toEqual([]);
  });

  it('refuses a task that has not started', () => {
    const project = seedProject(store);
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'N', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(ConflictError);
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(/hasn't been started/);
  });

  it('answers NotFoundError for an unknown task', () => {
    expect(() => store.write((ctx) => holdTask(ctx, mintId('Task')))).toThrow(NotFoundError);
  });

  it.each<[string, WorkstreamState[]]>([
    ['STARTING', [S.Starting]],
    ['RUNNING', [S.Starting, S.Running]],
    ['VERIFYING', [S.Starting, S.Running, S.Verifying]],
    ['WAITING_HUMAN', [S.Starting, S.Running, S.WaitingHuman]],
    ['PAUSED_LIMIT', [S.Starting, S.PausedLimit]],
    ['FAILED', [S.Starting, S.Running, S.Failed]],
    ['DONE', [S.Starting, S.Running, S.Verifying, S.Done]],
    ['CANCELLED', [S.Cancelled]],
  ])('refuses a task whose run is %s, and names the way to stop it', (_name, path) => {
    const { task, ws } = seedQueued('Busy');
    walk(ws.id, path);
    const before = getWorkstream(store.db, ws.id).state;
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(ConflictError);
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(/Busy/);
    expect(getWorkstream(store.db, ws.id).state).toBe(before);
  });

  it('refuses a queued run that already ran a session (a send-back or retry queues again)', () => {
    const { task, ws } = seedQueued('Ran');
    store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: 'hash',
      }),
    );
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(/has already run/);
    expect(getWorkstream(store.db, ws.id).state).toBe(S.Queued);
  });

  it('refuses a queued run that was recovered or retried before it ran a session', () => {
    const { task, ws } = seedQueued('Recovered');
    walk(ws.id, [S.Starting, S.Recovering, S.Queued]);
    store.db.update(schema.workstreams).set({ recoveryAttempts: 1 }).run();
    expect(() => store.write((ctx) => holdTask(ctx, task.id))).toThrow(/has already run/);
  });

  it('does not let a held task be dragged to another column', () => {
    const { projectId, task } = seedQueued();
    const column = store.write((ctx) => insertBoardColumn(ctx, projectId, { name: 'Later' })).value;
    store.write((ctx) => holdTask(ctx, task.id));
    expect(() =>
      store.write((ctx) => moveTask(ctx, task.id, { to: column.id, after: null, before: null })),
    ).toThrow(ConflictError);
  });
});

describe('resumeTask', () => {
  it('puts a held run back in the queue, as the same run', () => {
    const { task, ws } = seedQueued();
    store.write((ctx) => holdTask(ctx, task.id));
    const { value, events } = store.write((ctx) => resumeTask(ctx, task.id));
    expect(value).toMatchObject({ id: ws.id, state: S.Queued });
    expect(getTask(store.db, task.id).boardStatus).toBe(BoardStatus.InProgress);
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.WorkstreamChanged,
        data: { from: S.Held, to: S.Queued, reason: 'started again by the builder' },
      }),
    ]);
  });

  it('refuses a task whose run is not held', () => {
    const { task } = seedQueued('Waiting');
    expect(() => store.write((ctx) => resumeTask(ctx, task.id))).toThrow(/isn't held/);
  });
});

describe('removing a held task', () => {
  it('cancels its run and the task in one write, and drops it from the list', () => {
    const { projectId, task, ws } = seedQueued('Held one');
    store.write((ctx) => holdTask(ctx, task.id));
    const { value, events } = store.write((ctx) => cancelTask(ctx, task.id));
    expect(value.status).toBe(TaskStatus.Cancelled);
    expect(getWorkstream(store.db, ws.id).state).toBe(S.Cancelled);
    expect(listTasks(store.db, projectId)).toEqual([]);
    expect(events.map((e) => [e.type, e.entityId])).toEqual([
      [EventType.WorkstreamChanged, ws.id],
      [EventType.TaskChanged, task.id],
    ]);
  });

  it('still refuses a queued task that was never held', () => {
    const { task } = seedQueued();
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(TaskStartedError);
  });

  it('still refuses a held task an open task waits on', () => {
    const { projectId, task, ws } = seedQueued('base');
    store.write((ctx) => holdTask(ctx, task.id));
    store.write((ctx) =>
      insertTask(ctx, projectId, {
        title: 'child',
        acceptanceCriteria: ['x'],
        areas: ['api'],
        dependsOn: [task.id],
      }),
    );
    expect(() => store.write((ctx) => cancelTask(ctx, task.id))).toThrow(TaskHasDependentsError);
    expect(getWorkstream(store.db, ws.id).state).toBe(S.Held);
  });
});
