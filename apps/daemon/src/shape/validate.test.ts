import { mintId, PlanDraft, type ShapeMessageId, type TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { validatePlan, type PlanWorld } from './validate';

// Shape spec §6 Validation: every error at once, naming the field.

const message: ShapeMessageId = mintId('ShapeMessage');
const finished: TaskId = mintId('Task');
const unfinished: TaskId = mintId('Task');
const converted: TaskId = mintId('Task');
const started: TaskId = mintId('Task');
const foreign: TaskId = mintId('Task');
const headDecision = mintId('Decision');
const supersededDecision = mintId('Decision');
const foreignDecision = mintId('Decision');
const convertedGoal = mintId('Goal');

const world = (over: Partial<PlanWorld> = {}): PlanWorld => ({
  areaNames: ['api', 'ui'],
  people: [{ handle: 'ana', name: 'Ana' }],
  citable: new Set([message]),
  convertedTasks: new Map([
    ['earlier-task', converted],
    ['started-task', started],
  ]),
  convertedGoals: new Set([convertedGoal]),
  basisProblem: (id) => (id === finished ? null : `${id} is not a finished task of this project`),
  decisionProblem: (id) =>
    id === headDecision
      ? null
      : id === supersededDecision
        ? `${id} has been superseded`
        : `${id} is not a decision that applies to this project`,
  unstartedProblem: (id) =>
    id === converted
      ? null
      : id === started
        ? `${id} has started`
        : `${id} was not created by this conversation`,
  storedSources: new Set(),
  ...over,
});

const task = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Task ${key}`,
  areas: ['api'],
  size: 'S',
  ...extra,
});
const goal = (
  key: string,
  tasks: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => ({
  key,
  title: `Goal ${key}`,
  objective: 'Do the thing.',
  ceremony: 'direct',
  sourceMessageIds: [message],
  tasks,
  ...extra,
});
const loose = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  title: `Loose ${key}`,
  criteria: ['It works'],
  areas: ['api'],
  size: 'S',
  ceremony: 'direct',
  sourceMessageIds: [message],
  ...extra,
});

function check(draft: Record<string, unknown>, w: PlanWorld = world()): string[] {
  return validatePlan(PlanDraft.parse(draft), w);
}

describe('a valid plan', () => {
  it('has no errors, and uses dependencies across efforts', () => {
    expect(
      check({
        goals: [
          goal('g', [
            task('g1'),
            task('g2', { depends_on: ['g1'], dependsOnOutside: ['solo', 'earlier-task'] }),
          ]),
        ],
        looseTasks: [loose('solo', { dependsOn: ['g1'] }), loose('after', { dependsOn: ['solo'] })],
      }),
    ).toEqual([]);
  });
});

const REFUSED: readonly (readonly [string, Record<string, unknown>, RegExp])[] = [
  [
    'a goal task depending on a task no proposal has',
    { goals: [goal('g', [task('g1', { dependsOnOutside: ['drawer-editr'] })])] },
    /Goal g, task 1, depends on outside: no proposal has the key drawer-editr/,
  ],
  [
    'a loose task depending on a key nobody has',
    { looseTasks: [loose('a', { dependsOn: ['drawer-editr'] })] },
    /Loose task 1, depends on: no proposal has the key drawer-editr/,
  ],
  [
    'a goal’s own rules (an unknown area)',
    { goals: [goal('g', [task('g1', { areas: ['nowhere'] })])] },
    /Goal g: Task 1, areas: the project has no area nowhere/,
  ],
  [
    'a goal’s own rules (a cycle inside the goal)',
    {
      goals: [goal('g', [task('g1', { depends_on: ['g2'] }), task('g2', { depends_on: ['g1'] })])],
    },
    /Goal g: .*wait on each other/,
  ],
  [
    'a loose task in an unknown area',
    { looseTasks: [loose('a', { areas: ['nowhere'] })] },
    /Loose task 1, areas: the project has no area nowhere/,
  ],
  [
    'a cycle across efforts',
    {
      goals: [goal('g', [task('g1', { dependsOnOutside: ['solo'] })])],
      looseTasks: [loose('solo', { dependsOn: ['g1'] })],
    },
    /these tasks wait on each other: .*g1.*solo|these tasks wait on each other: .*solo.*g1/,
  ],
  [
    'a task depending on itself',
    { looseTasks: [loose('a', { dependsOn: ['a'] })] },
    /Loose task 1, depends on: a task cannot depend on itself/,
  ],
  [
    'a key used twice across efforts',
    { goals: [goal('g', [task('same')])], looseTasks: [loose('same')] },
    /the key same is used more than once/,
  ],
  [
    'a loose task with no acceptance criterion',
    { looseTasks: [loose('a', { criteria: [] })] },
    /Loose task 1, criteria: a task needs at least one acceptance criterion/,
  ],
  [
    'a change to a task’s dependencies',
    {
      changes: [{ taskId: converted, dependsOn: ['earlier-task'], sourceMessageIds: [message] }],
    },
    /Change 1, depends on: a task's dependencies cannot be changed yet/,
  ],
  [
    'a basis that is not a finished task',
    { looseTasks: [loose('a', { size: undefined, basis: [unfinished] })] },
    /Loose task 1, basis: .* is not a finished task of this project/,
  ],
  ['an XL task', { looseTasks: [loose('a', { size: 'XL' })] }, /Loose task 1, size: XL — split it/],
  [
    'a source that is not a builder message',
    { looseTasks: [loose('a', { sourceMessageIds: [mintId('ShapeMessage')] })] },
    /Loose task 1, sources: .* is not one of the builder’s messages in this conversation/,
  ],
  [
    'a new row with no source at all',
    { looseTasks: [loose('a', { sourceMessageIds: undefined })] },
    /Loose task 1, sources: cites no message/,
  ],
  [
    'a record that supersedes a decision that was already superseded',
    {
      records: [
        {
          key: 'r',
          kind: 'decision',
          scope: 'project',
          question: 'q',
          choice: 'c',
          rationale: 'r',
          supersedes: supersededDecision,
          sourceMessageIds: [message],
        },
      ],
    },
    /Record 1, supersedes: .* has been superseded/,
  ],
  [
    'a record that supersedes another project’s decision',
    {
      records: [
        {
          key: 'r',
          kind: 'decision',
          scope: 'project',
          question: 'q',
          choice: 'c',
          rationale: 'r',
          supersedes: foreignDecision,
          sourceMessageIds: [message],
        },
      ],
    },
    /Record 1, supersedes: .* is not a decision that applies to this project/,
  ],
  [
    'a change to a task that has started',
    { changes: [{ taskId: started, title: 'New', sourceMessageIds: [message] }] },
    /Change 1, task: .* has started/,
  ],
  [
    'a removal of a task this conversation did not create',
    { removals: [{ taskId: foreign, why: 'gone', sourceMessageIds: [message] }] },
    /Removal 1, task: .* was not created by this conversation/,
  ],
  [
    'an addition under a goal this conversation did not convert',
    { additions: [{ ...loose('add'), goalId: mintId('Goal') }] },
    /Addition 1, goal: .* is not a goal this conversation converted/,
  ],
  [
    'a task in two landings',
    {
      looseTasks: [loose('a'), loose('b')],
      landings: [
        { key: 'l1', title: 'One', keys: ['a'], sourceMessageIds: [message] },
        { key: 'l2', title: 'Two', keys: ['a', 'b'], sourceMessageIds: [message] },
      ],
    },
    /Landing 2, keys: a is already in landing l1/,
  ],
  [
    'a landing naming a key nobody has',
    {
      looseTasks: [loose('a')],
      landings: [{ key: 'l1', title: 'One', keys: ['zzz'], sourceMessageIds: [message] }],
    },
    /Landing 1, keys: no proposal has the key zzz/,
  ],
  [
    'more goals than the cap',
    {
      goals: Array.from({ length: 13 }, (_, i) => goal(`g${String(i)}`, [task(`t${String(i)}`)])),
    },
    /at most 12 goals/,
  ],
  [
    'more tasks in a goal than the cap',
    {
      goals: [
        goal(
          'g',
          Array.from({ length: 41 }, (_, i) => task(`t${String(i)}`)),
        ),
      ],
    },
    /Goal g: at most 40 tasks/,
  ],
  [
    'more proposals than the cap',
    { looseTasks: Array.from({ length: 81 }, (_, i) => loose(`t${String(i)}`)) },
    /at most 80 proposals/,
  ],
];

describe('a plan that breaks a rule', () => {
  it.each(REFUSED)('refuses %s', (_name, draft, expected) => {
    expect(check(draft)).toEqual(expect.arrayContaining([expect.stringMatching(expected)]));
  });

  it('answers every error at once, not the first', () => {
    const errors = check({
      goals: [goal('g', [task('g1', { areas: ['nowhere'], dependsOnOutside: ['typo'] })])],
      looseTasks: [loose('a', { dependsOn: ['typo'], size: 'XL' })],
    });
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });

  it('lets a row without sources keep the ones it has stored', () => {
    expect(
      check(
        { looseTasks: [loose('a', { sourceMessageIds: undefined })] },
        world({ storedSources: new Set(['a']) }),
      ),
    ).toEqual([]);
  });
});
