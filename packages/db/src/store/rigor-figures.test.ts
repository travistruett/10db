import {
  Effort,
  EventType,
  mintId,
  JudgeDecision,
  JudgeOutcome,
  StepRole,
  StepStatus,
  TaskStatus,
  ToolAccess,
  WorkstreamState,
  type BatchId,
  type ProjectId,
  type Rigor,
  type RigorFiguresRowDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { insertBatch, patchBatch } from './batches';
import { insertGoal } from './goals';
import { insertJudgeCall } from './judge-calls';
import { insertPass } from './passes';
import { rigorFigures } from './rigor-figures';
import { insertSession } from './sessions';
import type { Store } from './store';
import { cancelTask, insertTask, patchTask, setTaskStatus } from './tasks';
import { BUILDER_HANDLE, insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertWorkstream } from './workstreams';

// What each rigor's done tasks took, from tasks, workstream steps, sessions, batches and judge calls.

let store: Store;
let close: () => void;
let nowMs: number;
const at = (iso: string): void => {
  nowMs = Date.parse(iso);
};
const NOW = '2026-11-14T12:00:00.000Z';
// A 14-day window opens here.
const FROM = '2026-10-31T12:00:00.000Z';

beforeEach(() => {
  at(NOW);
  ({ store, close } = createTestStore(() => new Date(nowMs)));
});
afterEach(() => {
  close();
});

const step = (over: Partial<WorkstreamStep> = {}): WorkstreamStep => ({
  role: StepRole.Implement,
  personaId: null,
  personaName: 'Implementer',
  tools: ToolAccess.Edit,
  profileId: null,
  model: 'sonnet-5.5',
  effort: Effort.High,
  need: 0,
  reason: 'test',
  overBudget: false,
  pinned: false,
  status: StepStatus.Done,
  attempts: 0,
  startedAt: '2026-11-01T00:00:00.000Z',
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  setting: null,
  ...over,
});

const ran = (n: number, over: Partial<WorkstreamStep> = {}): WorkstreamStep[] =>
  Array.from({ length: n }, () => step(over));

/** A run of the task with `steps` and `sessions` sessions, in `batchId` when given. */
function run(
  taskId: TaskId,
  steps: WorkstreamStep[],
  sessions: number,
  batchId: BatchId | null = null,
): WorkstreamId {
  const ws = store.write((ctx) =>
    insertWorkstream(ctx, taskId, {
      batchId,
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    }),
  ).value;
  store.write((ctx) => {
    ctx.tx
      .update(schema.workstreams)
      .set({ steps, state: WorkstreamState.Done })
      .where(eq(schema.workstreams.id, ws.id))
      .run();
  });
  for (let i = 0; i < sessions; i += 1)
    store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: ws.id,
        provider: 'claude',
        model: 'sonnet',
        effort: 'medium',
        mode: 'managed',
        mcpTokenHash: `hash-${ws.id}-${String(i)}`,
      }),
    );
  return ws.id;
}

/** What a send-back logs: the role that sent the work back, or `builder`. */
function sentBackBy(workstreamId: WorkstreamId, by: string): void {
  store.write((ctx) => {
    ctx.emit({
      type: EventType.StepChanged,
      entityType: 'workstream',
      entityId: workstreamId,
      data: { stepIndex: 0, role: 'implement', sentBackBy: by },
    });
  });
}

function batch(projectId: ProjectId, name: string, prUrl: string | null): BatchId {
  const id = store.write((ctx) =>
    insertBatch(ctx, {
      projectId,
      title: name,
      baseBranch: 'main',
      worktreePath: `/tmp/${name}`,
    }),
  ).value.id;
  if (prUrl !== null) store.write((ctx) => patchBatch(ctx, id, { prUrl }));
  return id;
}

function task(projectId: ProjectId, title: string, rigor: Rigor): TaskId {
  return store.write((ctx) =>
    insertTask(ctx, projectId, {
      title,
      description: '',
      acceptanceCriteria: ['x'],
      areas: ['api'],
      rigor,
    }),
  ).value.id;
}

/** Marks the task done at `iso`, the clock left there. */
function finishAt(taskId: TaskId, iso: string): void {
  at(iso);
  store.write((ctx) => {
    setTaskStatus(ctx, taskId, TaskStatus.Done);
  });
}

