import {
  ConflictError,
  EventType,
  InvalidError,
  mintId,
  NotFoundError,
  type BoardColumnId,
  type ProjectDto,
  type TaskDto,
  type TaskMove,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertBoardColumn, listBoardColumns } from './board-columns';
import type { Store } from './store';
import { getTask, insertTask, listTasks, moveTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream, transitionWorkstream } from './workstreams';

let store: Store;
let close: () => void;
let project: ProjectDto;
let icebox: BoardColumnId;
let tasks: Record<'a' | 'b' | 'c' | 'd', TaskDto>;
beforeEach(() => {
  ({ store, close } = createTestStore());
  project = seedProject(store);
  const first = listBoardColumns(store.db, project.id)[0];
  if (!first) throw new Error('no Icebox');
  icebox = first.id;
  const add = (title: string) =>
    store.write((ctx) =>
      insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas: ['api'] }),
    ).value;
  // insertTask gives orders 1, 2, 3, 4, all planned.
  tasks = { a: add('a'), b: add('b'), c: add('c'), d: add('d') };
});
afterEach(() => {
  close();
});

const order = () => listTasks(store.db, project.id).map((t) => t.title);
const id = (key: keyof typeof tasks | null) => (key === null ? null : tasks[key].id);

describe('moveTask among planned tasks', () => {
  it.each([
    {
      name: 'between two tasks',
      task: 'd',
      after: 'a',
      before: 'b',
      expected: ['a', 'd', 'b', 'c'],
    },
    { name: 'to the top', task: 'c', after: null, before: 'a', expected: ['c', 'a', 'b', 'd'] },
    { name: 'to the bottom', task: 'a', after: 'd', before: null, expected: ['b', 'c', 'd', 'a'] },
    { name: 'down one place', task: 'b', after: 'c', before: 'd', expected: ['a', 'c', 'b', 'd'] },
    {
      name: 'to where it already is',
      task: 'b',
      after: 'a',
      before: 'c',
      expected: ['a', 'b', 'c', 'd'],
    },
  ] as const)('moves a task $name', ({ task, after, before, expected }) => {
    const moved = store.write((ctx) =>
      moveTask(ctx, tasks[task].id, { to: null, after: id(after), before: id(before) }),
    );
    expect(order()).toEqual(expected);
    expect(moved.events).toEqual([
      expect.objectContaining({
        type: EventType.TaskChanged,
        entityType: 'task',
        entityId: tasks[task].id,
        data: { boardOrder: moved.value.boardOrder, boardColumnId: null },
      }),
    ]);
  });

  it('answers a conflict for neighbours in the wrong order, and writes nothing', () => {
    expect(() =>
      store.write((ctx) =>
        moveTask(ctx, tasks.a.id, { to: null, after: tasks.d.id, before: tasks.b.id }),
      ),
    ).toThrow(ConflictError);
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('renumbers the project when the gap is too small, keeping the order', () => {
    // Squeeze b right up against a, as fifty halvings would.
    store.db
      .update(schema.tasks)
      .set({ boardOrder: 1 + 1e-9 })
      .where(eq(schema.tasks.id, tasks.b.id))
      .run();
    const moved = store.write((ctx) =>
      moveTask(ctx, tasks.d.id, { to: null, after: tasks.a.id, before: tasks.b.id }),
    );
    expect(order()).toEqual(['a', 'd', 'b', 'c']);
    expect(new Set(listTasks(store.db, project.id).map((t) => t.boardOrder)).size).toBe(4);
    // Renumbering 1, 1+1e-9, 3, 4 to 1, 2, 3, 4 changes only b; the move then changes d.
    expect(new Set(moved.events.map((e) => e.entityId))).toEqual(new Set([tasks.b.id, tasks.d.id]));
  });
});

describe('renumbering', () => {
  it('leaves finished tasks alone', () => {
    store.db
      .update(schema.tasks)
      .set({ status: 'done', boardOrder: 2.5 })
      .where(eq(schema.tasks.id, tasks.a.id))
      .run();
    store.db
      .update(schema.tasks)
      .set({ boardOrder: 3 + 1e-9 })
      .where(eq(schema.tasks.id, tasks.d.id))
      .run();
    store.write((ctx) =>
      moveTask(ctx, tasks.b.id, { to: null, after: tasks.c.id, before: tasks.d.id }),
    );
    expect(getTask(store.db, tasks.a.id).boardOrder).toBe(2.5);
  });
});

describe('moveTask between columns', () => {
  it('parks a planned task in a human column and plans it again', () => {
    store.write((ctx) => moveTask(ctx, tasks.b.id, { to: icebox, after: null, before: null }));
    expect(getTask(store.db, tasks.b.id).boardColumnId).toBe(icebox);
    store.write((ctx) =>
      moveTask(ctx, tasks.b.id, { to: null, after: tasks.c.id, before: tasks.d.id }),
    );
    expect(getTask(store.db, tasks.b.id).boardColumnId).toBeNull();
    expect(order()).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a parked task between human columns', () => {
    const exploring = store.write((ctx) =>
      insertBoardColumn(ctx, project.id, { name: 'Exploring' }),
    ).value.id;
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }));
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: exploring, after: null, before: null }));
    expect(getTask(store.db, tasks.a.id).boardColumnId).toBe(exploring);
  });

  it.each([
    {
      name: 'a neighbour outside the target column',
      error: InvalidError,
      setup: 'planned-neighbour',
    },
    { name: "another project's column", error: InvalidError, setup: 'other-column' },
    { name: 'the task as its own neighbour', error: InvalidError, setup: 'self' },
    { name: 'an unknown column', error: NotFoundError, setup: 'unknown-column' },
    { name: 'an unknown neighbour', error: NotFoundError, setup: 'unknown-neighbour' },
  ] as const)('refuses $name', ({ error, setup }) => {
    const moveFor = (): TaskMove => {
      switch (setup) {
        case 'planned-neighbour':
          return { to: icebox, after: tasks.c.id, before: null };
        case 'other-column':
          return {
            to: store.write((ctx) =>
              insertBoardColumn(ctx, seedProject(store).id, { name: 'Elsewhere' }),
            ).value.id,
            after: null,
            before: null,
          };
        case 'self':
          return { to: null, after: tasks.b.id, before: null };
        case 'unknown-column':
          return { to: mintId('BoardColumn'), after: null, before: null };
        case 'unknown-neighbour':
          return { to: null, after: mintId('Task'), before: null };
      }
    };
    const move = moveFor();
    expect(() => store.write((ctx) => moveTask(ctx, tasks.b.id, move))).toThrow(error);
  });

  it('refuses to move a running task', () => {
    store.write((ctx) => insertWorkstream(ctx, tasks.a.id));
    expect(() =>
      store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null })),
    ).toThrow(ConflictError);
  });
});

