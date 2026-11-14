import {
  BatchState,
  Effort,
  GoalStatus,
  InboxKind,
  InboxState,
  mintId,
  PullRequestState,
  QuestionCategory,
  Severity,
  SourceKind,
  StepRole,
  StepStatus,
  TaskStatus,
  ToolAccess,
  Urgency,
  WorkstreamState,
  type BatchId,
  type GoalDto,
  type PersonDto,
  type ProjectDto,
  type TaskId,
  type WorkstreamId,
  type WorkstreamStep,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../schema';
import { eq } from 'drizzle-orm';
import {
  goalDigest,
  listGoalSummaries,
  newItemCount,
  openGoalDigest,
  ungroupedDigest,
} from './goal-digest';
import { insertBoardColumn } from './board-columns';
import { insertGoal, lastGoalView, VISIT_MAX_MS } from './goals';
import { insertInboxItem } from './inbox';
import { insertDecision } from './decisions';
import { insertDeviation, insertSource } from './knowledge';
import { insertSession, updateSessionUsage } from './sessions';
import type { Store } from './store';
import { insertTask, setTaskStatus } from './tasks';
import { BUILDER_HANDLE, insertPerson } from './team';
import { createTestStore, seedProject } from './test-support';
import { insertBatch, recordPullRequestStatus, transitionBatch } from './batches';
import { getWorkstream, insertWorkstream, runNext } from './workstreams';
import { insertDraft, markReturned, markSending, markSent } from './stakeholder-sends';

let store: Store;
let close: () => void;
let clock: Date;
let project: ProjectDto;
let builder: PersonDto;

const at = (hours: number) => new Date(Date.UTC(2026, 10, 1, hours)).toISOString();
const setClock = (hours: number) => {
  clock = new Date(at(hours));
};

beforeEach(() => {
  clock = new Date(at(8));
  ({ store, close } = createTestStore(() => clock));
  project = seedProject(store);
  builder = store.write((ctx) =>
    insertPerson(ctx, { handle: BUILDER_HANDLE, name: 'You', isBuilder: true }),
  ).value;
});
afterEach(() => {
  close();
});

/** Three tasks: `a`, then `b` after `a`, and `c` after `b`. */
function adopt(projectId = project.id): { goal: GoalDto; a: TaskId; b: TaskId; c: TaskId } {
  const goal = store.write((ctx) =>
    insertGoal(ctx, projectId, {
      brief: {
        title: 'Real areas',
        objective: 'Areas.',
        tasks: [
          { key: 'a', title: 'Patch route', areas: ['api'] },
          { key: 'b', title: 'Drawer', areas: ['ui'], depends_on: ['a'] },
          { key: 'c', title: 'Proposal', areas: ['api'], depends_on: ['b'] },
        ],
      },
    }),
  ).value.goal;
  const [a, b, c] = goal.taskIds;
  if (!a || !b || !c) throw new Error('the brief makes three tasks');
  return { goal, a, b, c };
}

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
  status: StepStatus.Running,
  attempts: 0,
  startedAt: null,
  sessionFloor: 0,
  result: null,
  earlier: [],
  sentBack: 0,
  setting: null,
  ...over,
});

/** Starts the task and forces its workstream into `state`, with `steps` when given. */
function run(
  taskId: TaskId,
  state: WorkstreamState,
  opts: { steps?: WorkstreamStep[]; stepIndex?: number; batchId?: BatchId } = {},
): WorkstreamId {
  const id = store.write((ctx) =>
    insertWorkstream(ctx, taskId, {
      ...(opts.batchId ? { batchId: opts.batchId } : {}),
      first: { model: 'claude-sonnet-5-5', effort: 'medium' },
    }),
  ).value.id;
  store.write((ctx) => {
    ctx.tx
      .update(schema.workstreams)
      .set({ state, steps: opts.steps ?? [], stepIndex: opts.stepIndex ?? 0 })
      .where(eq(schema.workstreams.id, id))
      .run();
  });
  return id;
}

const finish = (taskId: TaskId) =>
  store.write((ctx) => {
    setTaskStatus(ctx, taskId, TaskStatus.Done);
  });

function card(workstreamId: WorkstreamId, title = 'Which name reads best?') {
  return store.write((ctx) =>
    insertInboxItem(ctx, {
      projectId: project.id,
      kind: InboxKind.Question,
      title,
      body: '',
      options: [],
      recommendation: null,
      category: QuestionCategory.Design,
      urgency: Urgency.Normal,
      detail: null,
      foldKey: null,
      targets: [{ workstreamId, sessionId: null }],
    }),
  ).value;
}

function source() {
  return store.write((ctx) => insertSource(ctx, SourceKind.Agent, {})).value;
}

