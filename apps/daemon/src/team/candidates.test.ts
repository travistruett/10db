import { mintId, NotFoundError } from '@10db/contracts';
import {
  createTestStore,
  insertTask,
  listBoardColumns,
  moveTask,
  patchProject,
  seedProject,
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
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
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