function call(
  decision: JudgeDecision,
  outcome: JudgeOutcome,
  iso: string,
  taskId: TaskId | null,
): void {
  at(iso);
  store.write((ctx) =>
    insertJudgeCall(ctx, {
      decision,
      model: 'm',
      state: '',
      question: 'q',
      answer: null,
      confidence: null,
      outcome,
      latencyMs: 1,
      costUsd: null,
      workstreamId: null,
      taskId,
    }),
  );
}

const rowOf = (rows: readonly RigorFiguresRowDto[], rigor: RigorFiguresRowDto['rigor']) =>
  rows.find((r) => r.rigor === rigor);

describe('rigorFigures', () => {
  it('averages each rigor over the tasks it finished in the period, and counts all of them once', () => {
    const project = seedProject(store);
    store.write((ctx) =>
      insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }),
    );
    const other = seedProject(store, { name: 'other' });
    const goal = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: {
          title: 'Goal',
          objective: 'One goal.',
          tasks: [
            { key: 'l1', title: 'Light one', areas: ['api'] },
            { key: 'l2', title: 'Light two', areas: ['api'] },
            { key: 'c1', title: 'Careful one', areas: ['api'] },
          ],
        },
      }),
    ).value.goal;
    const [l1, l2, c1] = goal.taskIds;
    if (!l1 || !l2 || !c1) throw new Error('the brief makes three tasks');
    const rigors = [
      [l1, 'light'],
      [l2, 'light'],
      [c1, 'careful'],
    ] as const;
    for (const [id, rigor] of rigors) store.write((ctx) => patchTask(ctx, id, { rigor }));

    const removed = task(project.id, 'Removed', 'light');
    store.write((ctx) => cancelTask(ctx, removed));

    const prA = batch(project.id, 'a', 'https://example.test/pr/1');
    const prB = batch(project.id, 'b', 'https://example.test/pr/2');
    const prBRecut = batch(project.id, 'b2', 'https://example.test/pr/2');
    const l1Run = run(l1, [...ran(1), ...ran(1, { sentBack: 1 })], 2, prA);
    sentBackBy(l1Run, 'review');
    run(l2, [...ran(1), step({ status: StepStatus.Pending, startedAt: null })], 1, prA);
    // A task reopened by a merge run: the first run's two steps and one session, then a second run's three
    // and two sessions. A re-cut batch reuses its pull request.
    // The retry reset the steps' own counts, so only the logged send-backs say what the reviewers did.
    const c1First = run(c1, ran(2), 1, prBRecut);
    sentBackBy(c1First, 'review');
    sentBackBy(c1First, 'qa');
    sentBackBy(c1First, 'builder');
    run(
      c1,
      [...ran(2), step({ shippedAtLimit: { followUpTaskId: l1, followUpTitle: 'Findings' } })],
      2,
      prB,
    );
    const standard = task(project.id, 'Standard', 'standard');
    run(standard, ran(2), 1);
    // A task in a Workbench pass never ran a rigor's plan: counted nowhere.
    const page = task(project.id, 'Page', 'light');
    run(page, ran(9), 9);
    store.write((ctx) =>
      insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [page],
        dirt: [],
      }),
    );
    finishAt(page, '2026-11-10T00:00:00.000Z');
    // Never done, removed, finished before the window, and in another project: counted nowhere.
    const open = task(project.id, 'Open', 'standard');
    run(open, ran(4), 4);
    const old = task(project.id, 'Old', 'light');
    run(old, ran(9), 9);
    finishAt(old, '2026-10-31T11:59:59.999Z');
    const elsewhere = task(other.id, 'Elsewhere', 'light');
    run(elsewhere, ran(9), 9);
    finishAt(elsewhere, '2026-11-10T00:00:00.000Z');

    finishAt(l1, '2026-11-10T00:00:00.000Z');
    finishAt(l2, '2026-11-11T00:00:00.000Z');
    finishAt(c1, '2026-11-12T00:00:00.000Z');
    finishAt(standard, '2026-11-13T00:00:00.000Z');

    // Answered sizing calls on this project's tasks: two acted, one overridden.
    call(JudgeDecision.TaskRigor, JudgeOutcome.Acted, '2026-11-01T00:00:00.000Z', l1);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Acted, '2026-11-02T00:00:00.000Z', l2);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Overridden, '2026-11-02T00:00:00.000Z', c1);
    // Not counted: unanswered, another decision, before the window, another project's task.
    call(JudgeDecision.TaskRigor, JudgeOutcome.FallbackTimeout, '2026-11-03T00:00:00.000Z', l1);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Shadow, '2026-11-03T00:00:00.000Z', l1);
    call(JudgeDecision.TaskRigor, JudgeOutcome.BelowFloor, '2026-11-03T00:00:00.000Z', l1);
    call(JudgeDecision.ReviewSize, JudgeOutcome.Overridden, '2026-11-04T00:00:00.000Z', l1);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Overridden, '2026-10-30T00:00:00.000Z', l1);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Overridden, '2026-11-05T00:00:00.000Z', elsewhere);

    at(NOW);
    const figures = rigorFigures(store.db, project.id, new Date(nowMs), 14);

    expect(figures.period).toBe(14);
    expect(figures.rows.map((r) => r.rigor)).toEqual([
      'light',
      'standard',
      'careful',
      'critical',
      'all',
    ]);
    const nothing = {
      stepsPerTask: null,
      sessionsPerTask: null,
      pullRequestsPerTask: null,
      stepsPerGoal: null,
      sessionsPerGoal: null,
      pullRequestsPerGoal: null,
      sentBackPerTask: null,
      shippedWithFindings: null,
    };
    expect(rowOf(figures.rows, 'light')).toEqual({
      rigor: 'light',
      tasksDone: 2,
      stepsPerTask: 1.5,
      sessionsPerTask: 1.5,
      pullRequestsPerTask: 1,
      // The goal's two light tasks together: 3 steps, 3 sessions, one pull request.
      stepsPerGoal: 3,
      sessionsPerGoal: 3,
      pullRequestsPerGoal: 1,
      sentBackPerTask: 0.5,
      shippedWithFindings: 0,
    });
    // In no goal, so only the per-task figures.
    expect(rowOf(figures.rows, 'standard')).toEqual({
      rigor: 'standard',
      tasksDone: 1,
      stepsPerTask: 2,
      sessionsPerTask: 1,
      pullRequestsPerTask: 0,
      stepsPerGoal: null,
      sessionsPerGoal: null,
      pullRequestsPerGoal: null,
      sentBackPerTask: 0,
      shippedWithFindings: 0,
    });
    // The re-cut batch shares its pull request: one URL, two batches. Two reviewer send-backs; the
    // builder's own is not one.
    expect(rowOf(figures.rows, 'careful')).toEqual({
      rigor: 'careful',
      tasksDone: 1,
      stepsPerTask: 5,
      sessionsPerTask: 3,
      pullRequestsPerTask: 1,
      stepsPerGoal: 5,
      sessionsPerGoal: 3,
      pullRequestsPerGoal: 1,
      sentBackPerTask: 2,
      shippedWithFindings: 1,
    });
    expect(rowOf(figures.rows, 'critical')).toEqual({
      rigor: 'critical',
      tasksDone: 0,
      ...nothing,
    });
    // The goal's three done tasks: 8 steps, 6 sessions and two pull request URLs.
    expect(rowOf(figures.rows, 'all')).toEqual({
      rigor: 'all',
      tasksDone: 4,
      stepsPerTask: 2.5,
      sessionsPerTask: 1.75,
      pullRequestsPerTask: 0.75,
      stepsPerGoal: 8,
      sessionsPerGoal: 6,
      pullRequestsPerGoal: 2,
      sentBackPerTask: 0.75,
      shippedWithFindings: 0.25,
    });
    expect(figures.judgeOverride).toEqual({ calls: 3, overridden: 1 });
  });

  it('leaves out the pass-era run of a task taken out of a pass, which then runs as an ordinary task', () => {
    const project = seedProject(store);
    const id = task(project.id, 'Taken out', 'light');
    // The run in the pass's batch, whose pull request is the pass's.
    const opened = store.write((ctx) =>
      insertPass(ctx, {
        id: mintId('Pass'),
        projectId: project.id,
        name: 'Polish',
        pageCap: 4,
        returnBranch: 'main',
        startSha: 'a'.repeat(40),
        branch: '10db/polish-abc123',
        baseBranch: 'main',
        repo: null,
        taskIds: [id],
        dirt: [],
      }),
    ).value;
    store.write((ctx) =>
      patchBatch(ctx, opened.batch.id, { prUrl: 'https://example.test/pr/pass' }),
    );
    const passRun = run(id, ran(3), 3, opened.batch.id);
    sentBackBy(passRun, 'review');
    store.write((ctx) => {
      ctx.tx.update(schema.tasks).set({ passId: null }).where(eq(schema.tasks.id, id)).run();
    });
    run(id, ran(1), 1, batch(project.id, 'own', 'https://example.test/pr/own'));
    finishAt(id, '2026-11-10T00:00:00.000Z');
    at(NOW);

    expect(
      rowOf(rigorFigures(store.db, project.id, new Date(nowMs), 14).rows, 'light'),
    ).toMatchObject({
      tasksDone: 1,
      stepsPerTask: 1,
      sessionsPerTask: 1,
      pullRequestsPerTask: 1,
      sentBackPerTask: 0,
    });
  });

  it('has no override figure when the judge sized nothing in the period', () => {
    const project = seedProject(store);
    call(JudgeDecision.TaskRigor, JudgeOutcome.Overridden, '2026-11-01T00:00:00.000Z', null);
    at(NOW);

    expect(rigorFigures(store.db, project.id, new Date(nowMs), 14).judgeOverride).toBeNull();
  });

  describe('when a task counts', () => {
    const cases: readonly {
      readonly name: string;
      readonly days: 7 | 14 | 30;
      readonly done: (id: TaskId) => void;
      readonly counted: boolean;
    }[] = [
      {
        name: 'done at the start of the window',
        days: 14,
        done: (id) => {
          finishAt(id, FROM);
        },
        counted: true,
      },
      {
        name: 'done a millisecond before the window',
        days: 14,
        done: (id) => {
          finishAt(id, '2026-10-31T11:59:59.999Z');
        },
        counted: false,
      },
      {
        name: 'done 10 days ago, in a 7-day window',
        days: 7,
        done: (id) => {
          finishAt(id, '2026-11-04T12:00:00.000Z');
        },
        counted: false,
      },
      {
        name: 'done 10 days ago, in a 30-day window',
        days: 30,
        done: (id) => {
          finishAt(id, '2026-11-04T12:00:00.000Z');
        },
        counted: true,
      },
      {
        name: 'done before the window, reopened and done again inside it (it counts when it finished)',
        days: 14,
        done: (id) => {
          finishAt(id, '2026-10-20T00:00:00.000Z');
          at('2026-10-21T00:00:00.000Z');
          store.write((ctx) => {
            setTaskStatus(ctx, id, TaskStatus.Open);
          });
          finishAt(id, '2026-11-10T00:00:00.000Z');
        },
        counted: true,
      },
      {
        name: 'done with no change logged, so its last update is when',
        days: 14,
        done: (id) => {
          at('2026-11-10T00:00:00.000Z');
          store.write((ctx) => {
            ctx.tx
              .update(schema.tasks)
              .set({ status: TaskStatus.Done, updatedAt: ctx.now })
              .where(eq(schema.tasks.id, id))
              .run();
          });
        },
        counted: true,
      },
      {
        name: 'reopened and not done again',
        days: 14,
        done: (id) => {
          finishAt(id, '2026-11-10T00:00:00.000Z');
          at('2026-11-11T00:00:00.000Z');
          store.write((ctx) => {
            setTaskStatus(ctx, id, TaskStatus.Open);
          });
        },
        counted: false,
      },
    ];
    it.each(cases)('$name: counted $counted', ({ days, done, counted }) => {
      const project = seedProject(store);
      const id = task(project.id, 'Subject', 'light');
      run(id, ran(1), 1);
      done(id);
      at(NOW);

      const light = rowOf(rigorFigures(store.db, project.id, new Date(nowMs), days).rows, 'light');
      expect(light?.tasksDone).toBe(counted ? 1 : 0);
    });
  });
});
