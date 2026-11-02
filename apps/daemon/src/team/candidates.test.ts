import { InvalidError, mintId, NotFoundError } from '@10db/contracts';
import {
  createTestStore,
  insertGoal,
  insertTask,
  listBoardColumns,
  listGoalTasks,
  moveTask,
  patchProject,
  seedProject,
  type Store,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { proposeCandidates } from './candidates';
import { seedTeam } from './seed';
import { startTaskWithPlan } from './steps';

let state: StateStore;
let close: () => void;
let store: Store;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  store = test.store;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = seedProject(test.store); // areas api and ui
});
afterEach(() => {
  close();
});

const add = (title: string, areas: string[]) =>
  state.write((ctx) => insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas }));

describe('proposeCandidates', () => {
  it('proposes ready tasks with their claims and step plans', () => {
    add('one', ['api']);
    add('two', ['ui']);
    const proposal = proposeCandidates(state.db, project.id, 2);
    expect(proposal.size).toBe(2);
    expect(proposal.candidates.map((c) => [c.task.title, c.proposed])).toEqual([
      ['one', true],
      ['two', true],
    ]);
    expect(proposal.candidates[0]?.claims).toEqual([{ kind: 'area', name: 'api' }]);
    expect(proposal.candidates[0]?.plan?.steps.map((s) => s.role)).toEqual(['implement', 'review']);
  });

  it('leaves out a task whose area a queued workstream will claim', () => {
    startTaskWithPlan(state, add('running', ['api']).id);
    add('waiting', ['api']);
    const proposal = proposeCandidates(state.db, project.id, 2);
    expect(proposal.candidates.map((c) => [c.task.title, c.proposed, c.conflict])).toEqual([
      ['waiting', false, 'Area api is held by running, which is already running or queued'],
    ]);
  });

  it('never proposes a task parked in a human column', () => {
    const parked = add('parked', ['api']);
    const icebox = listBoardColumns(state.db, project.id)[0];
    if (!icebox) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, parked.id, { to: icebox.id, after: null, before: null }));
    expect(proposeCandidates(state.db, project.id, 2).candidates).toEqual([]);
  });

  it('leaves out an over-budget task and keeps its plan for the sheet', () => {
    measureForTests(state);
    add('costly', ['api']);
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 0.0001 }));
    const [candidate] = proposeCandidates(state.db, project.id, 1).candidates;
    expect(candidate?.proposed).toBe(false);
    expect(candidate?.conflict).toMatch(/^Over the budget ceiling: step 1 \(implement\)/);
    expect(candidate?.plan?.overBudget.length).toBeGreaterThan(0);
  });

  it('answers not found for an unknown project', () => {
    expect(() => proposeCandidates(state.db, mintId('Project'), 1)).toThrow(NotFoundError);
  });
});

describe('proposeCandidates for a goal', () => {
  const wide = () =>
    seedProject(store, {
      areas: ['a', 'b', 'c', 'd'].map((name) => ({ name, globs: [`src/${name}/**`] })),
    });
  /** A goal whose tasks each hold their own area, so none collides with another. */
  const goalOf = (target: ReturnType<typeof seedProject>, areas: string[]) =>
    state.write((ctx) =>
      insertGoal(ctx, target.id, {
        brief: {
          title: 'A goal',
          objective: 'Do the goal.',
          tasks: areas.map((area) => ({ key: area, title: `goal ${area}`, areas: [area] })),
        },
      }),
    );

  it('limits the pool to the goal and fills the count with its tasks', () => {
    const own = wide();
    // Added first, so they come first in board order and would fill the count without the goal.
    state.write((ctx) =>
      insertTask(ctx, own.id, { title: 'outside', acceptanceCriteria: ['x'], areas: ['d'] }),
    );
    const goal = goalOf(own, ['a', 'b', 'c']);
    const proposal = proposeCandidates(state.db, own.id, 2, goal.id);
    const inGoal = new Set(listGoalTasks(state.db, goal.id).map((t) => t.id));
    expect(proposal.candidates).toHaveLength(3);
    expect(proposal.candidates.every((c) => inGoal.has(c.task.id))).toBe(true);
    expect(proposal.candidates.filter((c) => c.proposed)).toHaveLength(2);
  });

  it('proposes nothing when the goal has no ready tasks', () => {
    const own = wide();
    state.write((ctx) =>
      insertTask(ctx, own.id, { title: 'outside', acceptanceCriteria: ['x'], areas: ['d'] }),
    );
    const goal = goalOf(own, ['a']);
    const [only] = listGoalTasks(state.db, goal.id);
    if (!only) throw new Error('no goal task');
    const icebox = listBoardColumns(state.db, own.id)[0];
    if (!icebox) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, only.id, { to: icebox.id, after: null, before: null }));
    expect(proposeCandidates(state.db, own.id, 2, goal.id).candidates).toEqual([]);
  });

  it('refuses a goal of another project', () => {
    const goal = goalOf(wide(), ['a']);
    expect(() => proposeCandidates(state.db, project.id, 1, goal.id)).toThrow(InvalidError);
  });

  it('answers not found for an unknown goal', () => {
    expect(() => proposeCandidates(state.db, project.id, 1, mintId('Goal'))).toThrow(NotFoundError);
  });
});
