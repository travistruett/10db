import {
  ConflictError,
  EventType,
  NotFoundError,
  queueOrder,
  TaskStatus,
  WorkstreamState,
  type ProjectDto,
  type TaskDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { createTestStore, seedProject } from './test-support';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import {
  getWorkstream,
  insertWorkstream,
  listWorkstreams,
  runNext,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
let project: ProjectDto;
let tick = 0;
beforeEach(() => {
  // Every write is a second after the last, so two presses never share a timestamp.
  tick = 0;
  ({ store, close } = createTestStore(() => new Date(Date.UTC(2026, 9, 29, 12, 0, (tick += 1)))));
  project = seedProject(store);
});
afterEach(() => {
  close();
});

function queued(title: string, dependsOn: TaskDto['id'][] = []) {
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'], dependsOn }),
  ).value;
  const workstream = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { task, workstream };
}

const lineOf = () =>
  listWorkstreams(store.db, { states: [WorkstreamState.Queued] })
    .toSorted(queueOrder)
    .map((w) => w.taskTitle);

describe('runNext', () => {
  it('puts a queued task ahead of every other, the latest press first', () => {
    const a = queued('a');
    const b = queued('b');
    const c = queued('c');
    expect(lineOf()).toEqual(['a', 'b', 'c']);
    store.write((ctx) => runNext(ctx, c.task.id));
    expect(lineOf()).toEqual(['c', 'a', 'b']);
    store.write((ctx) => runNext(ctx, b.task.id));
    expect(lineOf()).toEqual(['b', 'c', 'a']);
    expect(getWorkstream(store.db, a.workstream.id).runNextAt).toBeNull();
    expect(getWorkstream(store.db, b.workstream.id).runNextAt).not.toBeNull();
  });

  it('names the unfinished dependencies, and none once they are done', () => {
    const dep = queued('dep');
    const waiting = queued('waiting', [dep.task.id]);
    expect(store.write((ctx) => runNext(ctx, waiting.task.id)).value.waitingOn).toEqual(['dep']);
    store.write((ctx) => {
      setTaskStatus(ctx, dep.task.id, TaskStatus.Done);
    });
    expect(store.write((ctx) => runNext(ctx, waiting.task.id)).value.waitingOn).toEqual([]);
  });

  it('appends an event the Board refreshes on', () => {
    const a = queued('a');
    store.write((ctx) => runNext(ctx, a.task.id));
    const event = listEventsAfter(store.db, 0, 1000).at(-1);
    expect(event).toMatchObject({
      type: EventType.WorkstreamChanged,
      entityId: a.workstream.id,
      data: { from: 'QUEUED', to: 'QUEUED', reason: 'run next' },
    });
  });

  it.each([WorkstreamState.Starting, WorkstreamState.Cancelled])(
    'refuses a task whose latest workstream is %s',
    (to) => {
      const a = queued('a');
      store.write((ctx) => transitionWorkstream(ctx, a.workstream.id, { to, fence: null }));
      expect(() => store.write((ctx) => runNext(ctx, a.task.id))).toThrow(ConflictError);
    },
  );

  it('refuses a task that never started', () => {
    const task = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'idle', acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
    expect(() => store.write((ctx) => runNext(ctx, task.id))).toThrow(ConflictError);
  });

  it('refuses an unknown task', () => {
    expect(() =>
      store.write((ctx) => runNext(ctx, 'tsk_00000000-0000-7000-8000-000000000000' as never)),
    ).toThrow(NotFoundError);
  });
});
