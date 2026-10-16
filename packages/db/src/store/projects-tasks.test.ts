import {
  BoardStatus,
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { getProject, insertProject, listProjects } from './projects';
import type { Store, WriteContext } from './store';
import { deriveBoardStatus, insertTask, listTasks, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const insertMinimalProject = (ctx: WriteContext) =>
  insertProject(ctx, {
    name: 'x',
    repoPath: '/tmp/x',
    gateCommand: 'true',
    areas: [{ name: 'src', globs: ['src/**'] }],
  });

describe('store.write', () => {
  it('commits rows and events together and returns the persisted events', () => {
    const { value: project, events } = store.write(insertMinimalProject);
    expect(events.map((e) => e.type)).toEqual([EventType.ProjectCreated]);
    expect(events[0]?.entityId).toBe(project.id);
    expect(listEventsAfter(store.db, 0, 10)).toEqual(events);
  });

  it('rolls back rows and events when the function throws', () => {
    expect(() =>
      store.write((ctx) => {
        insertMinimalProject(ctx);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(listProjects(store.db)).toEqual([]);
    expect(listEventsAfter(store.db, 0, 10)).toEqual([]);
  });
});

describe('projects', () => {
  it('throws NotFoundError for an unknown project', () => {
    expect(() => getProject(store.db, mintId('Project'))).toThrow(NotFoundError);
  });

  it('rejects a second project on the same repository with ConflictError', () => {
    store.write(insertMinimalProject);
    expect(() => store.write(insertMinimalProject)).toThrow(ConflictError);
    expect(listProjects(store.db)).toHaveLength(1);
  });
});

describe('tasks', () => {
  it('lists tasks with dependencies and a derived board status', () => {
    const project = seedProject(store);
    const a = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] }),
    ).value;
    const b = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'B',
        acceptanceCriteria: ['b'],
        areas: ['ui'],
        dependsOn: [a.id],
      }),
    ).value;
    const byTitle = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(byTitle['A']?.boardStatus).toBe(BoardStatus.Ready);
    expect(byTitle['B']).toMatchObject({ boardStatus: BoardStatus.Backlog, dependsOn: [a.id] });

    store.write((ctx) => {
      setTaskStatus(ctx, a.id, 'done');
    });
    const after = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(after['A']?.boardStatus).toBe(BoardStatus.Done);
    expect(after['B']?.boardStatus).toBe(BoardStatus.Ready);
    expect(b.id).toBe(after['B']?.id);
  });

  it('rejects an area the project does not define', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, project.id, { title: 'X', acceptanceCriteria: ['x'], areas: ['nope'] }),
      ),
    ).toThrow(InvalidError);
  });

  it('rejects a dependency from another project', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    const other = store.write((ctx) =>
      insertTask(ctx, p2.id, { title: 'O', acceptanceCriteria: ['o'], areas: ['api'] }),
    ).value;
    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, p1.id, {
          title: 'X',
          acceptanceCriteria: ['x'],
          areas: ['api'],
          dependsOn: [other.id],
        }),
      ),
    ).toThrow(InvalidError);
  });
});

describe('deriveBoardStatus', () => {
  it.each([
    ['done task', { taskStatus: 'done', depsDone: true, workstreamState: null }, BoardStatus.Done],
    ['ready', { taskStatus: 'open', depsDone: true, workstreamState: null }, BoardStatus.Ready],
    [
      'waiting on deps',
      { taskStatus: 'open', depsDone: false, workstreamState: null },
      BoardStatus.Backlog,
    ],
    [
      'running',
      { taskStatus: 'open', depsDone: true, workstreamState: 'RUNNING' },
      BoardStatus.InProgress,
    ],
    [
      'waiting on a human',
      { taskStatus: 'open', depsDone: true, workstreamState: 'WAITING_HUMAN' },
      BoardStatus.Blocked,
    ],
    [
      'failed',
      { taskStatus: 'open', depsDone: true, workstreamState: 'FAILED' },
      BoardStatus.Blocked,
    ],
    [
      'cancelled run',
      { taskStatus: 'open', depsDone: true, workstreamState: 'CANCELLED' },
      BoardStatus.Ready,
    ],
  ] as const)('%s', (_name, input, expected) => {
    expect(deriveBoardStatus(input)).toBe(expected);
  });
});
