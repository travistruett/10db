import { InvalidError } from '@10db/contracts';
import {
  createTestStore,
  findFlowByName,
  getWorkstream,
  insertTask,
  patchProject,
  patchTask,
  seedProject,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { seedTeam } from './seed';
import { resolveStepPlan, startTaskWithPlan } from './steps';

let state: StateStore;
let close: () => void;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = seedProject(test.store); // model sonnet, effort medium
});
afterEach(() => {
  close();
});

const addTask = () =>
  state.write((ctx) =>
    insertTask(ctx, project.id, { title: 'T', acceptanceCriteria: ['x'], areas: ['api'] }),
  );
const flowId = (name: string) => {
  const flow = findFlowByName(state.db, name);
  if (!flow) throw new Error(name);
  return flow.id;
};

describe('resolveStepPlan', () => {
  it.each([
    {
      name: 'the standard flow by default',
      projectFlow: null,
      taskFlow: null,
      roles: ['implement', 'review'],
    },
    {
      name: "the project's flow over the default",
      projectFlow: 'quick',
      taskFlow: null,
      roles: ['implement'],
    },
    {
      name: "the task's flow over the project's",
      projectFlow: 'quick',
      taskFlow: 'standard',
      roles: ['implement', 'review'],
    },
  ])('uses $name', ({ projectFlow, taskFlow, roles }) => {
    const task = addTask();
    if (projectFlow)
      state.write((ctx) => patchProject(ctx, project.id, { flowId: flowId(projectFlow) }));
    if (taskFlow) state.write((ctx) => patchTask(ctx, task.id, { flowId: flowId(taskFlow) }));
    expect(resolveStepPlan(state.db, task.id).steps.map((s) => s.role)).toEqual(roles);
  });

  it('routes on the measured catalogue once there is one', () => {
    measureForTests(state);
    const plan = resolveStepPlan(state.db, addTask().id);
    expect(plan.steps.map((s) => `${s.model}@${s.effort}`)).toEqual(['sonnet@high', 'opus@medium']);
  });
});

describe('startTaskWithPlan', () => {
  it('stores the plan, starts its first step, and runs on the project’s model before anything is measured', () => {
    const ws = startTaskWithPlan(state, addTask().id);
    expect(ws.steps.map((s) => [s.role, s.status])).toEqual([
      ['implement', 'running'],
      ['review', 'pending'],
    ]);
    expect(ws.steps[0]?.startedAt).not.toBeNull();
    expect(getWorkstream(state.db, ws.id)).toMatchObject({
      stepIndex: 0,
      model: 'sonnet',
      effort: 'medium',
    });
  });

  it('refuses to start a task whose step plan is over budget, naming the step', () => {
    measureForTests(state);
    const task = addTask();
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 1 }));
    expect(() => startTaskWithPlan(state, task.id)).toThrow(InvalidError);
    expect(() => startTaskWithPlan(state, task.id)).toThrow(
      'Step 2 (review, need 48 intelligence) has no profile within the budget ceiling of $1',
    );
  });
});
