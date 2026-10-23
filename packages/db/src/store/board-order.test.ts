import {
  BoardStatus,
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
import { getTask, insertTask, listTasks, moveTask, setTaskStatus } from './tasks';
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
const setOrder = (key: keyof typeof tasks, boardOrder: number) =>
  store.db.update(schema.tasks).set({ boardOrder }).where(eq(schema.tasks.id, tasks[key].id)).run();
const waitsOn = (key: keyof typeof tasks, dependency: keyof typeof tasks) =>
  store.db
    .insert(schema.taskDeps)
    .values({ taskId: tasks[key].id, dependsOnId: tasks[dependency].id })
    .run();
const park = (key: keyof typeof tasks) =>
  store.write((ctx) => moveTask(ctx, tasks[key].id, { to: icebox, after: null, before: null }));
const openOrders = () =>
  listTasks(store.db, project.id)
    .filter((t) => t.status === 'open')
    .map((t) => t.boardOrder);

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

describe('orders across columns', () => {
  it.each([
    {
      // Ready holds b alone; c (3) and d (4) wait on b in Backlog.
      name: 'to the bottom of Ready, past a Backlog task one after the neighbour',
      setup: () => {
        park('a');
        waitsOn('c', 'b');
        waitsOn('d', 'b');
      },
      task: 'a',
      move: () => ({ to: null, after: tasks.b.id, before: null }),
      placed: 5,
    },
    {
      // a (1) waits on d in Backlog; Ready holds b, c and d.
      name: 'to the top of Ready, past a Backlog task one before the neighbour',
      setup: () => {
        waitsOn('a', 'd');
      },
      task: 'c',
      move: () => ({ to: null, after: null, before: tasks.b.id }),
      placed: 0,
    },
    {
      name: 'to the bottom of a human column, past a planned task one after the neighbour',
      setup: () => {
        park('a');
      },
      task: 'c',
      move: () => ({ to: icebox, after: tasks.a.id, before: null }),
      placed: 5,
    },
    {
      name: 'to the top of a human column, past a planned task one before the neighbour',
      setup: () => {
        park('b');
      },
      task: 'c',
      move: () => ({ to: icebox, after: null, before: tasks.b.id }),
      placed: 0,
    },
    {
      // b (2) waits on d in Backlog, halfway between a and c in Ready.
      name: 'between two Ready tasks, short of a Backlog task at their midpoint',
      setup: () => {
        waitsOn('b', 'd');
      },
      task: 'd',
      move: () => ({ to: null, after: tasks.a.id, before: tasks.c.id }),
      placed: 1.5,
    },
  ] as const)('moves a task $name, onto no open task’s order', ({ setup, task, move, placed }) => {
    setup();
    store.write((ctx) => moveTask(ctx, tasks[task].id, move()));
    const orders = openOrders();
    expect(new Set(orders).size).toBe(orders.length);
    expect(getTask(store.db, tasks[task].id).boardOrder).toBe(placed);
  });

  it('keeps a card dropped at the bottom of Ready apart from a Backlog task that joins it', () => {
    // a is parked; b is Ready; c and d wait on b in Backlog.
    park('a');
    waitsOn('c', 'b');
    waitsOn('d', 'b');
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: null, after: tasks.b.id, before: null }));
    store.write((ctx) => {
      setTaskStatus(ctx, tasks.b.id, 'done');
    });
    const ready = listTasks(store.db, project.id).filter(
      (t) => t.boardColumnId === null && t.boardStatus === BoardStatus.Ready && t.id !== tasks.d.id,
    );
    expect(ready.map((t) => t.title).sort()).toEqual(['a', 'c']);
    const [above, below] = ready;
    if (!above || !below) throw new Error('Ready should hold a and c');
    const moved = store.write((ctx) =>
      moveTask(ctx, tasks.d.id, { to: null, after: above.id, before: below.id }),
    ).value;
    expect(moved.boardOrder).toBeGreaterThan(above.boardOrder);
    expect(moved.boardOrder).toBeLessThan(below.boardOrder);
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

describe('moveTask from a stale view', () => {
  const STALE = 'The board changed while you were dragging; try again';
  /** The two tasks sharing order 2, in the order the board lists them. */
  const tied = () => {
    const [first, second] = listTasks(store.db, project.id).filter((t) => t.boardOrder === 2);
    if (!first || !second) throw new Error('two tasks should share order 2');
    return { first: first.id, second: second.id };
  };
  it.each([
    {
      // The view saw a and c side by side; b now sits between them.
      name: 'refuses neighbours with an open task between them',
      setup: () => {
        setOrder('b', 2.5);
      },
      task: 'd',
      move: () => ({ to: null, after: tasks.a.id, before: tasks.c.id }),
      placed: null,
    },
    {
      // The view saw d last; b now sits right after it, at d + 1.
      name: 'refuses a move to the bottom with an open task right after the neighbour',
      setup: () => {
        setOrder('d', 2);
        setOrder('b', 3);
        setOrder('c', 5);
      },
      task: 'a',
      move: () => ({ to: null, after: tasks.d.id, before: null }),
      placed: null,
    },
    {
      // The view saw d last; b now sits after it, short of d + 1.
      name: 'refuses a move to the bottom with an open task anywhere after the neighbour',
      setup: () => {
        setOrder('b', 4.5);
      },
      task: 'a',
      move: () => ({ to: null, after: tasks.d.id, before: null }),
      placed: null,
    },
    {
      // The view saw a alone in Icebox; c now sits above it, at a - 1.
      name: 'refuses a human-column move to the top with an open task right before the neighbour',
      setup: () => {
        park('a');
        park('c');
        setOrder('c', 0);
      },
      task: 'b',
      move: () => ({ to: icebox, after: null, before: tasks.a.id }),
      placed: null,
    },
    {
      // The view saw a first; c now sits before it, short of a - 1.
      name: 'refuses a move to the top with an open task anywhere before the neighbour',
      setup: () => {
        setOrder('c', 0.5);
      },
      task: 'd',
      move: () => ({ to: null, after: null, before: tasks.a.id }),
      placed: null,
    },
    {
      // The board lists tied tasks by ID; a view that shows them the other way round is stale.
      name: 'refuses neighbours that share an order in the other order from the board',
      setup: () => {
        setOrder('c', 2);
      },
      task: 'd',
      move: () => ({ to: null, after: tied().second, before: tied().first }),
      placed: null,
    },
    {
      // Renumbering gives a, the tied pair and d 1, 2, 3 and 4; d lands halfway between the pair.
      name: 'places it between neighbours that share an order, renumbering first',
      setup: () => {
        setOrder('c', 2);
      },
      task: 'd',
      move: () => ({ to: null, after: tied().first, before: tied().second }),
      placed: 2.5,
    },
    {
      // b waits on d, so it is in Backlog while a and c are in Ready; d lands halfway to b's order.
      name: 'places it when the task between the neighbours is in another derived column',
      setup: () => {
        waitsOn('b', 'd');
        setOrder('b', 2.5);
      },
      task: 'd',
      move: () => ({ to: null, after: tasks.a.id, before: tasks.c.id }),
      placed: 1.75,
    },
    {
      name: 'places it when the task between the neighbours is finished',
      setup: () => {
        store.db
          .update(schema.tasks)
          .set({ status: 'done', boardOrder: 2.5 })
          .where(eq(schema.tasks.id, tasks.b.id))
          .run();
      },
      task: 'd',
      move: () => ({ to: null, after: tasks.a.id, before: tasks.c.id }),
      placed: 2,
    },
    {
      // d started from Ready and is In progress; the view is fresh, and Ready ends at c.
      name: 'places it at the bottom when a task past the neighbour has moved on to In progress',
      setup: () => {
        const ws = store.write((ctx) => insertWorkstream(ctx, tasks.d.id)).value;
        for (const state of ['STARTING', 'RUNNING'] as const)
          store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: state, fence: null }));
      },
      task: 'a',
      move: () => ({ to: null, after: tasks.c.id, before: null }),
      placed: 5,
    },
  ] as const)('$name', ({ setup, task, move, placed }) => {
    setup();
    const before = listTasks(store.db, project.id).map((t) => [t.title, t.boardOrder]);
    const run = () => store.write((ctx) => moveTask(ctx, tasks[task].id, move()));
    if (placed === null) {
      expect(run).toThrow(ConflictError);
      expect(run).toThrow(STALE);
      expect(listTasks(store.db, project.id).map((t) => [t.title, t.boardOrder])).toEqual(before);
    } else {
      expect(run().value.boardOrder).toBe(placed);
    }
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

describe('a dependency parked in a human column', () => {
  const dependent = () =>
    store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'e',
        acceptanceCriteria: ['x'],
        areas: ['api'],
        dependsOn: [tasks.a.id],
      }),
    ).value;

  it('refuses to start its dependent, naming the dependency', () => {
    const e = dependent();
    store.write((ctx) => moveTask(ctx, tasks.a.id, { to: icebox, after: null, before: null }));
    expect(() => store.write((ctx) => insertWorkstream(ctx, e.id))).toThrow(
      'Task e waits on a, which is parked in Icebox; move it to Backlog or Ready first',
    );
  });

  it('lets the dependent queue while the dependency is planned', () => {
    const e = dependent();
    expect(() => store.write((ctx) => insertWorkstream(ctx, e.id))).not.toThrow();
  });

  const PARK_REFUSAL = "Task e waits on a and has started; a can't be parked until e finishes";
  it.each([
    { name: 'refuses to park it under a queued dependent', path: [], to: 'icebox', refusal: true },
    {
      name: 'refuses to park it under a running dependent',
      path: ['STARTING', 'RUNNING'],
      to: 'icebox',
      refusal: true,
    },
    {
      name: 'parks it under a finished dependent',
      path: ['STARTING', 'RUNNING', 'VERIFYING', 'DONE'],
      to: 'icebox',
      refusal: false,
    },
    {
      name: 'reorders it among planned work under a queued dependent',
      path: [],
      to: 'planned',
      refusal: false,
    },
  ] as const)('$name', ({ path, to, refusal }) => {
    const e = dependent();
    const ws = store.write((ctx) => insertWorkstream(ctx, e.id)).value;
    for (const state of path)
      store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: state, fence: null }));
    const move: TaskMove =
      to === 'icebox'
        ? { to: icebox, after: null, before: null }
        : { to: null, after: tasks.b.id, before: tasks.c.id };
    const park = () => store.write((ctx) => moveTask(ctx, tasks.a.id, move));
    if (refusal) {
      expect(park).toThrow(ConflictError);
      expect(park).toThrow(PARK_REFUSAL);
      expect(getTask(store.db, tasks.a.id).boardColumnId).toBeNull();
    } else {
      expect(park().value.boardColumnId).toBe(move.to);
    }
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
