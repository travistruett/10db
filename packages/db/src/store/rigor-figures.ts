import {
  EventType,
  JudgeDecision,
  JudgeOutcome,
  Rigor,
  TaskStatus,
  ALL_RIGORS,
  type GoalId,
  type ProjectId,
  type RigorFiguresDto,
  type RigorFiguresPeriod,
  type RigorFiguresRowDto,
  type TaskDto,
  type TaskId,
  type WorkstreamStep,
} from '@10db/contracts';
import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';
import { getTasks } from './tasks';

// What each rigor's finished work took, computed from the tasks, their workstreams' steps, sessions,
// batches and the judge's call log. Nothing is stored: the figures are recomputed on each read.

const DAY_MS = 86_400_000;

/** What `step.changed` records as `sentBackBy` when the builder, not a reviewer, sent the work back. */
const BUILDER_SENT_BACK = 'builder';
/** What it records when the acceptance check sent the work back: not a reviewer's send-back either. */
const ACCEPTANCE_SENT_BACK = 'acceptance';

/** What one done task took. */
interface TaskWork {
  readonly task: TaskDto;
  readonly steps: number;
  readonly sessions: number;
  readonly sentBack: number;
  readonly shippedWithFindings: boolean;
  readonly pullRequests: ReadonlySet<string>;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * When each task became done: its last logged change to done (a task reopened by a merge run and done
 * again counts when it finished), else its last update, for a task whose change was never logged.
 */
function doneTimes(db: DbReader, tasks: readonly TaskDto[]): Map<TaskId, number> {
  const out = new Map<TaskId, number>();
  if (tasks.length === 0) return out;
  const events = db
    .select({ entityId: schema.events.entityId, data: schema.events.data, at: schema.events.at })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'task'),
        eq(schema.events.type, EventType.TaskChanged),
        inArray(
          schema.events.entityId,
          tasks.map((t) => t.id),
        ),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all();
  const last = new Map<string, number>();
  for (const event of events) {
    if (event.data['status'] === TaskStatus.Done) last.set(event.entityId, Date.parse(event.at));
  }
  for (const task of tasks) out.set(task.id, last.get(task.id) ?? Date.parse(task.updatedAt));
  return out;
}

/** The steps, sessions, send-backs, findings and pull requests of each task's workstreams. */
function workOf(db: DbReader, tasks: readonly TaskDto[]): TaskWork[] {
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const workstreams = db
    .select({
      id: schema.workstreams.id,
      taskId: schema.workstreams.taskId,
      batchId: schema.workstreams.batchId,
      steps: schema.workstreams.steps,
    })
    .from(schema.workstreams)
    .leftJoin(schema.batches, eq(schema.batches.id, schema.workstreams.batchId))
    // A run in a pass's batch is the pass's, not the rigor's: a task taken out of a pass keeps it on the task.
    .where(and(inArray(schema.workstreams.taskId, ids), isNull(schema.batches.passId)))
    .all();
  const sessionsOf = new Map<string, number>();
  for (const s of workstreams.length === 0
    ? []
    : db
        .select({ workstreamId: schema.sessions.workstreamId })
        .from(schema.sessions)
        .where(
          inArray(
            schema.sessions.workstreamId,
            workstreams.map((w) => w.id),
          ),
        )
        .all()) {
    if (s.workstreamId !== null)
      sessionsOf.set(s.workstreamId, (sessionsOf.get(s.workstreamId) ?? 0) + 1);
  }
  // A reviewer's send-back is logged with the role that sent it; a builder's own send-back and a gate
  // failure are not the rigor's reviews. `sentBack` on the step is reset by a retry, so it is not read.
  const stepEvents =
    workstreams.length === 0
      ? []
      : db
          .select({ entityId: schema.events.entityId, data: schema.events.data })
          .from(schema.events)
          .where(
            and(
              eq(schema.events.entityType, 'workstream'),
              eq(schema.events.type, EventType.StepChanged),
              inArray(
                schema.events.entityId,
                workstreams.map((w) => w.id),
              ),
            ),
          )
          .all();
  const reviewerSendBacks = new Map<string, number>();
  for (const event of stepEvents) {
    const by = event.data['sentBackBy'];
    if (typeof by === 'string' && by !== BUILDER_SENT_BACK && by !== ACCEPTANCE_SENT_BACK)
      reviewerSendBacks.set(event.entityId, (reviewerSendBacks.get(event.entityId) ?? 0) + 1);
  }
  const batchIds = workstreams.flatMap((w) => (w.batchId === null ? [] : [w.batchId]));
  const prUrls = new Map(
    (batchIds.length === 0
      ? []
      : db
          .select({ id: schema.batches.id, prUrl: schema.batches.prUrl })
          .from(schema.batches)
          .where(inArray(schema.batches.id, batchIds))
          .all()
    ).map((b) => [b.id, b.prUrl]),
  );
  return tasks.map((task) => {
    const own = workstreams.filter((w) => w.taskId === task.id);
    const steps = own.flatMap((w): WorkstreamStep[] => w.steps);
    const pullRequests = new Set<string>();
    for (const w of own) {
      const url = w.batchId === null ? null : prUrls.get(w.batchId);
      if (url) pullRequests.add(url);
    }
    return {
      task,
      steps: steps.filter((s) => s.startedAt !== null).length,
      sessions: own.reduce((n, w) => n + (sessionsOf.get(w.id) ?? 0), 0),
      sentBack: own.reduce((sum, w) => sum + (reviewerSendBacks.get(w.id) ?? 0), 0),
      shippedWithFindings: steps.some((s) => s.shippedAtLimit !== undefined),
      pullRequests,
    };
  });
}

