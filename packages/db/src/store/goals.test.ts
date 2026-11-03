import {
  CriterionCheck,
  CriterionState,
  EventType,
  GoalState,
  InvalidError,
  mintId,
  NotFoundError,
  type PersonDto,
  type ProjectDto,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import {
  getGoal,
  insertGoal,
  lastGoalView,
  listGoals,
  listGoalTasks,
  markGoalViewed,
  type GoalInsert,
} from './goals';
import type { Store } from './store';
import { getTask, insertTask, listTasks } from './tasks';
import { BUILDER_HANDLE, insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
let clock: Date;
let project: ProjectDto;
let builder: PersonDto;
let mark: PersonDto;
beforeEach(() => {
  clock = new Date('2026-11-01T10:00:00.000Z');
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store);
  builder = store.write((ctx) =>
    insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }),
  ).value;
  mark = store.write((ctx) => insertPerson(ctx, { handle: 'mark', name: 'Mark' })).value;
});
afterEach(() => {
  close();
});

type BriefInput = GoalInsert['brief'];

const brief = (overrides: Partial<BriefInput> = {}): BriefInput => ({
  title: 'Real areas',
  objective: 'Propose areas and let the builder edit them.',
  cares_most: 'Areas a non-engineer can read.',
  budget: { tokens: 500000 },
  criteria: [
    { text: 'Areas are proposed', check: CriterionCheck.Task, task: 'propose' },
    { text: 'The patch route is merged', check: CriterionCheck.Merged, task: 'patch' },
    { text: 'The gate passes', check: CriterionCheck.Command },
    { text: 'Mark accepts the names', check: CriterionCheck.Accept, person: 'mark' },
  ],
  tasks: [
    {
      key: 'patch',
      title: 'Patch a task',
      areas: ['api'],
      criteria: ['PATCH changes areas'],
    },
    { key: 'drawer', title: 'Edit in the drawer', areas: ['ui'], depends_on: ['patch'] },
    {
      key: 'propose',
      title: 'Propose areas',
      areas: ['api'],
      depends_on: ['patch', 'drawer'],
    },
  ],
  ...overrides,
});

const counts = () => ({
  goals: store.db.select().from(schema.goals).all().length,
  criteria: store.db.select().from(schema.goalCriteria).all().length,
  tasks: store.db.select().from(schema.tasks).all().length,
  deps: store.db.select().from(schema.taskDeps).all().length,
});

