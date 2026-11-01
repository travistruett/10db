import {
  ConflictError,
  InvalidError,
  NEW_TASK_NO_AREAS,
  type BatchState,
  type TaskId,
} from '@10db/contracts';
import {
  createTestStore,
  findFlowByName,
  getBatch,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertProposal,
  insertSource,
  insertTask,
  insertTaskFromProposal,
  insertWorkstream,
  listBoardColumns,
  listEvidence,
  listWorkstreams,
  moveTask,
  patchAccount,
  patchProject,
  patchTask,
  seedProject,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { outstandingFixEvidence } from '../runner';
import { seedTeam } from './seed';
import { resolveStepPlan, retryWorkstream, startTaskWithPlan } from './steps';

let state: StateStore;
let close: () => void;
let project: ReturnType<typeof seedProject>;
beforeEach(() => {
  const test = createTestStore();
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  seedTeam(state, readDefaultPersonas());
  project = seedProject(test.store);
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

  it("routes only on the aliases the project's account offers", () => {
    measureForTests(state);
    state.write((ctx) => patchAccount(ctx, project.accountId, { settings: { aliases: ['opus'] } }));
    const plan = resolveStepPlan(state.db, addTask().id);
    expect(plan.steps.map((s) => s.model)).toEqual(['opus', 'opus']);
  });
});

describe('startTaskWithPlan', () => {
  it('stores the plan, starts its first step, and runs on the role defaults before anything is measured', () => {
    const ws = startTaskWithPlan(state, addTask().id);
    expect(ws.steps.map((s) => [s.role, s.status])).toEqual([
      ['implement', 'running'],
      ['review', 'pending'],
    ]);
    expect(ws.steps[0]?.startedAt).not.toBeNull();
    expect(ws.steps.map((s) => `${s.model}@${s.effort}`)).toEqual(['sonnet@high', 'opus@high']);
    expect(getWorkstream(state.db, ws.id)).toMatchObject({
      stepIndex: 0,
      model: 'sonnet',
      effort: 'high',
    });
  });

  it('refuses to start a task with no areas, naming the task and what to set, and inserts no workstream', () => {
    // The project has two areas and the proposal names no raising task, so the task is filed with none.
    const task = state.write((ctx) =>
      insertTaskFromProposal(ctx, {
        proposalId: insertProposal(ctx, {
          projectId: project.id,
          kind: 'new_task',
          title: 'No areas',
          body: '',
          sourceId: insertSource(ctx, 'agent', {}),
        }),
        projectId: project.id,
        title: 'No areas',
        description: '',
      }),
    );
    expect(task.areas).toEqual([]);
    expect(() => startTaskWithPlan(state, task.id)).toThrow(InvalidError);
    expect(() => startTaskWithPlan(state, task.id)).toThrow(
      `${NEW_TASK_NO_AREAS} for "No areas" before it starts: set its areas on the task.`,
    );
    expect(listWorkstreams(state.db, {})).toEqual([]);
  });

  it('refuses to start a task over budget, naming the step', () => {
    measureForTests(state);
    const task = addTask();
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 1 }));
    expect(() => startTaskWithPlan(state, task.id)).toThrow(InvalidError);
    expect(() => startTaskWithPlan(state, task.id)).toThrow(
      'Step 2 (review, need 48 intelligence) has no profile within the budget ceiling of $1: by score: cheapest profile at or above 48 intelligence; over the budget ceiling of $1',
    );
  });

  it('names the risk floor that binds, and inserts no workstream, when the floor causes the refusal', () => {
    measureForTests(state);
    const task = state.write((ctx) =>
      insertTask(ctx, project.id, {
        title: 'T',
        acceptanceCriteria: ['x'],
        areas: ['api'],
        riskTags: ['security'],
      }),
    );
    state.write((ctx) => patchProject(ctx, project.id, { budgetCeiling: 1.5 }));
    expect(() => startTaskWithPlan(state, task.id)).toThrow(
      /Step 2 \(review.*at or above 52 intelligence \(floor: .*\); over the budget ceiling/,
    );
    expect(listWorkstreams(state.db, {})).toEqual([]);
  });
});