function deviation(workstreamId: WorkstreamId | null, cause: string) {
  const sourceId = source();
  store.write((ctx) =>
    insertDeviation(ctx, {
      projectId: project.id,
      workstreamId,
      cause,
      severity: Severity.Info,
      signedReason: 'too big for one review',
      sourceId,
    }),
  );
}

function decision(
  question: string,
  projectId: ProjectDto['id'] | null = project.id,
  workstreamId: WorkstreamId | null = null,
) {
  const sourceId =
    workstreamId === null
      ? source()
      : store.write((ctx) => insertSource(ctx, SourceKind.Agent, { workstreamId })).value;
  store.write((ctx) =>
    insertDecision(ctx, {
      projectId,
      question,
      choice: 'Workspace packages',
      rationale: 'why',
      decidedBy: 'you',
      scope: 'project',
      area: null,
      sourceId,
    }),
  );
}

describe('a goal’s status', () => {
  it('is not started while nothing has run, and offers the first ready task next', () => {
    const { goal, a } = adopt();
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.NotStarted);
    expect(digest.progress).toEqual({ merged: 0, inReview: 0, total: 3, cancelled: [] });
    expect(digest.next).toEqual({
      taskId: a,
      title: 'Patch route',
      headline: '',
      waitsOn: [],
    });
    expect(digest.workingNow).toEqual([]);
    expect(digest.since).toBeNull();
  });

  it('is running while a task’s workstream is active', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Running);
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Running);
  });

  it('is queued, not running or not started, while a started task waits in the queue', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Queued);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Queued);
    expect(digest.workingNow).toEqual([]);
  });

  it('is queued when some tasks are done and the rest wait in the queue', () => {
    const { goal, a, b, c } = adopt();
    run(a, WorkstreamState.Done);
    store.write((ctx) => {
      setTaskStatus(ctx, a, TaskStatus.Done);
    });
    run(b, WorkstreamState.Queued);
    run(c, WorkstreamState.Queued);
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Queued);
  });

  it('is running, not queued, while one task runs and another waits in the queue', () => {
    const { goal, a, b } = adopt();
    run(a, WorkstreamState.Running);
    run(b, WorkstreamState.Queued);
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Running);
  });

  it('is waiting on you while an open card is on one of its tasks, ahead of running', () => {
    const { goal, a, b } = adopt();
    run(a, WorkstreamState.Running);
    card(run(b, WorkstreamState.WaitingHuman));
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.WaitingOnYou);
    expect(digest.waitingOn.recent).toEqual([
      expect.objectContaining({ taskId: b, title: 'Which name reads best?', assigneeName: 'You' }),
    ]);
  });

  describe('a question sent to someone else', () => {
    const SLACK = { teamId: 'T1', userId: 'U1', sendMode: 'review' as const, dailyLimit: 10 };

    /** A card on `workstream` whose send went out to Mark, and whether it has come back. */
    function sentTo(workstream: WorkstreamId, returned = false) {
      const item = card(workstream, 'How long should access last?');
      const mark = store.write((ctx) =>
        insertPerson(ctx, { handle: 'mark', name: 'Mark', slack: SLACK }),
      ).value;
      const send = store.write((ctx) =>
        insertDraft(ctx, { inboxItemId: item.id, recipients: [mark.id], text: 'Hi', hits: [] }),
      ).value;
      store.write((ctx) => {
        markSending(ctx, send.id, { textSha256: 'a', threadTs: null, startedAt: at(8) });
      });
      store.write((ctx) => {
        markSent(ctx, send.id, {
          channelId: 'D1',
          threadTs: '1.1',
          messageTs: '1.1',
          permalink: null,
          at: at(8),
        });
      });
      if (returned)
        store.write((ctx) => {
          markReturned(ctx, send.id, 'timer');
        });
      return item;
    }

    it('is waiting on someone, not on you, and names who', () => {
      const { goal, b } = adopt();
      sentTo(run(b, WorkstreamState.WaitingHuman));
      const digest = goalDigest(store.db, goal.id, null);
      expect(digest.status).toBe(GoalStatus.WaitingOnSomeone);
      expect(digest.waitingOn).toEqual({ recent: [], earlier: [] });
      expect(digest.waitingOnSomeone).toEqual([
        expect.objectContaining({ taskId: b, names: ['Mark'], at: at(8) }),
      ]);
    });

    it('is waiting on you while a builder card is open beside it', () => {
      const { goal, a, b } = adopt();
      sentTo(run(b, WorkstreamState.WaitingHuman));
      card(run(a, WorkstreamState.WaitingHuman));
      const digest = goalDigest(store.db, goal.id, null);
      expect(digest.status).toBe(GoalStatus.WaitingOnYou);
      expect(digest.waitingOn.recent).toHaveLength(1);
      expect(digest.waitingOnSomeone).toHaveLength(1);
    });

    it('is waiting on you again once the question came back', () => {
      const { goal, b } = adopt();
      sentTo(run(b, WorkstreamState.WaitingHuman), true);
      const digest = goalDigest(store.db, goal.id, null);
      expect(digest.status).toBe(GoalStatus.WaitingOnYou);
      expect(digest.waitingOnSomeone).toEqual([]);
    });

    it('leaves the run waiting on you while the builder also has a card open on it', () => {
      const { b } = adopt();
      const ws = run(b, WorkstreamState.WaitingHuman);
      sentTo(ws);
      expect(getWorkstream(store.db, ws).waitingOn).not.toBeNull();
      card(ws, 'Something only you can answer');
      expect(getWorkstream(store.db, ws).waitingOn).toBeNull();
    });

    it('puts waitingOn on the run whose question is out, and on no other', () => {
      const { b, c } = adopt();
      const waiting = run(b, WorkstreamState.WaitingHuman);
      const other = run(c, WorkstreamState.Running);
      sentTo(waiting);
      expect(getWorkstream(store.db, waiting).waitingOn).toEqual({ names: ['Mark'], since: at(8) });
      expect(getWorkstream(store.db, other).waitingOn).toBeNull();
    });
  });

  it('ignores a card that was answered', () => {
    const { goal, a } = adopt();
    const item = card(run(a, WorkstreamState.Running));
    store.write((ctx) => {
      ctx.tx
        .update(schema.inboxItems)
        .set({ state: InboxState.Resolved })
        .where(eq(schema.inboxItems.id, item.id))
        .run();
    });
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Running);
    expect(digest.waitingOn).toEqual({ recent: [], earlier: [] });
  });

  it('is failed when a task failed, even while another task waits on the builder', () => {
    const { goal, a, b } = adopt();
    run(a, WorkstreamState.Failed);
    card(run(b, WorkstreamState.WaitingHuman));
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Failed);
  });

  it('is no longer failed once the task is retried', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Failed);
    clock = new Date(at(9));
    run(a, WorkstreamState.Running);
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Running);
  });

  it('is done once every task that was not cancelled is done, in a project without pull requests', () => {
    const { goal, a, b, c } = adopt();
    store.write((ctx) => {
      setTaskStatus(ctx, c, TaskStatus.Cancelled);
    });
    run(a, WorkstreamState.Done);
    run(b, WorkstreamState.Done);
    finish(a);
    finish(b);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Done);
    expect(digest.progress).toMatchObject({
      merged: 2,
      inReview: 0,
      total: 2,
      cancelled: [{ taskId: c, title: 'Proposal' }],
    });
  });

  it('counts the done tasks over the tasks that are not cancelled', () => {
    const { goal, a, c } = adopt();
    store.write((ctx) => {
      setTaskStatus(ctx, c, TaskStatus.Cancelled);
    });
    run(a, WorkstreamState.Done);
    finish(a);
    expect(goalDigest(store.db, goal.id, null).progress).toMatchObject({
      merged: 1,
      inReview: 0,
      total: 2,
    });
  });

  it('is idle, not not started, once a task is done and nothing runs or waits in the queue', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Done);
    finish(a);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Idle);
    expect(digest.progress).toMatchObject({ merged: 1, inReview: 0, total: 3 });
  });

  it('is idle when a task ran and was cancelled, and nothing else runs', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Cancelled);
    store.write((ctx) =>
      insertSession(ctx, {
        workstreamId: ws,
        provider: 'claude',
        model: 'sonnet-5.5',
        effort: Effort.High,
        mode: 'managed',
        mcpTokenHash: `hash-${ws}`,
      }),
    );
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.Idle);
  });

  it('stays not started when a task was only held or queued-then-cancelled', () => {
    const { goal, a, b } = adopt();
    run(a, WorkstreamState.Held);
    run(b, WorkstreamState.Cancelled);
    expect(goalDigest(store.db, goal.id, null).status).toBe(GoalStatus.NotStarted);
  });
});