describe('insertGoal', () => {
  it('writes a draft goal owned by the builder, its unproven criteria, tasks and dependencies', () => {
    const {
      value: { goal },
      events,
    } = store.write((ctx) =>
      insertGoal(ctx, project.id, { brief: brief(), description: 'Notes.' }),
    );
    expect(goal).toMatchObject({
      projectId: project.id,
      title: 'Real areas',
      objective: 'Propose areas and let the builder edit them.',
      caresMost: 'Areas a non-engineer can read.',
      description: 'Notes.',
      ownerId: builder.id,
      state: GoalState.Draft,
      budget: { tokens: 500000 },
    });
    expect(goal.taskIds).toHaveLength(3);
    const [patch, drawer, propose] = goal.taskIds.map((id) => getTask(store.db, id));
    expect(patch).toMatchObject({
      title: 'Patch a task',
      acceptanceCriteria: ['PATCH changes areas'],
      goalId: goal.id,
      dependsOn: [],
    });
    expect(drawer?.dependsOn).toEqual([patch?.id]);
    expect(new Set(propose?.dependsOn)).toEqual(new Set([patch?.id, drawer?.id]));

    expect(goal.criteria).toEqual([
      expect.objectContaining({
        text: 'Areas are proposed',
        check: CriterionCheck.Task,
        taskId: propose?.id,
        state: CriterionState.Unproven,
        proof: [],
        provenAt: null,
        provenBy: null,
      }),
      expect.objectContaining({ check: CriterionCheck.Merged, taskId: patch?.id }),
      expect.objectContaining({
        check: CriterionCheck.Command,
        command: null,
        commandApproved: false,
        taskId: null,
      }),
      expect.objectContaining({ check: CriterionCheck.Accept, personId: mark.id }),
    ]);
    expect(events.map((e) => e.type)).toEqual([
      EventType.TaskCreated,
      EventType.TaskCreated,
      EventType.TaskCreated,
      EventType.GoalCreated,
    ]);
    expect(getGoal(store.db, goal.id)).toEqual(goal);
  });

  it('takes an owner other than the builder and a command the owner has yet to approve', () => {
    const goal = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: brief({
          criteria: [{ text: 'Tests pass', check: CriterionCheck.Command, command: 'make test' }],
          budget: undefined,
          cares_most: undefined,
        }),
        ownerId: mark.id,
      }),
    ).value.goal;
    expect(goal).toMatchObject({
      ownerId: mark.id,
      budget: null,
      caresMost: null,
      description: '',
    });
    expect(goal.criteria[0]).toMatchObject({ command: 'make test', commandApproved: false });
  });

  it.each([
    ['an unknown area', { tasks: [{ key: 'a', title: 'A', areas: ['nope'] }] }],
    [
      'a dependency on a key no task has',
      { tasks: [{ key: 'a', title: 'A', areas: ['api'], depends_on: ['drawer-editr'] }] },
    ],
    [
      'a task depending on the same key twice',
      {
        tasks: [
          { key: 'patch', title: 'Patch', areas: ['api'] },
          { key: 'a', title: 'A', areas: ['api'], depends_on: ['patch', 'patch'] },
        ],
      },
    ],
    [
      'a dependency cycle',
      {
        tasks: [
          { key: 'a', title: 'A', areas: ['api'], depends_on: ['b'] },
          { key: 'b', title: 'B', areas: ['api'], depends_on: ['a'] },
        ],
      },
    ],
    [
      'a repeated task key',
      {
        tasks: [
          { key: 'a', title: 'A', areas: ['api'] },
          { key: 'a', title: 'A again', areas: ['api'] },
        ],
      },
    ],
    [
      'a criterion naming a key no task has',
      { criteria: [{ text: 'x', check: CriterionCheck.Task, task: 'missing' }] },
    ],
    [
      'a criterion naming an unknown person',
      { criteria: [{ text: 'x', check: CriterionCheck.Accept, person: 'nobody' }] },
    ],
  ] satisfies [string, Partial<BriefInput>][])(
    'writes nothing when the brief has %s',
    (_, overrides) => {
      const before = counts();
      expect(() =>
        store.write((ctx) =>
          insertGoal(ctx, project.id, {
            brief: brief({ criteria: [], ...overrides }),
          }),
        ),
      ).toThrow(InvalidError);
      expect(counts()).toEqual(before);
    },
  );

  describe('an accept criterion naming a person', () => {
    const accepts = (person: string) =>
      store.write((ctx) =>
        insertGoal(ctx, project.id, {
          brief: brief({ criteria: [{ text: 'x', check: CriterionCheck.Accept, person }] }),
        }),
      ).value.goal;

    it('is refused as ambiguous when two people share the name', () => {
      store.write((ctx) => insertPerson(ctx, { handle: 'sam-a', name: 'Sam' }));
      store.write((ctx) => insertPerson(ctx, { handle: 'sam-b', name: 'Sam' }));
      const before = counts();
      expect(() => accepts('Sam')).toThrow(InvalidError);
      expect(() => accepts('Sam')).toThrow(/more than one/);
      expect(counts()).toEqual(before);
    });

    it('takes an exact handle over another person whose name is the same text', () => {
      const sam = store.write((ctx) => insertPerson(ctx, { handle: 'sam', name: 'Samuel' })).value;
      store.write((ctx) => insertPerson(ctx, { handle: 'other', name: 'sam' }));
      expect(accepts('sam').criteria[0]?.personId).toBe(sam.id);
    });

    it('takes the one person whose name matches', () => {
      expect(accepts('Mark').criteria[0]?.personId).toBe(mark.id);
    });
  });

  it('writes nothing when the owner does not exist', () => {
    const before = counts();
    expect(() =>
      store.write((ctx) =>
        insertGoal(ctx, project.id, { brief: brief(), ownerId: mintId('Person') }),
      ),
    ).toThrow(NotFoundError);
    expect(counts()).toEqual(before);
  });

  it('is refused when no owner is given and there is no builder', () => {
    const { store: bare, close: closeBare } = createTestStore();
    try {
      const other = seedProject(bare);
      expect(() =>
        bare.write((ctx) => insertGoal(ctx, other.id, { brief: brief({ criteria: [] }) })),
      ).toThrow(InvalidError);
    } finally {
      closeBare();
    }
  });
});

