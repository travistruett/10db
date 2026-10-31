import type { TaskInput } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteBoardColumn,
  insertBoardColumn,
  listBoardColumns,
  patchBoardColumn,
} from './board-columns';
import type { Store } from './store';
import { getTask, insertFollowUpTask, insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => {
  close();
});

const input = (over: Partial<TaskInput> = {}): TaskInput => ({
  title: 'Make the badge accessible',
  description: 'Badges need labels.',
  acceptanceCriteria: ['Badge has a label'],
  areas: ['api'],
  ...over,
});

const followUp = { title: 'Make errors name the file', description: 'The error says nothing.' };

describe('insertFollowUpTask', () => {
  it('files an open task in the Icebox of the same project that names its source and keeps its landing and areas', () => {
    const project = seedProject(store);
    const source = store.write((ctx) =>
      insertTask(ctx, project.id, input({ landing: { kind: 'branch', branch: 'feature/x' } })),
    ).value;
    const filed = store.write((ctx) =>
      insertFollowUpTask(ctx, source.id, {
        ...followUp,
        acceptanceCriteria: ['Errors name the file'],
      }),
    ).value;
    const icebox = listBoardColumns(store.db, project.id).find((c) => c.name === 'Icebox');
    expect(filed).toMatchObject({
      projectId: project.id,
      title: 'Make errors name the file',
      status: 'open',
      boardColumnId: icebox?.id,
      landing: { kind: 'branch', branch: 'feature/x' },
      areas: ['api'],
      acceptanceCriteria: ['Errors name the file'],
      dependsOn: [],
    });
    expect(filed.description).toContain(source.title);
    expect(filed.description).toContain(source.id);
    expect(filed.description).toContain('The error says nothing.');
    expect(getTask(store.db, filed.id).boardColumnId).toBe(icebox?.id);
  });

  it('puts the task last on the board, after the one it came from', () => {
    const project = seedProject(store);
    const source = store.write((ctx) => insertTask(ctx, project.id, input())).value;
    const filed = store.write((ctx) => insertFollowUpTask(ctx, source.id, followUp)).value;
    expect(filed.boardOrder).toBeGreaterThan(source.boardOrder);
  });

  it('finds the Icebox after the builder renames it, as the first column', () => {
    const project = seedProject(store);
    const [first] = listBoardColumns(store.db, project.id);
    if (!first) throw new Error('no column');
    store.write((ctx) => patchBoardColumn(ctx, first.id, { name: 'Parked' }));
    store.write((ctx) => insertBoardColumn(ctx, project.id, { name: 'Later' }));
    const source = store.write((ctx) => insertTask(ctx, project.id, input())).value;
    const filed = store.write((ctx) => insertFollowUpTask(ctx, source.id, followUp)).value;
    expect(filed.boardColumnId).toBe(first.id);
  });

  it('leaves the task on the derived board when the project has no column', () => {
    const project = seedProject(store);
    const [only] = listBoardColumns(store.db, project.id);
    if (!only) throw new Error('no column');
    const source = store.write((ctx) => insertTask(ctx, project.id, input())).value;
    store.write((ctx) => deleteBoardColumn(ctx, only.id, { moveTasksTo: 'planned' }));
    const filed = store.write((ctx) => insertFollowUpTask(ctx, source.id, followUp)).value;
    expect(filed.boardColumnId).toBeNull();
  });

  it('refuses a title that is not one line', () => {
    const project = seedProject(store);
    const source = store.write((ctx) => insertTask(ctx, project.id, input())).value;
    expect(() =>
      store.write((ctx) => insertFollowUpTask(ctx, source.id, { ...followUp, title: 'a\nb' })),
    ).toThrow();
  });
});
