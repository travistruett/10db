import {
  ConflictError,
  DEFAULT_BOARD_COLUMN,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type ProjectDto,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  deleteBoardColumn,
  insertBoardColumn,
  listBoardColumns,
  patchBoardColumn,
} from './board-columns';
import type { Store } from './store';
import { getTask, insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let project: ProjectDto;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
});
afterEach(() => {
  close();
});

const names = () => listBoardColumns(store.db, project.id).map((c) => c.name);
const add = (name: string) =>
  store.write((ctx) => insertBoardColumn(ctx, project.id, { name })).value;
const columnId = (name: string) => {
  const found = listBoardColumns(store.db, project.id).find((c) => c.name === name);
  if (!found) throw new Error(name);
  return found.id;
};

describe('board columns', () => {
  it('gives a new project an Icebox column', () => {
    expect(names()).toEqual([DEFAULT_BOARD_COLUMN]);
    expect(listBoardColumns(store.db, project.id)[0]?.position).toBe(0);
  });

  it('appends a column and announces it', () => {
    const { value, events } = store.write((ctx) =>
      insertBoardColumn(ctx, project.id, { name: ' Exploring ' }),
    );
    expect(value).toMatchObject({ name: 'Exploring', position: 1 });
    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.BoardColumnSaved,
        entityType: 'board_column',
        entityId: value.id,
      }),
    ]);
  });

  it('refuses a duplicate name in the same project only', () => {
    expect(() => add('Icebox')).toThrow(ConflictError);
    expect(() =>
      store.write((ctx) => insertBoardColumn(ctx, seedProject(store).id, { name: 'Exploring' })),
    ).not.toThrow();
  });

  it.each([
    { name: 'Backlog', typed: 'Backlog' },
    { name: 'a lower-case system label', typed: 'ready' },
    { name: 'a padded system label', typed: ' In Progress ' },
    { name: 'Blocked', typed: 'BLOCKED' },
    { name: 'Done', typed: 'Done' },
  ])('refuses $name as a column name', ({ typed }) => {
    expect(() => add(typed)).toThrow(ConflictError);
    add('Exploring');
    expect(() =>
      store.write((ctx) => patchBoardColumn(ctx, columnId('Exploring'), { name: typed })),
    ).toThrow(ConflictError);
    expect(names()).toEqual(['Icebox', 'Exploring']);
  });

  it('renames a column, refusing a name another column has', () => {
    add('Exploring');
    store.write((ctx) => patchBoardColumn(ctx, columnId('Exploring'), { name: 'Needs spec' }));
    expect(names()).toEqual(['Icebox', 'Needs spec']);
    expect(() =>
      store.write((ctx) => patchBoardColumn(ctx, columnId('Needs spec'), { name: 'Icebox' })),
    ).toThrow(ConflictError);
  });

  it.each([
    {
      name: 'the first column to the end',
      column: 'Icebox',
      position: 2,
      expected: ['Exploring', 'Pending - Mark', 'Icebox'],
    },
    {
      name: 'the last column to the start',
      column: 'Pending - Mark',
      position: 0,
      expected: ['Pending - Mark', 'Icebox', 'Exploring'],
    },
    {
      name: 'a column past the end, clamped',
      column: 'Icebox',
      position: 9,
      expected: ['Exploring', 'Pending - Mark', 'Icebox'],
    },
    {
      name: 'a column to its own place',
      column: 'Exploring',
      position: 1,
      expected: ['Icebox', 'Exploring', 'Pending - Mark'],
    },
  ])('moves $name', ({ column, position, expected }) => {
    add('Exploring');
    add('Pending - Mark');
    const columns = store.write((ctx) =>
      patchBoardColumn(ctx, columnId(column), { position }),
    ).value;
    expect(columns.map((c) => c.name)).toEqual(expected);
    expect(columns.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  describe('delete', () => {
    const park = (title: string, column: string) => {
      const task = store.write((ctx) =>
        insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
      ).value;
      store.db
        .update(schema.tasks)
        .set({ boardColumnId: columnId(column) })
        .where(eq(schema.tasks.id, task.id))
        .run();
      return task.id;
    };

    it.each([
      { name: 'another human column', target: 'Exploring', expected: 'Exploring' },
      { name: 'planned', target: null, expected: null },
    ])("moves a deleted column's tasks to $name", ({ target, expected }) => {
      add('Exploring');
      const parked = park('idea', 'Icebox');
      const { value, events } = store.write((ctx) =>
        deleteBoardColumn(ctx, columnId('Icebox'), {
          moveTasksTo: target === null ? null : columnId(target),
        }),
      );
      expect(value.map((c) => [c.name, c.position])).toEqual([['Exploring', 0]]);
      expect(getTask(store.db, parked).boardColumnId).toBe(
        expected === null ? null : columnId(expected),
      );
      // The tasks move first, then the column goes, then Exploring closes the gap (position 1 to 0).
      expect(events.map((e) => e.type)).toEqual([
        EventType.TaskChanged,
        EventType.BoardColumnDeleted,
        EventType.BoardColumnSaved,
      ]);
    });

    it.each([
      { name: 'to itself', target: 'self' },
      { name: "to another project's column", target: 'other' },
    ])('refuses moving the tasks $name', ({ target }) => {
      const other = store.write((ctx) =>
        insertBoardColumn(ctx, seedProject(store).id, { name: 'Elsewhere' }),
      ).value.id;
      const self = columnId('Icebox');
      expect(() =>
        store.write((ctx) =>
          deleteBoardColumn(ctx, self, { moveTasksTo: target === 'self' ? self : other }),
        ),
      ).toThrow(InvalidError);
      expect(names()).toEqual(['Icebox']);
    });

    it('answers not found for an unknown column', () => {
      expect(() =>
        store.write((ctx) => deleteBoardColumn(ctx, mintId('BoardColumn'), { moveTasksTo: null })),
      ).toThrow(NotFoundError);
    });
  });
});
