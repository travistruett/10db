import {
  ConflictError,
  InvalidError,
  TaskStatus,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  createTestStore,
  getTask,
  insertTask,
  insertWorkstream,
  patchTask,
  seedProject,
  setTaskStatus,
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

const addTask = (projectId: ProjectId) =>
  store.write((ctx) =>
    insertTask(ctx, projectId, { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'] }),
  ).value;
const setAreas = (id: TaskId, areas: string[]) =>
  store.write((ctx) => patchTask(ctx, id, { areas })).value;
const refusal = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a refusal');
};

describe('setting the areas of a task', () => {
  it('changes the areas of a task that has never started, and keeps its id', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    const changed = setAreas(task.id, ['ui', 'api']);
    expect(changed.id).toBe(task.id);
    expect(changed.areas).toEqual(['ui', 'api']);
    expect(getTask(store.db, task.id).areas).toEqual(['ui', 'api']);
  });

  it('sets the areas of a task filed with none', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    // A task filed from an accepted proposal can have no areas; the form and the tools refuse that.
    store.db.update(schema.tasks).set({ areas: [] }).where(eq(schema.tasks.id, task.id)).run();
    expect(getTask(store.db, task.id).areas).toEqual([]);
    expect(setAreas(task.id, ['api']).areas).toEqual(['api']);
  });

  it('refuses an area the project does not have, naming it', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    const error = refusal(() => setAreas(task.id, ['api', 'billing', 'nope']));
    expect(error).toBeInstanceOf(InvalidError);
    expect((error as Error).message).toContain('billing, nope');
    expect(getTask(store.db, task.id).areas).toEqual(['api']);
  });

  it('refuses an empty list of areas', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    expect(() => setAreas(task.id, [])).toThrow();
  });

  it('refuses a task that has started, saying why', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    store.write((ctx) =>
      insertWorkstream(ctx, task.id, { first: { model: 'claude-sonnet-5-5', effort: 'medium' } }),
    );
    const error = refusal(() => setAreas(task.id, ['ui']));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe(
      'Alpha has already started, so its areas are fixed: the lane took them when it started',
    );
    expect(getTask(store.db, task.id).areas).toEqual(['api']);
  });

  it('refuses a task that is done, saying why', () => {
    const project = seedProject(store);
    const task = addTask(project.id);
    store.write((ctx) => {
      setTaskStatus(ctx, task.id, TaskStatus.Done);
    });
    expect(getTask(store.db, task.id).status).toBe(TaskStatus.Done);
    const error = refusal(() => setAreas(task.id, ['ui']));
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toBe('Alpha is finished, so its areas are fixed');
  });
});