describe('insertGoal for Shape (Shape spec §6, §11)', () => {
  /** Every row a goal write leaves, without the ids and times it mints, in a stable order. */
  const written = () => {
    const tasks = store.db.select().from(schema.tasks).all();
    const keyOf = new Map(tasks.map((t) => [t.id, t.title]));
    const minted = new Set(['id', 'goalId', 'taskId', 'createdAt', 'updatedAt', 'boardOrder']);
    const without = (row: object) =>
      Object.fromEntries(Object.entries(row).filter(([column]) => !minted.has(column)));
    return {
      goals: store.db.select().from(schema.goals).all().map(without),
      tasks: tasks.sort((a, b) => a.title.localeCompare(b.title)).map(without),
      deps: store.db
        .select()
        .from(schema.taskDeps)
        .all()
        .map((d) => `${keyOf.get(d.taskId) ?? ''} -> ${keyOf.get(d.dependsOnId) ?? ''}`)
        .sort(),
      criteria: store.db
        .select()
        .from(schema.goalCriteria)
        .all()
        .map((c) => ({
          ...without(c),
          task: c.taskId === null ? null : keyOf.get(c.taskId),
        })),
    };
  };

  it('answers the task it made for each brief key', () => {
    const { goal, taskIds } = store.write((ctx) =>
      insertGoal(ctx, project.id, { brief: brief() }),
    ).value;
    expect([...taskIds.keys()]).toEqual(['patch', 'drawer', 'propose']);
    expect([...taskIds.values()].sort()).toEqual([...goal.taskIds].sort());
    expect(getTask(store.db, taskIds.get('drawer') ?? mintId('Task')).title).toBe(
      'Edit in the drawer',
    );
  });

  it.each([
    ['no outside keys at all', {}],
    ['an empty map of outside keys', { outsideKeys: new Map(), dependsOnOutside: {} }],
  ] satisfies [string, Partial<GoalInsert>][])(
    'writes exactly what it wrote before, given %s',
    (_, outside) => {
      store.write((ctx) => insertGoal(ctx, project.id, { brief: brief(), description: 'N' }));
      const before = written();
      // Write the same brief again into the emptied tables, this time with the outside arguments.
      store.db.delete(schema.goalCriteria).run();
      store.db.delete(schema.taskDeps).run();
      store.db.delete(schema.tasks).run();
      store.db.delete(schema.goals).run();
      store.write((ctx) =>
        insertGoal(ctx, project.id, { brief: brief(), description: 'N', ...outside }),
      );
      expect(written()).toEqual(before);
    },
  );

  it('makes a goal task depend on a task outside the goal, by its outside key', () => {
    const loose = store.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'Thin scrollbars',
        acceptanceCriteria: ['a'],
        areas: ['ui'],
      }),
    ).value;
    const { taskIds } = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: brief(),
        outsideKeys: new Map([['thin-scrollbars', loose.id]]),
        dependsOnOutside: { drawer: ['thin-scrollbars'] },
      }),
    ).value;
    const drawer = getTask(store.db, taskIds.get('drawer') ?? mintId('Task'));
    expect(new Set(drawer.dependsOn)).toEqual(new Set([taskIds.get('patch'), loose.id]));
    expect(taskIds.has('thin-scrollbars')).toBe(false);
  });

  it.each([
    [
      'an outside key no map entry has',
      { outsideKeys: new Map(), dependsOnOutside: { drawer: ['thin-scrollbars'] } },
    ],
    [
      'outside dependencies for a key no task of the brief has',
      { outsideKeys: new Map([['thin', 'OUTSIDE']]), dependsOnOutside: { nope: ['thin'] } },
    ],
    [
      'an outside key that is also a key of the brief',
      { outsideKeys: new Map([['patch', 'OUTSIDE']]), dependsOnOutside: { drawer: ['patch'] } },
    ],
    [
      'an outside key naming a task that does not exist',
      { outsideKeys: new Map([['thin', mintId('Task')]]), dependsOnOutside: { drawer: ['thin'] } },
    ],
    [
      'an outside key naming another project’s task',
      { outsideKeys: new Map([['thin', 'FOREIGN']]), dependsOnOutside: { drawer: ['thin'] } },
    ],
  ])('writes nothing when given %s', (_, outside) => {
    const loose = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'Loose', acceptanceCriteria: ['a'], areas: ['ui'] }),
    ).value;
    const foreignProject = seedProject(store, { name: 'other' });
    const foreign = store.write((ctx) =>
      insertTask(ctx, foreignProject.id, {
        title: 'Foreign',
        acceptanceCriteria: ['a'],
        areas: ['ui'],
      }),
    ).value;
    const resolve = (id: string) =>
      id === 'OUTSIDE' ? loose.id : id === 'FOREIGN' ? foreign.id : (id as typeof loose.id);
    const outsideKeys = new Map(
      [...outside.outsideKeys.entries()].map(([k, v]: [string, string]) => [k, resolve(v)]),
    );
    const before = counts();
    expect(() =>
      store.write((ctx) =>
        insertGoal(ctx, project.id, {
          brief: brief(),
          outsideKeys,
          dependsOnOutside: outside.dependsOnOutside,
        }),
      ),
    ).toThrow(InvalidError);
    expect(counts()).toEqual(before);
  });
});

