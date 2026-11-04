import {
  ConflictError,
  InvalidError,
  NEW_TASK_NO_AREAS,
  mintId,
  type BatchState,
  type Notice,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  createTestStore,
  findFlowByName,
  getBatch,
  getWorkstream,
  getWorkstreamRow,
  insertBatch,
  insertEvidence,
  insertProposal,
  insertSource,
  insertTask,
  insertTaskFromProposal,
  insertToolOp,
  insertWorkstream,
  listBoardColumns,
  listEvidence,
  listWorkstreams,
  moveTask,
  patchAccount,
  patchProject,
  patchTask,
  patchWorkstream,
  seedProject,
  setWorkstreamNotice,
  transitionBatch,
  transitionWorkstream,
} from '@10db/db';
import { readDefaultPersonas } from '@10db/harness';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureForTests } from '../../test/catalogue';
import { revertCommitLine } from './reverted-work';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { outstandingFixEvidence } from '../runner';
import { seedTeam } from './seed';
import {
  actionEntering,
  insertJoinedWorkstream,
  insertPlannedWorkstream,
  resolveStepPlan,
  retryWorkstream,
  startTaskWithPlan,
} from './steps';

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

  it('starts a task that was refused for having no areas once its areas are set, keeping its id', () => {
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
    expect(() => startTaskWithPlan(state, task.id)).toThrow(NEW_TASK_NO_AREAS);
    const set = state.write((ctx) => patchTask(ctx, task.id, { areas: ['api'] }));
    expect(set).toMatchObject({ id: task.id, areas: ['api'] });
    const started = startTaskWithPlan(state, task.id);
    expect(started.taskId).toBe(task.id);
    expect(listWorkstreams(state.db, {})).toHaveLength(1);
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

  describe('a run whose commits were reverted by Ship without it', () => {
    const REVERT = 'a'.repeat(40);
    const SECOND_REVERT = 'b'.repeat(40);

    /** A planned run (implement, review) failed at `at`, holding `notice`. */
    const failedAt = (at: 0 | 1, notice: Notice | null) => {
      const ws = startTaskWithPlan(state, addTask().id);
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
        patchWorkstream(ctx, ws.id, null, {
          stepIndex: at,
          steps: ws.steps.map((s, i) => ({
            ...s,
            status: i < at ? 'done' : i === at ? 'failed' : 'pending',
          })),
        });
        setWorkstreamNotice(ctx, ws.id, notice);
      });
      return ws;
    };
    const builderNotes = (id: WorkstreamId) =>
      listEvidence(state.db, id).filter((e) => e.kind === 'builder');
    const leftOut = (revert: string): Notice => ({
      key: 'left-out',
      tone: 'info',
      line: 'Left out of the pull request: its commit was reverted',
      body: `This run failed, and you chose Ship without it.\n\n${revertCommitLine(revert)}`,
    });
    const commit = (id: WorkstreamId, sha: string) => {
      state.write((ctx) => {
        insertToolOp(ctx, {
          workstreamId: id,
          sessionId: mintId('Session'),
          opId: `op-${sha}`,
          tool: 'commit',
          result: { sha, alreadyCommitted: false },
        });
      });
    };

    it('tells the implement step when Retry restarts the read-only review that failed', () => {
      const ws = failedAt(1, leftOut(REVERT));
      const retried = retryWorkstream(state, ws.id);
      const [note] = builderNotes(ws.id);
      expect(note?.summary).toContain(REVERT);
      expect(retried).toMatchObject({
        state: 'QUEUED',
        stepIndex: 0,
        nextAction: { kind: 'fix', evidenceId: note?.id },
      });
      expect(retried.steps.map((s) => s.role)).toEqual(['implement', 'review']);
      expect(retried.notice?.key).toBe('reverted-work');
    });

    it('tells the implement step of the revert when a rejection sends the retry back to it', () => {
      const ws = failedAt(1, leftOut(REVERT));
      state.write((ctx) => {
        patchWorkstream(ctx, ws.id, null, {
          steps: getWorkstream(ctx.tx, ws.id).steps.map((s, i) =>
            i === 1
              ? {
                  ...s,
                  result: {
                    verdict: 'reject',
                    summary: 'no',
                    sessionId: mintId('Session'),
                    at: ctx.now,
                  },
                }
              : s,
          ),
        });
      });
      const retried = retryWorkstream(state, ws.id);
      expect(retried.stepIndex).toBe(0);
      expect(builderNotes(ws.id).map((n) => n.summary.includes(REVERT))).toEqual([true]);
    });

    it('tells the session again on a second Retry of a run that committed nothing since', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      });
      const retried = retryWorkstream(state, ws.id);
      const notes = builderNotes(ws.id);
      expect(notes).toHaveLength(2);
      expect(notes[1]?.summary).toContain(REVERT);
      expect(retried).toMatchObject({
        nextAction: { kind: 'fix', evidenceId: notes[1]?.id },
        notice: { key: 'reverted-work' },
      });
    });

    it('does not tell a run again that committed after it was told', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      commit(ws.id, 'c'.repeat(40));
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      });
      retryWorkstream(state, ws.id);
      expect(builderNotes(ws.id)).toHaveLength(1);
    });

    it('tells a run again whose only commit result since was no new commit, one the revert covers', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      state.write((ctx) => {
        insertToolOp(ctx, {
          workstreamId: ws.id,
          sessionId: mintId('Session'),
          opId: 'op-reused',
          tool: 'commit',
          result: { sha: 'd'.repeat(40), alreadyCommitted: true, coveredByRevert: true },
        });
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      });
      const retried = retryWorkstream(state, ws.id);
      expect(builderNotes(ws.id)).toHaveLength(2);
      expect(retried.notice?.key).toBe('reverted-work');
    });

    it('does not tell a run again that was handed a commit already on the branch the revert does not cover', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      state.write((ctx) => {
        insertToolOp(ctx, {
          workstreamId: ws.id,
          sessionId: mintId('Session'),
          opId: 'op-after',
          tool: 'commit',
          result: { sha: 'd'.repeat(40), alreadyCommitted: true },
        });
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
      });
      retryWorkstream(state, ws.id);
      expect(builderNotes(ws.id)).toHaveLength(1);
    });

    it('names the later revert when the run was left out again', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      commit(ws.id, 'c'.repeat(40));
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, ws.id, { to, fence: null });
        setWorkstreamNotice(ctx, ws.id, leftOut(SECOND_REVERT));
      });
      retryWorkstream(state, ws.id);
      const notes = builderNotes(ws.id);
      expect(notes).toHaveLength(2);
      expect(notes[1]?.summary).toContain(SECOND_REVERT);
    });

    /** What Ship without it writes for a run with no commit left on the branch: it names no revert. */
    const nothingToRevert: Notice = {
      key: 'left-out',
      tone: 'info',
      line: 'Left out of the pull request: it had no commits to revert',
      body: "This run failed, and you chose Ship without it. It had no commits on the batch's branch that were still there, so 10db reverted nothing.",
    };
    const failAgain = (id: WorkstreamId, at: number) => {
      state.write((ctx) => {
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, id, { to, fence: null });
        const row = getWorkstreamRow(ctx.tx, id);
        patchWorkstream(ctx, id, null, {
          stepIndex: at,
          steps: row.steps.map((s, i) => ({
            ...s,
            status: i < at ? 'done' : i === at ? 'failed' : 'pending',
          })),
        });
      });
    };

    it('says on the run that its session was told of a revert, whatever its notice holds', () => {
      const ws = failedAt(0, leftOut(REVERT));
      expect(getWorkstream(state.db, ws.id).revertTold).toBe(false);
      retryWorkstream(state, ws.id);
      expect(getWorkstream(state.db, ws.id).revertTold).toBe(true);
      state.write((ctx) => setWorkstreamNotice(ctx, ws.id, null));
      expect(getWorkstream(state.db, ws.id).revertTold).toBe(true);
    });

    it('sends a joined run with no notice that committed nothing back to the implement step', () => {
      const task = addTask();
      const plan = resolveStepPlan(state.db, task.id);
      const batch = state.write((ctx) => {
        const row = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
        transitionBatch(ctx, row.id, { to: 'OPEN' });
        const left = insertPlannedWorkstream(ctx, task.id, plan, row.id);
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, left.id, { to, fence: null });
        setWorkstreamNotice(ctx, left.id, leftOut(REVERT));
        return row;
      });
      const joined = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batch.id));
      failAgain(joined.id, 1);
      const failed = getWorkstream(state.db, joined.id);
      expect(failed.notice).toBeNull();
      // The failure line reads this fact to say what the retry below does.
      expect(failed.revertTold).toBe(true);
      const retried = retryWorkstream(state, joined.id);
      expect(retried.stepIndex).toBe(0);
      expect(retried.notice?.key).toBe('reverted-work');
    });

    it('does not tell a run left out with nothing to revert of a revert no longer on the branch', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      failAgain(ws.id, 1);
      // Ship without it again found the revert gone from the branch, so it wrote no revert line.
      state.write((ctx) => setWorkstreamNotice(ctx, ws.id, nothingToRevert));
      const notes = builderNotes(ws.id).length;
      const retried = retryWorkstream(state, ws.id);
      expect(retried.notice).toBeNull();
      expect(retried.stepIndex).toBe(1);
      expect(builderNotes(ws.id)).toHaveLength(notes);
    });

    /** A run told of REVERT, failed again and left out with nothing to revert, as Ship without it leaves it. */
    const leftOutWithRevertGone = (at: number) => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      failAgain(ws.id, at);
      state.write((ctx) => setWorkstreamNotice(ctx, ws.id, nothingToRevert));
      return ws;
    };

    it('does not say a run left out with nothing to revert was told of a revert', () => {
      const ws = leftOutWithRevertGone(1);
      expect(getWorkstream(state.db, ws.id).revertTold).toBe(false);
    });

    it('does not hand a run left out with nothing to revert the old note as its fix', () => {
      const ws = leftOutWithRevertGone(0);
      const [old] = builderNotes(ws.id);
      expect(getWorkstream(state.db, ws.id).nextAction).toEqual({
        kind: 'fix',
        evidenceId: old?.id,
      });
      const retried = retryWorkstream(state, ws.id);
      expect(retried.nextAction).toEqual({ kind: 'start' });
      expect(outstandingFixEvidence(state.db, getWorkstreamRow(state.db, ws.id))).toBeNull();
    });

    it('still keeps a gate failure as the fix of a run left out with nothing to revert', () => {
      const ws = leftOutWithRevertGone(0);
      const gate = state.write((ctx) => {
        const row = insertEvidence(ctx, {
          workstreamId: ws.id,
          kind: 'gate',
          command: 'make gate',
          exitCode: 1,
          summary: 'failed',
          logPath: null,
          commitShas: [],
        });
        patchWorkstream(ctx, ws.id, null, { nextAction: { kind: 'fix', evidenceId: row.id } });
        return row;
      });
      expect(retryWorkstream(state, ws.id).nextAction).toEqual({
        kind: 'fix',
        evidenceId: gate.id,
      });
    });

    it('does not tell of the gone revert on the Retry after the one that cleared the notice', () => {
      const ws = leftOutWithRevertGone(1);
      retryWorkstream(state, ws.id);
      failAgain(ws.id, 1);
      const notes = builderNotes(ws.id).length;
      const failed = getWorkstream(state.db, ws.id);
      expect(failed.notice).toBeNull();
      // The failure line reads this fact, so it says the review step runs again.
      expect(failed.revertTold).toBe(false);
      const retried = retryWorkstream(state, ws.id);
      expect(retried.notice).toBeNull();
      expect(retried.stepIndex).toBe(1);
      expect(builderNotes(ws.id)).toHaveLength(notes);
    });

    it('tells a run of a revert made after the Retry that cleared the notice', () => {
      const ws = leftOutWithRevertGone(1);
      retryWorkstream(state, ws.id);
      failAgain(ws.id, 1);
      state.write((ctx) => setWorkstreamNotice(ctx, ws.id, leftOut(SECOND_REVERT)));
      const retried = retryWorkstream(state, ws.id);
      expect(retried.stepIndex).toBe(0);
      expect(retried.revertTold).toBe(true);
      expect(builderNotes(ws.id).at(-1)?.summary).toContain(SECOND_REVERT);
    });

    it('does not ask the implement step to redo a revert gone by the Retry that cleared the notice', () => {
      const task = addTask();
      const plan = fullFlowPlan(task.id);
      const batch = state.write((ctx) => {
        const row = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
        transitionBatch(ctx, row.id, { to: 'OPEN' });
        const left = insertPlannedWorkstream(ctx, task.id, plan, row.id);
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, left.id, { to, fence: null });
        setWorkstreamNotice(ctx, left.id, leftOut(REVERT));
        return row;
      });
      const joined = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batch.id));
      failAgain(joined.id, 0);
      state.write((ctx) => setWorkstreamNotice(ctx, joined.id, nothingToRevert));
      retryWorkstream(state, joined.id);
      const notes = builderNotes(joined.id).length;
      const action = state.write((ctx) =>
        actionEntering(ctx, getWorkstreamRow(ctx.tx, joined.id), implementAt(joined.id)),
      );
      expect(action).toEqual({ kind: 'start' });
      expect(builderNotes(joined.id)).toHaveLength(notes);
    });

    describe('a start joining the batch', () => {
      /** A failed run of `task` in a new open batch, told of REVERT by a retry. */
      const toldRun = () => {
        const task = addTask();
        const plan = resolveStepPlan(state.db, task.id);
        const { batchId, id } = state.write((ctx) => {
          const row = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
          transitionBatch(ctx, row.id, { to: 'OPEN' });
          const left = insertPlannedWorkstream(ctx, task.id, plan, row.id);
          for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
            transitionWorkstream(ctx, left.id, { to, fence: null });
          setWorkstreamNotice(ctx, left.id, leftOut(REVERT));
          return { batchId: row.id, id: left.id };
        });
        retryWorkstream(state, id);
        failAgain(id, 1);
        return { task, plan, batchId, id };
      };

      it('is not told of a revert an earlier run was left out without', () => {
        const { task, plan, batchId, id } = toldRun();
        state.write((ctx) => setWorkstreamNotice(ctx, id, nothingToRevert));
        const joined = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batchId));
        expect(builderNotes(joined.id)).toEqual([]);
        expect(joined.nextAction).toEqual({ kind: 'start' });
        expect(joined.revertTold).toBe(false);
      });

      it('is not told of a revert gone by the Retry that cleared the notice', () => {
        const { task, plan, batchId, id } = toldRun();
        state.write((ctx) => setWorkstreamNotice(ctx, id, nothingToRevert));
        retryWorkstream(state, id);
        failAgain(id, 1);
        const joined = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batchId));
        expect(builderNotes(joined.id)).toEqual([]);
        expect(joined.revertTold).toBe(false);
      });

      it('is not told of an older run’s revert a later run was left out without', () => {
        const { task, plan, batchId, id } = toldRun();
        const second = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batchId));
        failAgain(second.id, 0);
        state.write((ctx) => setWorkstreamNotice(ctx, second.id, nothingToRevert));
        expect(getWorkstream(state.db, id).notice?.key).toBe('reverted-work');
        const third = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batchId));
        expect(builderNotes(third.id)).toEqual([]);
      });
    });

    it('still tells a run left out with nothing to revert of the revert a card holds', () => {
      const ws = failedAt(1, nothingToRevert);
      const retried = retryWorkstream(state, ws.id, undefined, REVERT);
      expect(retried.stepIndex).toBe(0);
      expect(builderNotes(ws.id).map((n) => n.summary.includes(REVERT))).toEqual([true]);
    });

    const REDO = 'Redo the work and commit it with the commit tool';
    /** Four criteria keep the full flow's plan step, so the run starts on a read-only step. */
    const fullFlowPlan = (taskId: TaskId) => {
      state.write((ctx) =>
        patchTask(ctx, taskId, {
          flowId: flowId('full'),
          acceptanceCriteria: ['a', 'b', 'c', 'd'],
        }),
      );
      const plan = resolveStepPlan(state.db, taskId);
      expect(plan.steps[0]?.role).toBe('plan');
      return plan;
    };
    const implementAt = (id: WorkstreamId) =>
      getWorkstreamRow(state.db, id).steps.findIndex((s) => s.role === 'implement');

    it('tells a run started again at its plan step at the implement step too', () => {
      const task = addTask();
      const plan = fullFlowPlan(task.id);
      const batch = state.write((ctx) => {
        const row = insertBatch(ctx, { projectId: project.id, title: 'B', baseBranch: 'main' });
        const left = insertPlannedWorkstream(ctx, task.id, plan, row.id);
        for (const to of ['STARTING', 'RUNNING', 'FAILED'] as const)
          transitionWorkstream(ctx, left.id, { to, fence: null });
        setWorkstreamNotice(ctx, left.id, leftOut(REVERT));
        return row;
      });
      const joined = state.write((ctx) => insertJoinedWorkstream(ctx, task.id, plan, batch.id));
      const [told] = builderNotes(joined.id);
      expect(joined.nextAction).toEqual({ kind: 'fix', evidenceId: told?.id });
      expect(told?.summary).toContain(REVERT);
      expect(told?.summary).not.toContain(REDO);

      const action = state.write((ctx) =>
        actionEntering(ctx, getWorkstreamRow(ctx.tx, joined.id), implementAt(joined.id)),
      );
      const fix = builderNotes(joined.id).at(-1);
      expect(action).toEqual({ kind: 'fix', evidenceId: fix?.id });
      expect(fix?.summary).toContain(REDO);
      expect(fix?.summary).toContain(REVERT);
    });

    it('starts an implement step as usual when no note told of a revert', () => {
      const task = addTask();
      const plan = fullFlowPlan(task.id);
      const ws = state.write((ctx) => insertPlannedWorkstream(ctx, task.id, plan, null));
      const action = state.write((ctx) =>
        actionEntering(ctx, getWorkstreamRow(ctx.tx, ws.id), implementAt(ws.id)),
      );
      expect(action).toEqual({ kind: 'start' });
      expect(builderNotes(ws.id)).toEqual([]);
    });

    it('does not tell a later implement step once one has started since the note', () => {
      const ws = failedAt(0, leftOut(REVERT));
      const retried = retryWorkstream(state, ws.id);
      state.write((ctx) => {
        const row = getWorkstreamRow(ctx.tx, ws.id);
        const [first] = row.steps;
        if (!first) throw new Error('no step');
        const second = { ...first, startedAt: null, status: 'pending' as const };
        patchWorkstream(ctx, ws.id, null, { steps: [...row.steps, second] });
      });
      const before = builderNotes(ws.id).length;
      const action = state.write((ctx) =>
        actionEntering(ctx, getWorkstreamRow(ctx.tx, ws.id), retried.steps.length),
      );
      expect(action).toEqual({ kind: 'start' });
      expect(builderNotes(ws.id)).toHaveLength(before);
    });

    it('does not tell a step entered that is not an implement step', () => {
      const ws = failedAt(0, leftOut(REVERT));
      retryWorkstream(state, ws.id);
      const action = state.write((ctx) => actionEntering(ctx, getWorkstreamRow(ctx.tx, ws.id), 1));
      expect(action).toEqual({ kind: 'start' });
    });
  });

  it('refuses the full sequence: fail, start again, cancel, park, retry the first run', () => {
    const { task, first } = failedThenCancelled();
    park(task.id);
    expect(() => retryWorkstream(state, first.id)).toThrow(ConflictError);
    expect(getWorkstream(state.db, first.id).state).toBe('FAILED');
  });
});