describe('a goal in a project with pull requests', () => {
  let prProject: ProjectDto;
  beforeEach(() => {
    prProject = seedProject(store, { delivery: 'pull_request', name: 'prs' });
  });

  function shippedBatch(title: string, state: PullRequestState | null): BatchId {
    const id = store.write((ctx) =>
      insertBatch(ctx, {
        projectId: prProject.id,
        title,
        baseBranch: 'main',
        worktreePath: `/tmp/wt/${title}`,
      }),
    ).value.id;
    for (const to of [BatchState.Open, BatchState.Shipping])
      store.write((ctx) => transitionBatch(ctx, id, { to }));
    store.write((ctx) =>
      transitionBatch(ctx, id, {
        to: BatchState.Shipped,
        patch: { prUrl: `https://github.com/o/r/pull/${title}` },
      }),
    );
    if (state)
      store.write((ctx) =>
        recordPullRequestStatus(ctx, id, {
          state,
          checks: 'passing',
          failingChecks: [],
          checkedAt: at(8),
          unknownReason: null,
        }),
      );
    return id;
  }

  const merge = (id: BatchId) =>
    store.write((ctx) =>
      recordPullRequestStatus(ctx, id, {
        state: PullRequestState.Merged,
        checks: 'passing',
        failingChecks: [],
        checkedAt: at(9),
        unknownReason: null,
      }),
    );

  it('is shipping while a pull request is open, and done only after every one merges', () => {
    const { goal, a, b, c } = adopt(prProject.id);
    const one = shippedBatch('one', PullRequestState.Open);
    const two = shippedBatch('two', PullRequestState.Open);
    run(a, WorkstreamState.Done, { batchId: one });
    run(b, WorkstreamState.Done, { batchId: one });
    run(c, WorkstreamState.Done, { batchId: two });
    for (const id of [a, b, c]) finish(id);

    let digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Shipping);
    expect(digest.openPullRequests).toBe(2);
    expect(digest.progress).toMatchObject({ merged: 0, inReview: 3, total: 3 });

    merge(one);
    digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Shipping);
    expect(digest.openPullRequests).toBe(1);
    expect(digest.progress).toMatchObject({ merged: 2, inReview: 1, total: 3 });

    merge(two);
    digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Done);
    expect(digest.openPullRequests).toBe(0);
  });

  it('counts a task whose batch closed with nothing to ship as on the base', () => {
    const { goal, a, b, c } = adopt(prProject.id);
    const closed = store.write((ctx) =>
      insertBatch(ctx, {
        projectId: prProject.id,
        title: 'closed',
        baseBranch: 'main',
        worktreePath: '/tmp/wt/closed',
      }),
    ).value.id;
    for (const to of [BatchState.Open, BatchState.Shipping])
      store.write((ctx) => transitionBatch(ctx, closed, { to }));
    store.write((ctx) =>
      transitionBatch(ctx, closed, { to: BatchState.Closed, reason: 'no commits beyond the base' }),
    );
    const open = shippedBatch('open', PullRequestState.Open);
    run(a, WorkstreamState.Done, { batchId: closed });
    run(b, WorkstreamState.Done, { batchId: open });
    run(c, WorkstreamState.Done, { batchId: open });
    for (const id of [a, b, c]) finish(id);

    let digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Shipping);
    expect(digest.openPullRequests).toBe(1);

    merge(open);
    digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Done);
    expect(digest.openPullRequests).toBe(0);
  });

  it('is shipping while a finished task’s batch has no pull request yet', () => {
    const { goal, a, b, c } = adopt(prProject.id);
    const unshipped = store.write((ctx) =>
      insertBatch(ctx, {
        projectId: prProject.id,
        title: 'unshipped',
        baseBranch: 'main',
        worktreePath: '/tmp/wt/unshipped',
      }),
    ).value.id;
    for (const id of [a, b, c]) {
      run(id, WorkstreamState.Done, { batchId: unshipped });
      finish(id);
    }
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Shipping);
    expect(digest.openPullRequests).toBe(0);
  });
});