/** The tasks' own average of `figure`; null with no task. */
const perTask = (work: readonly TaskWork[], figure: (w: TaskWork) => number): number | null =>
  average(work.map(figure));

/**
 * For each goal with a task in `work`, the goal's tasks in `work` summed by `total`, averaged over those
 * goals; null when no task is in a goal.
 */
function perGoal(
  work: readonly TaskWork[],
  total: (tasks: readonly TaskWork[]) => number,
): number | null {
  const byGoal = new Map<GoalId, TaskWork[]>();
  for (const w of work) {
    const goalId = w.task.goalId;
    if (goalId === null || goalId === undefined) continue;
    byGoal.set(goalId, [...(byGoal.get(goalId) ?? []), w]);
  }
  return average([...byGoal.values()].map(total));
}

const sum = (tasks: readonly TaskWork[], figure: (w: TaskWork) => number): number =>
  tasks.reduce((n, w) => n + figure(w), 0);

const distinctPullRequests = (tasks: readonly TaskWork[]): number =>
  new Set(tasks.flatMap((w) => [...w.pullRequests])).size;

function row(rigor: RigorFiguresRowDto['rigor'], work: readonly TaskWork[]): RigorFiguresRowDto {
  return {
    rigor,
    tasksDone: work.length,
    stepsPerTask: perTask(work, (w) => w.steps),
    sessionsPerTask: perTask(work, (w) => w.sessions),
    pullRequestsPerTask: perTask(work, (w) => w.pullRequests.size),
    stepsPerGoal: perGoal(work, (t) => sum(t, (w) => w.steps)),
    sessionsPerGoal: perGoal(work, (t) => sum(t, (w) => w.sessions)),
    pullRequestsPerGoal: perGoal(work, distinctPullRequests),
    sentBackPerTask: perTask(work, (w) => w.sentBack),
    shippedWithFindings: perTask(work, (w) => (w.shippedWithFindings ? 1 : 0)),
  };
}

/**
 * What the project's tasks that became done in the last `days` days took, one row per rigor (by the
 * rigor each has now) and one for all of them, and how often the builder overrode the judge's sizing
 * in the same period, over the project's own sizing calls.
 */
export function rigorFigures(
  db: DbReader,
  projectId: ProjectId,
  now: Date,
  days: RigorFiguresPeriod,
): RigorFiguresDto {
  const nowMs = now.getTime();
  const from = nowMs - days * DAY_MS;
  // A task done in the window was last updated in it. A task still in a Workbench pass never ran a
  // rigor's plan, so it measures nothing about the rigor.
  const done = getTasks(
    db,
    db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.projectId, projectId),
          eq(schema.tasks.status, TaskStatus.Done),
          isNull(schema.tasks.passId),
          gte(schema.tasks.updatedAt, new Date(from).toISOString()),
        ),
      )
      .all()
      .map((t) => t.id),
  );
  const doneAt = doneTimes(db, done);
  const inWindow = done.filter((t) => {
    const at = doneAt.get(t.id) ?? 0;
    return at >= from && at <= nowMs;
  });
  const work = workOf(db, inWindow);

  const calls = db
    .select({ outcome: schema.judgeCalls.outcome })
    .from(schema.judgeCalls)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.judgeCalls.taskId))
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.judgeCalls.decision, JudgeDecision.TaskRigor),
        inArray(schema.judgeCalls.outcome, [JudgeOutcome.Acted, JudgeOutcome.Overridden]),
        gte(schema.judgeCalls.createdAt, new Date(from).toISOString()),
        lte(schema.judgeCalls.createdAt, now.toISOString()),
      ),
    )
    .all();
  return {
    period: days,
    rows: [
      ...Object.values(Rigor).map((rigor) =>
        row(
          rigor,
          work.filter((w) => w.task.effectiveRigor === rigor),
        ),
      ),
      row(ALL_RIGORS, work),
    ],
    judgeOverride:
      calls.length === 0
        ? null
        : {
            calls: calls.length,
            overridden: calls.filter((c) => c.outcome === JudgeOutcome.Overridden).length,
          },
  };
}
