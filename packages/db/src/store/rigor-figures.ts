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
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader } from './store';
import { listTasks } from './tasks';

// What each rigor's finished work took, computed from the tasks, their workstreams' steps, sessions,
// batches and the judge's call log. Nothing is stored: the figures are recomputed on each read.

const DAY_MS = 86_400_000;

/** What one done task took. */
interface TaskWork {
  readonly task: TaskDto;
  readonly steps: number;
  readonly sessions: number;
  readonly sendBacks: number;
  readonly shippedWithFindings: boolean;
  readonly pullRequests: ReadonlySet<string>;
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * When each task became done: its first logged change to done, else its last update, for a task whose
 * change was never logged.
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
  const first = new Map<string, number>();
  for (const event of events) {
    if (event.data['status'] === TaskStatus.Done && !first.has(event.entityId))
      first.set(event.entityId, Date.parse(event.at));
  }
  for (const task of tasks) out.set(task.id, first.get(task.id) ?? Date.parse(task.updatedAt));
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
    .where(inArray(schema.workstreams.taskId, ids))
    .all();
  const sessions =
    workstreams.length === 0
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
          .all();
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
      sessions: sessions.filter((s) => own.some((w) => w.id === s.workstreamId)).length,
      sendBacks: steps.reduce((sum, s) => sum + s.sentBack, 0),
      shippedWithFindings: steps.some((s) => s.shippedAtLimit !== undefined),
      pullRequests,
    };
  });
}

/** The distinct pull requests that carried each goal's tasks in `work`, averaged over the goals. */
function pullRequestsPerGoal(work: readonly TaskWork[]): number | null {
  const byGoal = new Map<GoalId, Set<string>>();
  for (const w of work) {
    const goalId = w.task.goalId;
    if (goalId === null || goalId === undefined) continue;
    const urls = byGoal.get(goalId) ?? new Set<string>();
    for (const url of w.pullRequests) urls.add(url);
    byGoal.set(goalId, urls);
  }
  return average([...byGoal.values()].map((urls) => urls.size));
}

function row(rigor: RigorFiguresRowDto['rigor'], work: readonly TaskWork[]): RigorFiguresRowDto {
  return {
    rigor,
    tasksDone: work.length,
    stepsPerTask: average(work.map((w) => w.steps)),
    sessionsPerTask: average(work.map((w) => w.sessions)),
    sendBacksPerTask: average(work.map((w) => w.sendBacks)),
    pullRequestsPerGoal: pullRequestsPerGoal(work),
    shippedWithFindings: average(work.map((w) => (w.shippedWithFindings ? 1 : 0))),
  };
}

/**
 * What the project's tasks that became done in the last `days` days took, one row per rigor (by the
 * rigor each has now) and one for all of them, and how often the builder overrode the judge's sizing
 * in the same period, across every project.
 */
export function rigorFigures(
  db: DbReader,
  projectId: ProjectId,
  now: Date,
  days: RigorFiguresPeriod,
): RigorFiguresDto {
  const nowMs = now.getTime();
  const from = nowMs - days * DAY_MS;
  const done = listTasks(db, projectId).filter((t) => t.status === TaskStatus.Done);
  const doneAt = doneTimes(db, done);
  const inWindow = done.filter((t) => {
    const at = doneAt.get(t.id) ?? 0;
    return at >= from && at <= nowMs;
  });
  const work = workOf(db, inWindow);

  const calls = db
    .select({ outcome: schema.judgeCalls.outcome })
    .from(schema.judgeCalls)
    .where(
      and(
        eq(schema.judgeCalls.decision, JudgeDecision.TaskRigor),
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