describe('the rows', () => {
  it('lists the running workstreams with their persona, model, effort and step', () => {
    const { goal, a, b } = adopt();
    const steps = [
      step({ personaName: 'Planner', model: 'fable-5.1', status: StepStatus.Done }),
      step({ personaName: 'Implementer' }),
      step({
        role: StepRole.Review,
        personaName: 'Reviewer',
        model: 'opus-5.5',
        status: StepStatus.Pending,
      }),
    ];
    const ws = run(a, WorkstreamState.Running, { steps, stepIndex: 1 });
    run(b, WorkstreamState.Queued);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.workingNow).toEqual([
      {
        workstreamId: ws,
        taskId: a,
        taskTitle: 'Patch route',
        persona: 'Implementer',
        model: 'sonnet-5.5',
        effort: Effort.High,
        stepNumber: 2,
        stepCount: 3,
      },
    ]);
    expect(digest.team).toEqual([
      { persona: 'Planner', model: 'fable-5.1', effort: Effort.High },
      { persona: 'Implementer', model: 'sonnet-5.5', effort: Effort.High },
      { persona: 'Reviewer', model: 'opus-5.5', effort: Effort.High },
    ]);
  });

  it('names the next task and the open tasks it waits on once none is ready', () => {
    const { goal, a, b } = adopt();
    run(a, WorkstreamState.Running);
    expect(goalDigest(store.db, goal.id, null).next).toEqual({
      taskId: b,
      title: 'Drawer',
      headline: '',
      waitsOn: [{ taskId: a, title: 'Patch route' }],
    });
  });

  it('carries the next task’s headline', () => {
    const { goal, a } = adopt();
    store.write((ctx) => {
      ctx.tx
        .update(schema.tasks)
        .set({ headline: 'Routes can be patched' })
        .where(eq(schema.tasks.id, a))
        .run();
    });
    expect(goalDigest(store.db, goal.id, null).next).toMatchObject({
      taskId: a,
      headline: 'Routes can be patched',
    });
  });

  it('keeps each step’s effort in the team, so one persona and model at two efforts shows twice', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Running, {
      steps: [
        step({ personaName: 'Implementer', effort: Effort.High }),
        step({ role: StepRole.Review, personaName: 'Implementer', effort: Effort.Medium }),
      ],
    });
    expect(goalDigest(store.db, goal.id, null).team).toEqual([
      { persona: 'Implementer', model: 'sonnet-5.5', effort: Effort.High },
      { persona: 'Implementer', model: 'sonnet-5.5', effort: Effort.Medium },
    ]);
  });

  it('has no next task once every task has started', () => {
    const { goal, a, b, c } = adopt();
    for (const id of [a, b, c]) run(id, WorkstreamState.Running);
    expect(goalDigest(store.db, goal.id, null).next).toBeNull();
  });

  it('offers the queued task first in line next when every open task is queued', () => {
    const { goal, a, b, c } = adopt();
    // a is done, so b is free to start. c was started first, so it leads the queue, but it waits on
    // b: the scheduler passes it and starts b.
    finish(a);
    setClock(9);
    run(c, WorkstreamState.Queued);
    setClock(10);
    run(b, WorkstreamState.Queued);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.status).toBe(GoalStatus.Queued);
    expect(digest.next).toEqual({ taskId: b, title: 'Drawer', headline: '', waitsOn: [] });
  });

  it('puts a task the builder ran next ahead of the others in an all-queued goal’s next', () => {
    const free = store.write((ctx) =>
      insertGoal(ctx, project.id, {
        brief: {
          title: 'Free tasks',
          objective: 'No dependencies.',
          tasks: [
            { key: 'a', title: 'One', areas: ['api'] },
            { key: 'b', title: 'Two', areas: ['ui'] },
            { key: 'c', title: 'Three', areas: ['api'] },
          ],
        },
      }),
    ).value.goal;
    for (const [i, id] of free.taskIds.entries()) {
      setClock(9 + i);
      run(id, WorkstreamState.Queued);
    }
    const last = free.taskIds[2];
    if (!last) throw new Error('the brief makes three tasks');
    setClock(13);
    store.write((ctx) => runNext(ctx, last));
    expect(goalDigest(store.db, free.id, null).next?.taskId).toBe(last);
  });

  it('skips a queued task run next that waits on an open task, for one the scheduler can start', () => {
    const { goal, a, b, c } = adopt();
    // b waits on a. The builder runs b next, so b leads the queue, but the scheduler would pass it.
    setClock(9);
    run(a, WorkstreamState.Queued);
    setClock(10);
    run(b, WorkstreamState.Queued);
    setClock(11);
    run(c, WorkstreamState.Queued);
    setClock(13);
    store.write((ctx) => runNext(ctx, b));
    expect(goalDigest(store.db, goal.id, null).next).toEqual({
      taskId: a,
      title: 'Patch route',
      headline: '',
      waitsOn: [],
    });
  });

  it('lists the open dependencies of the queued task first in line when every queued task waits', () => {
    const { goal, a, b, c } = adopt();
    run(a, WorkstreamState.Running);
    run(c, WorkstreamState.Running);
    setClock(10);
    run(b, WorkstreamState.Queued);
    setClock(13);
    store.write((ctx) => runNext(ctx, b));
    expect(goalDigest(store.db, goal.id, null).next).toEqual({
      taskId: b,
      title: 'Drawer',
      headline: '',
      waitsOn: [{ taskId: a, title: 'Patch route' }],
    });
  });

  describe('with a parked task in an all-queued goal', () => {
    const park = (...ids: TaskId[]) => {
      const column = store.write((ctx) =>
        insertBoardColumn(ctx, project.id, { name: 'Exploring' }),
      ).value;
      for (const id of ids) {
        store.db
          .update(schema.tasks)
          .set({ boardColumnId: column.id })
          .where(eq(schema.tasks.id, id))
          .run();
      }
    };

    /** Tasks `a` and `b`, no dependencies, both queued with `a` leading. */
    function queuedPair(): { goal: GoalDto; a: TaskId; b: TaskId } {
      const goal = store.write((ctx) =>
        insertGoal(ctx, project.id, {
          brief: {
            title: 'Independent',
            objective: 'No dependencies.',
            tasks: [
              { key: 'a', title: 'Patch route', areas: ['api'] },
              { key: 'b', title: 'Drawer', areas: ['ui'] },
            ],
          },
        }),
      ).value.goal;
      const [a, b] = goal.taskIds;
      if (!a || !b) throw new Error('the brief makes two tasks');
      setClock(9);
      run(a, WorkstreamState.Queued);
      setClock(10);
      run(b, WorkstreamState.Queued);
      return { goal, a, b };
    }

    it('passes over a parked task that leads the queue, as the scheduler does', () => {
      const { goal, a, b } = queuedPair();
      expect(goalDigest(store.db, goal.id, null).next?.taskId).toBe(a);
      park(a);
      expect(goalDigest(store.db, goal.id, null).next).toEqual({
        taskId: b,
        title: 'Drawer',
        headline: '',
        waitsOn: [],
      });
    });

    it('offers the task first in line when every queued task is parked', () => {
      const { goal, a, b } = queuedPair();
      park(a, b);
      expect(goalDigest(store.db, goal.id, null).next?.taskId).toBe(a);
    });
  });

  it('sums tokens over the goal’s sessions, and dollars only where a session has them', () => {
    const { goal, a, b } = adopt();
    const wsA = run(a, WorkstreamState.Running);
    const wsB = run(b, WorkstreamState.Running);
    const open = (
      workstreamId: WorkstreamId,
      input: number,
      output: number,
      cost: number | null,
    ) => {
      const session = store.write((ctx) =>
        insertSession(ctx, {
          workstreamId,
          provider: 'claude',
          model: 'sonnet',
          effort: Effort.High,
          mode: 'managed',
          mcpTokenHash: `hash-${workstreamId}-${String(input)}`,
        }),
      ).value;
      store.write((ctx) => {
        updateSessionUsage(ctx, session.id, { inputTokens: input, outputTokens: output });
        ctx.tx
          .update(schema.sessions)
          .set({ costUsd: cost })
          .where(eq(schema.sessions.id, session.id))
          .run();
      });
    };
    open(wsA, 1000, 500, null);
    expect(goalDigest(store.db, goal.id, null).cost).toEqual({
      tokens: 1500,
      dollars: null,
      sessions: 1,
    });
    open(wsA, 200, 100, 0.5);
    open(wsB, 10, 5, 0.25);
    expect(goalDigest(store.db, goal.id, null).cost).toEqual({
      tokens: 1815,
      dollars: 0.75,
      sessions: 3,
    });
  });
});