describe('moveTask neighbours', () => {
  it('refuses a finished neighbour, which the board would not show among planned cards', () => {
    store.db
      .update(schema.tasks)
      .set({ status: 'done' })
      .where(eq(schema.tasks.id, tasks.c.id))
      .run();
    expect(() =>
      store.write((ctx) =>
        moveTask(ctx, tasks.b.id, { to: null, after: tasks.c.id, before: tasks.d.id }),
      ),
    ).toThrow(ConflictError);
    expect(order()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a running neighbour', () => {
    store.write((ctx) => insertWorkstream(ctx, tasks.c.id));
    expect(() =>
      store.write((ctx) =>
        moveTask(ctx, tasks.b.id, { to: null, after: tasks.c.id, before: tasks.d.id }),
      ),
    ).toThrow(ConflictError);
  });
});

describe('a task with an older run still active', () => {
  it('refuses to move it, whatever its latest run says', () => {
    const first = store.write((ctx) => insertWorkstream(ctx, tasks.a.id)).value;
    store.write((ctx) => transitionWorkstream(ctx, first.id, { to: 'STARTING', fence: null }));
    store.write((ctx) => transitionWorkstream(ctx, first.id, { to: 'FAILED', fence: null }));
    const second = store.write((ctx) => insertWorkstream(ctx, tasks.a.id)).value;
    store.write((ctx) => transitionWorkstream(ctx, second.id, { to: 'CANCELLED', fence: null }));
    // Bypass the retry route: the first run is queued again while the latest run is cancelled.
    store.write((ctx) => transitionWorkstream(ctx, first.id, { to: 'QUEUED', fence: null }));
    expect(() =>
      store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null })),
    ).toThrow(ConflictError);
  });
});

describe('parked tasks', () => {
  it('refuses to start a parked task, naming its column', () => {
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }));
    expect(() => store.write((ctx) => insertWorkstream(ctx, tasks.a.id))).toThrow(
      'Task a is parked in Icebox; move it to Backlog or Ready to start it',
    );
  });
});
