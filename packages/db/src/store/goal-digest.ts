import {
  ACTIVE_STATES,
  BatchState,
  GoalStatus,
  InboxState,
  LANE_STATES,
  PullRequestState,
  ROLE_LABEL,
  TaskStatus,
  WorkstreamState,
  Delivery,
  queueOrder,
  type DigestCost,
  type DigestDecision,
  type DigestDeviation,
  type DigestNext,
  type DigestTeamMember,
  type DigestWaitingOn,
  type DigestWorkingNow,
  type GoalDigestDto,
  type GoalId,
  type GoalListDto,
  type GoalStatus as GoalStatusValue,
  type PersonId,
  type ProjectId,
  type TaskId,
  type UngroupedDigestDto,
  type WorkstreamId,
} from '@10db/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getGoal, lastGoalView, markGoalViewed } from './goals';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { dependenciesDone, mergedDespiteFailure } from './tasks';
import { findPersonByHandle, BUILDER_HANDLE } from './team';

// Goals spec docs/superpowers/specs/2026-10-29-10db-goals-design.md §8: the digest is computed
// here, from the rows the daemon already keeps, never stored.

/** How many items a Δ row keeps behind Show Earlier. */
const EARLIER_LIMIT = 50;

type TaskRow = typeof schema.tasks.$inferSelect;
type WorkstreamRow = typeof schema.workstreams.$inferSelect;

/** A task's newest workstream and the batch it ran in. */
interface Run {
  readonly workstream: WorkstreamRow;
  readonly batch: {
    readonly state: BatchState;
    readonly prUrl: string | null;
    readonly prState: PullRequestState | null;
  } | null;
}

interface Facts {
  readonly tasks: TaskRow[];
  /** Every workstream of the tasks, oldest first. */
  readonly workstreams: WorkstreamRow[];
  /** The newest run of each task that has one. */
  readonly latest: Map<TaskId, Run>;
  /** The task each workstream belongs to. */
  readonly taskOfWorkstream: Map<WorkstreamId, TaskId>;
}

function gatherFacts(db: DbReader, tasks: TaskRow[]): Facts {
  const ids = tasks.map((t) => t.id);
  const rows =
    ids.length === 0
      ? []
      : db
          .select({
            workstream: schema.workstreams,
            batchState: schema.batches.state,
            prUrl: schema.batches.prUrl,
            prState: schema.batches.prState,
          })
          .from(schema.workstreams)
          .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
          .where(inArray(schema.workstreams.taskId, ids))
          .orderBy(schema.workstreams.createdAt, schema.workstreams.id)
          .all();
  const latest = new Map<TaskId, Run>();
  const taskOfWorkstream = new Map<WorkstreamId, TaskId>();
  for (const row of rows) {
    taskOfWorkstream.set(row.workstream.id, row.workstream.taskId);
    // Oldest first, so a later row replaces an earlier one.
    latest.set(row.workstream.taskId, {
      workstream: row.workstream,
      batch:
        row.batchState === null
          ? null
          : { state: row.batchState, prUrl: row.prUrl, prState: row.prState },
    });
  }
  return { tasks, workstreams: rows.map((r) => r.workstream), latest, taskOfWorkstream };
}

/** A run that has started and is not over: not terminal, not waiting in the queue, not set aside. */
function isRunning(run: Run | undefined): boolean {
  const state = run?.workstream.state;
  return (
    state !== undefined &&
    state !== WorkstreamState.Held &&
    state !== WorkstreamState.Queued &&
    ACTIVE_STATES.includes(state)
  );
}

/** A run that has started and waits in the queue for a lane. */
function isQueued(run: Run | undefined): boolean {
  return run?.workstream.state === WorkstreamState.Queued;
}

/** A run that failed and did not ship anyway (a failed run whose work shipped is judged by its pull request). */
function isFailed(run: Run | undefined): boolean {
  return (
    run?.workstream.state === WorkstreamState.Failed && run.batch?.state !== BatchState.Shipped
  );
}

/**
 * Whether a done task's work has reached its base: no batch to merge, a batch closed with nothing to
 * ship (as delivery's `notOnBase` counts it), or a merged pull request.
 */
function isMerged(run: Run | undefined): boolean {
  if (run?.batch == null) return true;
  if (run.batch.state === BatchState.Closed) return true;
  return run.batch.state === BatchState.Shipped && run.batch.prState === PullRequestState.Merged;
}