describe('the window', () => {
  it('leaves what was recorded before the previous view out of the Δ rows', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(9);
    deviation(ws, 'Split A in two');
    decision('Areas follow packages?', project.id, ws);
    setClock(11);
    deviation(ws, 'Split B in two');
    decision('Names read how?', project.id, ws);

    const digest = goalDigest(store.db, goal.id, at(10));
    expect(digest.since).toBe(at(10));
    expect(digest.deviations.recent.map((d) => d.summary)).toEqual([
      'Split B in two: too big for one review',
    ]);
    expect(digest.deviations.earlier.map((d) => d.summary)).toEqual([
      'Split A in two: too big for one review',
    ]);
    expect(digest.decisions.recent.map((d) => d.question)).toEqual(['Names read how?']);
    expect(digest.decisions.earlier.map((d) => d.question)).toEqual(['Areas follow packages?']);
  });

  it('counts every item as recent on the first visit', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    deviation(ws, 'Split A in two');
    decision('Areas follow packages?', project.id, ws);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.deviations.recent).toHaveLength(1);
    expect(digest.decisions.recent).toHaveLength(1);
    expect(digest.deviations.earlier).toEqual([]);
  });

  it('reads only the deviations of the goal’s workstreams and the project’s decisions', () => {
    const { goal, a } = adopt();
    run(a, WorkstreamState.Running);
    const other = insertGoalFreeTask();
    deviation(run(other, WorkstreamState.Running), 'Someone else’s');
    deviation(null, 'No workstream');
    const elsewhere = seedProject(store, { name: 'elsewhere' });
    decision('Another project', elsewhere.id);
    decision('Global', null);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.deviations).toEqual({ recent: [], earlier: [] });
    expect(digest.decisions).toEqual({ recent: [], earlier: [] });
  });

  it('reads only the decisions recorded by the goal’s own tasks', () => {
    const { goal, a } = adopt();
    const mine = run(a, WorkstreamState.Running);
    const other = run(insertGoalFreeTask(), WorkstreamState.Running);
    decision('Mine', project.id, mine);
    decision('Another task’s', project.id, other);
    decision('By nobody', project.id);
    const digest = goalDigest(store.db, goal.id, null);
    expect(digest.decisions.recent.map((d) => d.question)).toEqual(['Mine']);
  });

  it('opening a goal answers the previous mark, then advances it', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(9);
    deviation(ws, 'Split A in two');

    setClock(10);
    const first = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    expect(first.since).toBeNull();
    expect(first.deviations.recent).toHaveLength(1);
    expect(lastGoalView(store.db, goal.id, builder.id)).toBe(at(10));

    setClock(11);
    deviation(ws, 'Split B in two');
    setClock(12);
    const second = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    expect(second.since).toBe(at(10));
    expect(second.deviations.recent.map((d) => d.summary)).toEqual([
      'Split B in two: too big for one review',
    ]);
    expect(second.deviations.earlier).toHaveLength(1);
    expect(lastGoalView(store.db, goal.id, builder.id)).toBe(at(12));
  });

  it('a refresh in the same visit answers the same Δ rows', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(9);
    deviation(ws, 'Split A in two');
    setClock(10);
    store.write((ctx) => openGoalDigest(ctx, goal.id));
    setClock(11);
    deviation(ws, 'Split B in two');

    setClock(12);
    const first = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    clock = new Date(new Date(at(12)).getTime() + 5_000);
    const refresh = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    clock = new Date(new Date(at(12)).getTime() + 4 * 60_000);
    const remount = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;

    expect(first.deviations.recent).toHaveLength(1);
    expect(refresh.since).toBe(first.since);
    expect(refresh.deviations).toEqual(first.deviations);
    expect(remount.since).toBe(first.since);
    expect(remount.deviations).toEqual(first.deviations);
    expect(newItemCount(refresh)).toBe(newItemCount(first));
    // Opening still closes the list's window.
    expect(listGoalSummaries(store.db, project.id).goals[0]?.newItems).toBe(0);
  });

  it('a first visit refreshed keeps every item recent', () => {
    const { goal, a } = adopt();
    deviation(run(a, WorkstreamState.Running), 'Split A in two');
    setClock(9);
    const first = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    clock = new Date(new Date(at(9)).getTime() + 5_000);
    const refresh = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    expect(first.since).toBeNull();
    expect(refresh.since).toBeNull();
    expect(refresh.deviations.recent).toHaveLength(1);
  });

  it('a visit ends after a quiet spell, and the next opening starts a new window', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(10);
    store.write((ctx) => openGoalDigest(ctx, goal.id));
    setClock(11);
    deviation(ws, 'Split B in two');
    setClock(12);
    store.write((ctx) => openGoalDigest(ctx, goal.id));
    clock = new Date(new Date(at(12)).getTime() + 31 * 60_000);
    const later = store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    expect(later.since).toBe(at(12));
    expect(later.deviations.recent).toEqual([]);
  });

  it('a visit that keeps being reopened still ends once it has run past its bounded length', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(8);
    deviation(ws, 'Split A in two');
    const start = new Date(at(9)).getTime();
    const openAt = (minutes: number) => {
      clock = new Date(start + minutes * 60_000);
      return store.write((ctx) => openGoalDigest(ctx, goal.id)).value;
    };
    const first = openAt(0);
    expect(first.since).toBeNull();
    // Opened every 20 minutes (under the gap): the visit goes on while it is short.
    for (let minutes = 20; minutes <= VISIT_MAX_MS / 60_000; minutes += 20) {
      expect(openAt(minutes).since).toBeNull();
    }
    // The next opening, still under the gap from the last, is past the bound: a new window
    // that starts at the previous opening, so what was read in the visit is no longer recent.
    const lastOpening = new Date(start + (VISIT_MAX_MS / 60_000) * 60_000).toISOString();
    const next = openAt(VISIT_MAX_MS / 60_000 + 20);
    expect(next.since).toBe(lastOpening);
    expect(next.deviations.recent).toEqual([]);
    // And that window is itself a visit that refreshes keep.
    expect(openAt(VISIT_MAX_MS / 60_000 + 25).since).toBe(lastOpening);
  });
});