describe('reading goals', () => {
  it("lists a project's goals oldest first, and a goal's tasks in board order", () => {
    const first = store.write((ctx) => insertGoal(ctx, project.id, { brief: brief() })).value.goal;
    clock = new Date('2026-11-01T11:00:00.000Z');
    const second = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: brief({
          title: 'Second',
          criteria: [],
          tasks: [{ key: 'x', title: 'X', areas: ['ui'] }],
        }),
      }),
    ).value.goal;
    store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'Alone', acceptanceCriteria: ['a'], areas: ['api'] }),
    );
    expect(listGoals(store.db, project.id).map((g) => g.id)).toEqual([first.id, second.id]);
    expect(listGoalTasks(store.db, first.id).map((t) => t.id)).toEqual(first.taskIds);
    expect(listGoalTasks(store.db, second.id).map((t) => t.title)).toEqual(['X']);
    expect(listTasks(store.db, project.id).find((t) => t.title === 'Alone')?.goalId).toBeNull();
  });

  it('refuses an unknown goal', () => {
    expect(() => getGoal(store.db, mintId('Goal'))).toThrow(NotFoundError);
    expect(() => listGoalTasks(store.db, mintId('Goal'))).toThrow(NotFoundError);
  });
});

describe('markGoalViewed', () => {
  it('returns the previous mark for that person and goal, then advances it', () => {
    const goal = store.write((ctx) => insertGoal(ctx, project.id, { brief: brief() })).value.goal;
    expect(lastGoalView(store.db, goal.id, builder.id)).toBeNull();
    expect(store.write((ctx) => markGoalViewed(ctx, goal.id, builder.id)).value).toBeNull();
    expect(lastGoalView(store.db, goal.id, builder.id)).toBe('2026-11-01T10:00:00.000Z');

    clock = new Date('2026-11-01T13:00:00.000Z');
    expect(store.write((ctx) => markGoalViewed(ctx, goal.id, builder.id)).value).toBe(
      '2026-11-01T10:00:00.000Z',
    );
    expect(store.write((ctx) => markGoalViewed(ctx, goal.id, mark.id)).value).toBeNull();
    expect(lastGoalView(store.db, goal.id, builder.id)).toBe('2026-11-01T13:00:00.000Z');
  });

  it('refuses an unknown goal', () => {
    expect(() => store.write((ctx) => markGoalViewed(ctx, mintId('Goal'), builder.id))).toThrow(
      NotFoundError,
    );
  });
});