/** A shipped pull request that is neither merged nor closed. */
function hasOpenPullRequest(run: Run | undefined): boolean {
  const batch = run?.batch;
  return (
    batch?.state === BatchState.Shipped &&
    batch.prUrl !== null &&
    batch.prState !== PullRequestState.Merged &&
    batch.prState !== PullRequestState.Closed
  );
}

function openCards(db: DbReader, projectId: ProjectId, facts: Facts): DigestWaitingOn[] {
  const cards = db
    .select()
    .from(schema.inboxItems)
    .where(
      and(eq(schema.inboxItems.projectId, projectId), eq(schema.inboxItems.state, InboxState.Open)),
    )
    .orderBy(desc(schema.inboxItems.createdAt), desc(schema.inboxItems.id))
    .all();
  const rows: DigestWaitingOn[] = [];
  for (const card of cards) {
    const taskId = card.targets
      .map((t) => facts.taskOfWorkstream.get(t.workstreamId))
      .find((id) => id !== undefined);
    if (taskId === undefined) continue;
    const assignee = findPersonByHandle(db, card.assignee);
    rows.push({
      inboxItemId: card.id,
      taskId,
      title: card.title,
      assigneeId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? card.assignee,
      at: card.createdAt,
    });
  }
  return rows;
}

/** Items after `since` are recent; the rest wait behind Show Earlier. Newest first. */
function partition<T extends { readonly at: string }>(
  items: readonly T[],
  since: string | null,
): { recent: T[]; earlier: T[] } {
  const recent = items.filter((i) => since === null || i.at > since);
  const earlier = items.filter((i) => since !== null && i.at <= since).slice(0, EARLIER_LIMIT);
  return { recent, earlier };
}