describe('the goal list', () => {
  it('counts each goal’s new items from its own previous view without advancing it', () => {
    const { goal, a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    setClock(9);
    deviation(ws, 'Split A in two');
    decision('Areas follow packages?', project.id, ws);
    card(ws);

    setClock(10);
    store.write((ctx) => openGoalDigest(ctx, goal.id));
    setClock(11);
    deviation(ws, 'Split B in two');

    setClock(12);
    const list = listGoalSummaries(store.db, project.id);
    expect(list.goals).toHaveLength(1);
    expect(list.goals[0]).toMatchObject({ newItems: 1 });
    expect(list.goals[0]?.digest.status).toBe(GoalStatus.WaitingOnYou);
    expect(list.goals[0]?.digest.ungrouped).toBeNull();
    // Asking again changes nothing: only opening a goal advances its mark.
    expect(listGoalSummaries(store.db, project.id).goals[0]?.newItems).toBe(1);
    expect(lastGoalView(store.db, goal.id, builder.id)).toBe(at(10));
  });

  it('counts everything as new for a goal never opened', () => {
    const { a } = adopt();
    const ws = run(a, WorkstreamState.Running);
    deviation(ws, 'Split A in two');
    decision('Areas follow packages?', project.id, ws);
    expect(listGoalSummaries(store.db, project.id).goals[0]?.newItems).toBe(2);
  });

  it('carries the Ungrouped group', () => {
    adopt();
    const loose = insertGoalFreeTask();
    run(loose, WorkstreamState.Failed);
    expect(listGoalSummaries(store.db, project.id).ungrouped).toMatchObject({ failed: 1 });
  });
});

function insertGoalFreeTask(title = 'Loose task'): TaskId {
  return store.write((ctx) =>
    insertTask(ctx, project.id, { title, areas: ['api'], acceptanceCriteria: ['It works'] }),
  ).value.id;
}

describe('the Ungrouped group', () => {
  it('is null when no task without a goal is running or failed', () => {
    adopt();
    insertGoalFreeTask();
    const done = insertGoalFreeTask('Done task');
    run(done, WorkstreamState.Done);
    finish(done);
    expect(ungroupedDigest(store.db, project.id)).toBeNull();
  });

  it('lists a failed task with no goal', () => {
    const { a } = adopt();
    run(a, WorkstreamState.Failed);
    const loose = insertGoalFreeTask();
    const ws = run(loose, WorkstreamState.Failed);
    expect(ungroupedDigest(store.db, project.id)).toEqual({
      goalId: null,
      status: GoalStatus.Failed,
      running: 0,
      failed: 1,
      workstreams: [
        { workstreamId: ws, taskId: loose, taskTitle: 'Loose task', state: WorkstreamState.Failed },
      ],
    });
  });

  it('reports running tasks, and failed ahead of running', () => {
    const one = insertGoalFreeTask('One');
    const two = insertGoalFreeTask('Two');
    run(one, WorkstreamState.Running);
    expect(ungroupedDigest(store.db, project.id)).toMatchObject({
      status: GoalStatus.Running,
      running: 1,
      failed: 0,
    });
    run(two, WorkstreamState.Failed);
    expect(ungroupedDigest(store.db, project.id)).toMatchObject({
      status: GoalStatus.Failed,
      running: 1,
      failed: 1,
    });
  });

  it('leaves out a task that only waits in the queue', () => {
    run(insertGoalFreeTask('Queued'), WorkstreamState.Queued);
    expect(ungroupedDigest(store.db, project.id)).toBeNull();
    const running = insertGoalFreeTask('Running');
    run(running, WorkstreamState.Running);
    expect(ungroupedDigest(store.db, project.id)).toMatchObject({ running: 1, failed: 0 });
  });

  it('leaves out a Workbench page that is Ready, which waits on the builder and runs nothing', () => {
    const page = insertGoalFreeTask('Settings: UI work');
    const ws = run(page, WorkstreamState.WaitingHuman);
    store.write((ctx) => {
      ctx.tx
        .update(schema.workstreams)
        .set({ nextAction: { kind: 'pass_review', inboxId: mintId('InboxItem') } })
        .where(eq(schema.workstreams.id, ws))
        .run();
    });
    expect(ungroupedDigest(store.db, project.id)).toBeNull();
    run(insertGoalFreeTask('Asks'), WorkstreamState.WaitingHuman);
    expect(ungroupedDigest(store.db, project.id)).toMatchObject({ running: 1, failed: 0 });
  });

  it('comes with a goal’s digest', () => {
    const { goal } = adopt();
    run(insertGoalFreeTask(), WorkstreamState.Failed);
    expect(goalDigest(store.db, goal.id, null).ungrouped).toMatchObject({ failed: 1 });
  });
});