describe('retryWorkstream in a batch', () => {
  it.each<{ name: string; to: BatchState[]; allowed: boolean; after?: BatchState }>([
    { name: 'an open batch', to: ['OPEN'], allowed: true, after: 'OPEN' },
    {
      name: 'a failed batch, which it reopens',
      to: ['OPEN', 'FAILED'],
      allowed: true,
      after: 'OPEN',
    },
    { name: 'a shipping batch', to: ['OPEN', 'SHIPPING'], allowed: false },
    { name: 'a shipped batch', to: ['OPEN', 'SHIPPING', 'SHIPPED'], allowed: false },
    { name: 'a closed batch', to: ['OPEN', 'SHIPPING', 'CLOSED'], allowed: false },
    { name: 'an abandoned batch', to: ['OPEN', 'ABANDONED'], allowed: false },
  ])('$name: allowed $allowed', ({ to, allowed, after }) => {
    const task = addTask();
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
      transitionBatch(ctx, b.id, { to: 'OPEN' });
      return b;
    });
    const ws = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    state.write((ctx) => {
      for (const s of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to: s, fence: null });
      for (const s of to.slice(1)) transitionBatch(ctx, batch.id, { to: s });
    });
    if (!allowed) {
      expect(() => retryWorkstream(state, ws.id)).toThrow(ConflictError);
      return;
    }
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
    expect(getBatch(state.db, batch.id).state).toBe(after);
  });

  it('retryWorkstream leaves a FAILED worktree batch FAILED and re-queues the workstream', () => {
    const task = addTask();
    const batch = state.write((ctx) => {
      const b = insertBatch(ctx, {
        projectId: project.id,
        title: 'B',
        baseBranch: 'main',
        worktreePath: '/worktrees/b',
      });
      transitionBatch(ctx, b.id, { to: 'OPEN' });
      return b;
    });
    const ws = state.write((ctx) => insertWorkstream(ctx, task.id, { batchId: batch.id }));
    state.write((ctx) => {
      for (const s of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to: s, fence: null });
      transitionBatch(ctx, batch.id, { to: 'FAILED', patch: { failure: 'gate_failed' } });
    });
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
    expect(getBatch(state.db, batch.id)).toMatchObject({
      state: 'FAILED',
      failure: 'gate_failed',
    });
  });

  it('retries a workstream with no batch as before', () => {
    const ws = state.write((ctx) => insertWorkstream(ctx, addTask().id));
    state.write((ctx) => {
      for (const s of ['STARTING', 'RUNNING', 'FAILED'] as const)
        transitionWorkstream(ctx, ws.id, { to: s, fence: null });
    });
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
  });
});

describe('retryWorkstream', () => {
  const failedWorkstream = (taskId: TaskId) => {
    const ws = state.write((ctx) => insertWorkstream(ctx, taskId));
    state.write((ctx) => transitionWorkstream(ctx, ws.id, { to: 'STARTING', fence: null }));
    state.write((ctx) => transitionWorkstream(ctx, ws.id, { to: 'FAILED', fence: null }));
    return ws;
  };
  /** The task failed once, was started again, and that second run was cancelled. */
  const failedThenCancelled = () => {
    const task = addTask();
    const first = failedWorkstream(task.id);
    const second = state.write((ctx) => insertWorkstream(ctx, task.id));
    state.write((ctx) => transitionWorkstream(ctx, second.id, { to: 'CANCELLED', fence: null }));
    return { task, first };
  };
  const park = (taskId: TaskId) => {
    const column = listBoardColumns(state.db, project.id)[0];
    if (!column) throw new Error('no Icebox');
    state.write((ctx) => moveTask(ctx, taskId, { to: column.id, after: null, before: null }));
  };

  it('requeues the latest failed workstream of a planned task', () => {
    const task = addTask();
    const ws = failedWorkstream(task.id);
    expect(retryWorkstream(state, ws.id).state).toBe('QUEUED');
  });

  it('refuses a workstream that is not the latest of its task', () => {
    const { first } = failedThenCancelled();
    expect(() => retryWorkstream(state, first.id)).toThrow(ConflictError);
    expect(getWorkstream(state.db, first.id).state).toBe('FAILED');
  });

  describe('a note on a failure no rejection caused', () => {
    /** A planned workstream whose implement step failed, as the gate or a crash fails it. */
    const failedPlanned = () => {
      const ws = startTaskWithPlan(state, addTask().id);
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      });
      return ws;
    };

    it('reaches the restarted step as the builder’s fix', () => {
      const ws = failedPlanned();
      const retried = retryWorkstream(state, ws.id, '  Pin the version.  ');
      const builder = listEvidence(state.db, ws.id).filter((e) => e.kind === 'builder');
      expect(builder).toMatchObject([{ summary: 'Pin the version.' }]);
      expect(retried).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        nextAction: { kind: 'fix', evidenceId: builder[0]?.id },
      });
      // A session that starts fresh, after a crash say, still finds the note outstanding.
      expect(outstandingFixEvidence(state.db, getWorkstreamRow(state.db, ws.id))).toBe(
        builder[0]?.id,
      );
    });

    it.each([
      { name: 'no note', note: undefined },
      { name: 'a blank note', note: ' \n ' },
    ])('with $name, retries as before', ({ note }) => {
      const ws = failedPlanned();
      expect(retryWorkstream(state, ws.id, note).nextAction).toEqual({ kind: 'start' });
      expect(listEvidence(state.db, ws.id)).toEqual([]);
    });
  });

  it('refuses the full sequence: fail, start again, cancel, park, retry the first run', () => {
    const { task, first } = failedThenCancelled();
    park(task.id);
    expect(() => retryWorkstream(state, first.id)).toThrow(ConflictError);
    expect(getWorkstream(state.db, first.id).state).toBe('FAILED');
  });
});