function deviationsOf(db: DbReader, facts: Facts): DigestDeviation[] {
  const ids = facts.workstreams.map((w) => w.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(schema.deviations)
    .where(inArray(schema.deviations.workstreamId, ids))
    .orderBy(desc(schema.deviations.createdAt), desc(schema.deviations.id))
    .all()
    .map((d) => ({
      id: d.id,
      taskId: d.workstreamId === null ? null : (facts.taskOfWorkstream.get(d.workstreamId) ?? null),
      summary: `${d.cause}: ${d.signedReason}`,
      at: d.createdAt,
    }));
}

function decisionsOf(db: DbReader, projectId: ProjectId): DigestDecision[] {
  return db
    .select()
    .from(schema.decisions)
    .where(eq(schema.decisions.projectId, projectId))
    .orderBy(desc(schema.decisions.createdAt), desc(schema.decisions.id))
    .all()
    .map((d) => ({
      id: d.id,
      question: d.question,
      choice: d.choice,
      at: d.createdAt,
    }));
}

function costOf(db: DbReader, facts: Facts): DigestCost {
  const ids = facts.workstreams.map((w) => w.id);
  if (ids.length === 0) return { tokens: 0, dollars: null, sessions: 0 };
  const row = db
    .select({
      tokens: sql<number>`coalesce(sum(${schema.sessions.inputTokens} + ${schema.sessions.outputTokens}), 0)`,
      dollars: sql<number | null>`sum(${schema.sessions.costUsd})`,
      sessions: sql<number>`count(*)`,
    })
    .from(schema.sessions)
    .where(inArray(schema.sessions.workstreamId, ids))
    .get();
  return {
    tokens: row?.tokens ?? 0,
    dollars: row?.dollars ?? null,
    sessions: row?.sessions ?? 0,
  };
}

function workingNowOf(tasks: readonly TaskRow[], facts: Facts): DigestWorkingNow[] {
  const rows: DigestWorkingNow[] = [];
  for (const task of tasks) {
    const run = facts.latest.get(task.id);
    if (!run || !LANE_STATES.includes(run.workstream.state)) continue;
    const ws = run.workstream;
    const step = ws.steps[ws.stepIndex];
    rows.push({
      workstreamId: ws.id,
      taskId: task.id,
      taskTitle: task.title,
      persona: step?.personaName ?? ROLE_LABEL.implement,
      model: step?.model ?? ws.model,
      effort: step?.effort ?? ws.effort,
      stepNumber: Math.min(ws.stepIndex + 1, Math.max(1, ws.steps.length)),
      stepCount: Math.max(1, ws.steps.length),
    });
  }
  return rows;
}

/** The personas and models of the steps of every workstream that has started, each once. */
function teamOf(tasks: readonly TaskRow[], facts: Facts): DigestTeamMember[] {
  const seen = new Set<string>();
  const team: DigestTeamMember[] = [];
  for (const task of tasks) {
    const ws = facts.latest.get(task.id)?.workstream;
    if (!ws || ws.state === WorkstreamState.Queued || ws.state === WorkstreamState.Held) continue;
    for (const step of ws.steps) {
      const key = `${step.personaName}\0${step.model}\0${step.effort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      team.push({ persona: step.personaName, model: step.model, effort: step.effort });
    }
  }
  return team;
}

/** The open tasks a task waits on, in Board order. */
function openDependenciesOf(db: DbReader, taskId: TaskId): { taskId: TaskId; title: string }[] {
  return db
    .select({
      taskId: schema.tasks.id,
      title: schema.tasks.title,
      status: schema.tasks.status,
    })
    .from(schema.taskDeps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.dependsOnId))
    .where(eq(schema.taskDeps.taskId, taskId))
    .orderBy(schema.tasks.boardOrder, schema.tasks.id)
    .all()
    .filter((d) => d.status !== TaskStatus.Done && !mergedDespiteFailure(db, d.taskId))
    .map(({ taskId: id, title }) => ({ taskId: id, title }));
}

/**
 * The first task that can start now, else the first that cannot yet and what it waits on. With no
 * unstarted task left, the queued task the scheduler would start: the first in line whose
 * dependencies are done (it skips a queued task that waits, even one the builder ran next), else
 * the first in line with the open dependencies it waits on.
 */
function nextOf(db: DbReader, tasks: readonly TaskRow[], facts: Facts): DigestNext | null {
  const unstarted = tasks.filter((t) => {
    if (t.status !== TaskStatus.Open) return false;
    const state = facts.latest.get(t.id)?.workstream.state;
    return state === undefined || state === WorkstreamState.Cancelled;
  });
  const ready = unstarted.find((t) => dependenciesDone(db, t.id));
  if (ready) return { taskId: ready.id, title: ready.title, waitsOn: [] };
  const blocked = unstarted[0];
  if (!blocked) {
    const queued: { task: TaskRow; ws: WorkstreamRow }[] = [];
    for (const task of tasks) {
      const run = facts.latest.get(task.id);
      if (task.status === TaskStatus.Open && run && isQueued(run)) {
        queued.push({ task, ws: run.workstream });
      }
    }
    const inLine = queued.toSorted((x, y) => queueOrder(x.ws, y.ws));
    const startable = inLine.find((q) => dependenciesDone(db, q.task.id));
    if (startable) return { taskId: startable.task.id, title: startable.task.title, waitsOn: [] };
    const first = inLine[0];
    return first
      ? {
          taskId: first.task.id,
          title: first.task.title,
          waitsOn: openDependenciesOf(db, first.task.id),
        }
      : null;
  }
  return { taskId: blocked.id, title: blocked.title, waitsOn: openDependenciesOf(db, blocked.id) };
}

function goalTasks(db: DbReader, goalId: GoalId): TaskRow[] {
  return db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.goalId, goalId))
    .orderBy(schema.tasks.boardOrder, schema.tasks.id)
    .all();
}

/**
 * A goal's status, progress and rows. Status, first match wins: failed, waiting on you, running,
 * queued (nothing runs, an open task waits for a lane), shipping (every task done, a pull request unmerged), not started, done. `since` is the builder's
 * previous view of the goal; Δ rows hold what is newer, and null counts everything.
 */
export function goalDigest(db: DbReader, goalId: GoalId, since: string | null): GoalDigestDto {
  const digest = digestWithoutUngrouped(db, goalId, since);
  return { ...digest, ungrouped: ungroupedDigest(db, getGoal(db, goalId).projectId) };
}

function digestWithoutUngrouped(db: DbReader, goalId: GoalId, since: string | null): GoalDigestDto {
  const goal = getGoal(db, goalId);
  const project = getProject(db, goal.projectId);
  const all = goalTasks(db, goalId);
  const tasks = all.filter((t) => t.status !== TaskStatus.Cancelled);
  const facts = gatherFacts(db, all);

  const done = tasks.filter((t) => t.status === TaskStatus.Done);
  const waitingOn = openCards(db, goal.projectId, facts).filter((c) =>
    tasks.some((t) => t.id === c.taskId),
  );
  const open = tasks.filter((t) => t.status === TaskStatus.Open);

  let status: GoalStatusValue;
  if (open.some((t) => isFailed(facts.latest.get(t.id)))) status = GoalStatus.Failed;
  else if (waitingOn.length > 0) status = GoalStatus.WaitingOnYou;
  else if (open.some((t) => isRunning(facts.latest.get(t.id)))) status = GoalStatus.Running;
  else if (open.some((t) => isQueued(facts.latest.get(t.id)))) status = GoalStatus.Queued;
  else if (tasks.length > 0 && open.length === 0) {
    const shipped =
      project.delivery !== Delivery.PullRequest ||
      done.every((t) => isMerged(facts.latest.get(t.id)));
    status = shipped ? GoalStatus.Done : GoalStatus.Shipping;
  } else status = GoalStatus.NotStarted;

  const openBatches = new Set<string>();
  for (const task of tasks) {
    const run = facts.latest.get(task.id);
    if (run?.workstream.batchId && hasOpenPullRequest(run)) openBatches.add(run.workstream.batchId);
  }

  return {
    goalId,
    status,
    since,
    progress: {
      done: done.length,
      total: tasks.length,
      cancelled: all
        .filter((t) => t.status === TaskStatus.Cancelled)
        .map((t) => ({ taskId: t.id, title: t.title })),
    },
    openPullRequests: openBatches.size,
    workingNow: workingNowOf(tasks, facts),
    team: teamOf(tasks, facts),
    waitingOn: partition(waitingOn, since),
    next: nextOf(db, tasks, facts),
    deviations: partition(deviationsOf(db, facts), since),
    decisions: partition(decisionsOf(db, goal.projectId), since),
    cost: costOf(db, facts),
    ungrouped: null,
  };
}

/** Tasks of the project with no goal that are running or failed, under the status rule of a goal. */
export function ungroupedDigest(db: DbReader, projectId: ProjectId): UngroupedDigestDto | null {
  const tasks = db
    .select()
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        isNull(schema.tasks.goalId),
        eq(schema.tasks.status, TaskStatus.Open),
      ),
    )
    .orderBy(schema.tasks.boardOrder, schema.tasks.id)
    .all();
  const facts = gatherFacts(db, tasks);
  const shown: { task: TaskRow; run: Run; failed: boolean }[] = [];
  for (const task of tasks) {
    const run = facts.latest.get(task.id);
    if (!run) continue;
    if (isFailed(run)) shown.push({ task, run, failed: true });
    else if (isRunning(run)) shown.push({ task, run, failed: false });
  }
  if (shown.length === 0) return null;
  const failed = shown.filter((s) => s.failed).length;
  const running = shown.length - failed;
  const shownIds = new Set(shown.map((s) => s.task.id));
  const waiting = openCards(db, projectId, facts).some((c) => shownIds.has(c.taskId));
  return {
    goalId: null,
    status: failed > 0 ? GoalStatus.Failed : waiting ? GoalStatus.WaitingOnYou : GoalStatus.Running,
    running,
    failed,
    workstreams: shown
      .sort((a, b) => a.run.workstream.createdAt.localeCompare(b.run.workstream.createdAt))
      .map(({ task, run }) => ({
        workstreamId: run.workstream.id,
        taskId: task.id,
        taskTitle: task.title,
        state: run.workstream.state,
      })),
  };
}

/** How many items a digest's Δ rows hold. */
export const newItemCount = (digest: GoalDigestDto): number =>
  digest.waitingOn.recent.length + digest.deviations.recent.length + digest.decisions.recent.length;

function builderId(db: DbReader): PersonId | null {
  return findPersonByHandle(db, BUILDER_HANDLE)?.id ?? null;
}

/**
 * The digest of a goal the builder is opening: its Δ rows run from the previous view, and the
 * view advances to now. Without a builder there is no view to read or mark.
 */
export function openGoalDigest(ctx: WriteContext, goalId: GoalId): GoalDigestDto {
  getGoal(ctx.tx, goalId);
  const person = builderId(ctx.tx);
  const since = person === null ? null : markGoalViewed(ctx, goalId, person);
  return goalDigest(ctx.tx, goalId, since);
}

/**
 * The project's goals, oldest first, each with its digest and count of new items since the
 * builder last opened it, and the Ungrouped group. Reading the list leaves every view as it was.
 */
export function listGoalSummaries(db: DbReader, projectId: ProjectId): GoalListDto {
  getProject(db, projectId);
  const person = builderId(db);
  const goals = db
    .select({ id: schema.goals.id })
    .from(schema.goals)
    .where(eq(schema.goals.projectId, projectId))
    .orderBy(schema.goals.createdAt, schema.goals.id)
    .all();
  return {
    goals: goals.map(({ id }) => {
      const view = person === null ? null : lastGoalView(db, id, person);
      const digest = digestWithoutUngrouped(db, id, view);
      return { goal: getGoal(db, id), digest, newItems: newItemCount(digest) };
    }),
    ungrouped: ungroupedDigest(db, projectId),
  };
}
