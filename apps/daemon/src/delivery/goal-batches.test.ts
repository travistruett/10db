import { mintId, TaskDto, type BatchState, type LandingTarget, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { goalJoin, goalPairs, type GoalShipping } from './goal-batches';

const GOAL_A = mintId('Goal');
const GOAL_B = mintId('Goal');
const MAIN: LandingTarget = { baseBranch: 'main', autoMerge: true };
const HELD: LandingTarget = { baseBranch: 'main', autoMerge: false };

interface Spec {
  readonly goal?: typeof GOAL_A | null;
  /** Whether the task's row ships it with its goal and none of its kinds has its own copy. */
  readonly ships?: boolean;
  readonly target?: LandingTarget;
  readonly landingGroup?: boolean;
}

/** One task per spec, titled by its name; the shipping policy reads the spec by id. */
function setup(specs: Record<string, Spec>): {
  task: (name: string) => TaskDto;
  shipping: GoalShipping;
} {
  const now = new Date(0).toISOString();
  const groupId = mintId('LandingGroup');
  const made = new Map<string, { task: TaskDto; spec: Spec }>();
  for (const [name, spec] of Object.entries(specs)) {
    const id: TaskId = mintId('Task');
    made.set(name, {
      spec,
      task: TaskDto.parse({
        id,
        projectId: mintId('Project'),
        title: name,
        headline: '',
        why: '',
        description: '',
        acceptanceCriteria: ['it works'],
        areas: ['api'],
        landing: { kind: 'base' },
        workspaceMode: 'worktree',
        placementReason: null,
        status: 'open',
        boardOrder: 0,
        boardColumnId: null,
        dependsOn: [],
        boardStatus: 'backlog',
        workstreamId: null,
        modelSetting: null,
        rigor: null,
        rigorSource: null,
        rigorReason: null,
        effectiveRigorSource: 'default',
        effectiveRigorReason: null,
        kindsOff: [],
        sizedByRules: true,
        kinds: [],
        effortPin: null,
        effectiveRigor: 'standard',
        goalId: spec.goal === undefined ? GOAL_A : spec.goal,
        ...(spec.landingGroup ? { landingGroupId: groupId } : {}),
        createdAt: now,
        updatedAt: now,
      }),
    });
  }
  const specOf = (task: TaskDto): Spec => {
    for (const { task: t, spec } of made.values()) if (t.id === task.id) return spec;
    throw new Error(`unknown task ${task.title}`);
  };
  return {
    task: (name) => {
      const found = made.get(name);
      if (!found) throw new Error(`no task ${name}`);
      return found.task;
    },
    shipping: {
      ships: (task) => task.goalId != null && specOf(task).ships !== false,
      target: (task) => specOf(task).target ?? MAIN,
    },
  };
}

const batch = (over: {
  state?: BatchState;
  worktreePath?: string | null;
  target?: LandingTarget;
}) => ({
  id: mintId('Batch'),
  state: over.state ?? 'OPEN',
  worktreePath: over.worktreePath === undefined ? '/w/x' : over.worktreePath,
  baseBranch: (over.target ?? MAIN).baseBranch,
  autoMerge: (over.target ?? MAIN).autoMerge,
});

describe('goalPairs', () => {
  it.each<{
    name: string;
    specs: Record<string, Spec>;
    pairs: readonly (readonly [string, string])[];
  }>([
    {
      name: 'two tasks of one goal that ship with it',
      specs: { A: {}, B: {} },
      pairs: [['B', 'A']],
    },
    {
      name: 'three tasks pair each with the first',
      specs: { A: {}, B: {}, C: {} },
      pairs: [
        ['B', 'A'],
        ['C', 'A'],
      ],
    },
    {
      name: 'a task that ships alone pairs with none',
      specs: { A: {}, B: { ships: false } },
      pairs: [],
    },
    { name: 'tasks of different goals', specs: { A: {}, B: { goal: GOAL_B } }, pairs: [] },
    {
      name: 'a task in a Shape landing group keeps that group’s rule',
      specs: { A: {}, B: { landingGroup: true } },
      pairs: [],
    },
    { name: 'tasks with no goal', specs: { A: { goal: null }, B: { goal: null } }, pairs: [] },
    { name: 'tasks that land differently', specs: { A: {}, B: { target: HELD } }, pairs: [] },
    {
      name: 'a third task that lands like the second pairs with it, not the first',
      specs: { A: {}, B: { target: HELD }, C: { target: HELD } },
      pairs: [['C', 'B']],
    },
  ])('$name', ({ specs, pairs }) => {
    const { task, shipping } = setup(specs);
    const got = goalPairs(Object.keys(specs).map(task), shipping);
    expect(got).toEqual(pairs.map(([a, b]) => [task(a).id, task(b).id]));
  });
});

describe('goalJoin', () => {
  it.each<{
    name: string;
    task: Spec;
    batch: Parameters<typeof batch>[0];
    held: Record<string, Spec>;
    joins: boolean;
  }>([
    {
      name: 'an open worktree batch holding its goal',
      task: {},
      batch: {},
      held: { H: {} },
      joins: true,
    },
    {
      name: 'a batch that is shipping',
      task: {},
      batch: { state: 'SHIPPING' },
      held: { H: {} },
      joins: false,
    },
    {
      name: 'a batch that is cutting',
      task: {},
      batch: { state: 'CUTTING' },
      held: { H: {} },
      joins: false,
    },
    { name: 'a failed batch', task: {}, batch: { state: 'FAILED' }, held: { H: {} }, joins: false },
    {
      name: 'a shipped batch',
      task: {},
      batch: { state: 'SHIPPED' },
      held: { H: {} },
      joins: false,
    },
    {
      name: "Your folder's batch",
      task: {},
      batch: { worktreePath: null },
      held: { H: {} },
      joins: false,
    },
    {
      name: 'a batch of another goal',
      task: {},
      batch: {},
      held: { H: { goal: GOAL_B } },
      joins: false,
    },
    {
      name: 'a batch that also holds a task that ships alone',
      task: {},
      batch: {},
      held: { H: {}, K: { ships: false } },
      joins: false,
    },
    {
      name: 'a batch that lands differently',
      task: {},
      batch: { target: HELD },
      held: { H: {} },
      joins: false,
    },
    {
      name: 'a task that ships alone',
      task: { ships: false },
      batch: {},
      held: { H: {} },
      joins: false,
    },
    { name: 'a task with no goal', task: { goal: null }, batch: {}, held: { H: {} }, joins: false },
    {
      name: 'a task in a landing group',
      task: { landingGroup: true },
      batch: {},
      held: { H: {} },
      joins: false,
    },
  ])('$name', ({ task: spec, batch: over, held, joins }) => {
    const { task, shipping } = setup({ T: spec, ...held });
    const open = batch(over);
    const got = goalJoin(
      task('T'),
      [{ batch: open, tasks: Object.keys(held).map(task) }],
      shipping,
    );
    expect(got).toEqual(joins ? open : null);
  });

  it('takes the first batch that fits', () => {
    const { task, shipping } = setup({ T: {}, H: {}, I: {} });
    const bad = batch({ state: 'SHIPPING' });
    const good = batch({});
    const later = batch({});
    expect(
      goalJoin(
        task('T'),
        [
          { batch: bad, tasks: [task('H')] },
          { batch: good, tasks: [task('I')] },
          { batch: later, tasks: [task('H')] },
        ],
        shipping,
      ),
    ).toBe(good);
  });
});
