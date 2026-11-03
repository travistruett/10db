import {
  EventType,
  TaskStatus,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Shape spec §8. Lane time is the time a task's work held a lane: its sessions and its gate runs,
// not time queued for a lane or a gate slot, and not time waiting on a person. It is computed once,
// when a workstream finishes, and read from `task_lane_times` after that.

const MINUTE_MS = 60_000;

function minutesBetween(from: string, to: string): number {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / MINUTE_MS);
}

/**
 * A workstream's gate spans from its `gate.started` and `gate.finished` events, in order. A start
 * with no finish (a gate a shutdown killed) is left out: it has no end to count to.
 */
function gateSpans(db: DbReader, id: WorkstreamId): { minutes: number; count: number } {
  const rows = db
    .select({ type: schema.events.type, at: schema.events.at })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'workstream'),
        eq(schema.events.entityId, id),
        inArray(schema.events.type, [EventType.GateStarted, EventType.GateFinished]),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all();
  let open: string | null = null;
  let minutes = 0;
  let count = 0;
  for (const row of rows) {
    if (row.type === EventType.GateStarted) open = row.at;
    else if (open !== null) {
      minutes += minutesBetween(open, row.at);
      count += 1;
      open = null;
    }
  }
  return { minutes, count };
}

/**
 * Stores a finished workstream's lane time: its session spans plus its recorded gate spans. A
 * workstream with no session gets no row (its lane time can't be read); one whose gate ran with no
 * span recorded is marked sessions-only. Writing it again changes nothing.
 */
export function recordLaneTime(ctx: WriteContext, id: WorkstreamId): void {
  const ws = ctx.tx
    .select({ taskId: schema.workstreams.taskId })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.id, id))
    .get();
  if (!ws) return;
  const sessions = ctx.tx
    .select({ startedAt: schema.sessions.startedAt, endedAt: schema.sessions.endedAt })
    .from(schema.sessions)
    .where(eq(schema.sessions.workstreamId, id))
    .all();
  if (sessions.length === 0) return;
  const sessionMinutes = sessions.reduce(
    (sum, s) => sum + minutesBetween(s.startedAt, s.endedAt ?? ctx.now),
    0,
  );
  const gates = gateSpans(ctx.tx, id);
  const gateRan =
    ctx.tx
      .select({ id: schema.evidence.id })
      .from(schema.evidence)
      .where(and(eq(schema.evidence.workstreamId, id), eq(schema.evidence.kind, 'gate')))
      .get() !== undefined;
  ctx.tx
    .insert(schema.taskLaneTimes)
    .values({
      workstreamId: id,
      taskId: ws.taskId,
      laneMinutes: sessionMinutes + gates.minutes,
      sessionsOnly: gateRan && gates.count === 0,
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .run();
}

export interface TaskLaneTime {
  readonly taskId: TaskId;
  readonly minutes: number;
  /** Some of its workstreams finished before gate spans were recorded. */
  readonly sessionsOnly: boolean;
}

/** Each task's lane time, summed over its finished workstreams; a task with none is absent. */
export function laneTimesOf(db: DbReader, taskIds: readonly TaskId[]): Map<TaskId, TaskLaneTime> {
  const out = new Map<TaskId, TaskLaneTime>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select()
    .from(schema.taskLaneTimes)
    .where(inArray(schema.taskLaneTimes.taskId, [...taskIds]))
    .all();
  for (const row of rows) {
    const prev = out.get(row.taskId);
    out.set(row.taskId, {
      taskId: row.taskId,
      minutes: (prev?.minutes ?? 0) + row.laneMinutes,
      sessionsOnly: (prev?.sessionsOnly ?? false) || row.sessionsOnly,
    });
  }
  return out;
}

/** Every finished task of the project with its lane time: the population bucket medians read. */
export function listFinishedLaneTimes(db: DbReader, projectId: ProjectId): TaskLaneTime[] {
  const rows = db
    .select({ taskId: schema.taskLaneTimes.taskId })
    .from(schema.taskLaneTimes)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskLaneTimes.taskId))
    .where(and(eq(schema.tasks.projectId, projectId), eq(schema.tasks.status, TaskStatus.Done)))
    .all();
  return [...laneTimesOf(db, [...new Set(rows.map((r) => r.taskId))]).values()];
}

export interface SimilarTask {
  readonly taskId: TaskId;
  readonly title: string;
  readonly laneMinutes: number;
  readonly sessionsOnly: boolean;
  /** From its first run's creation to its last run's last change. */
  readonly wallMinutes: number;
  readonly tokens: number;
}

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter(
    (t) => t.length > 2,
  );
}

/**
 * `similar_tasks` (§5.5): the project's finished tasks with lane time, ranked by how many of the
 * query's words their title and description share (a title word counts twice). Tasks sharing none
 * are left out.
 */
export function similarTasks(
  db: DbReader,
  projectId: ProjectId,
  query: string,
  limit: number,
): SimilarTask[] {
  const wanted = terms(query);
  if (wanted.length === 0) return [];
  const finished = new Map(listFinishedLaneTimes(db, projectId).map((t) => [t.taskId, t]));
  if (finished.size === 0) return [];
  const tasks = db
    .select({
      id: schema.tasks.id,
      title: schema.tasks.title,
      description: schema.tasks.description,
    })
    .from(schema.tasks)
    .where(inArray(schema.tasks.id, [...finished.keys()]))
    .all();
  const scored = tasks
    .map((t) => {
      const title = new Set(terms(t.title));
      const body = new Set(terms(t.description));
      const score = wanted.reduce(
        (sum, w) => sum + (title.has(w) ? 2 : 0) + (body.has(w) ? 1 : 0),
        0,
      );
      return { task: t, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.task.id.localeCompare(b.task.id))
    .slice(0, limit);
  return scored.map(({ task }) => {
    const lane = finished.get(task.id);
    const span = db
      .select({
        from: sql<string>`min(${schema.workstreams.createdAt})`,
        to: sql<string>`max(${schema.workstreams.updatedAt})`,
      })
      .from(schema.workstreams)
      .where(eq(schema.workstreams.taskId, task.id))
      .get();
    const tokens = db
      .select({
        n: sql<number>`coalesce(sum(${schema.sessions.inputTokens} + ${schema.sessions.outputTokens}), 0)`,
      })
      .from(schema.sessions)
      .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
      .where(eq(schema.workstreams.taskId, task.id))
      .get();
    return {
      taskId: task.id,
      title: task.title,
      laneMinutes: lane?.minutes ?? 0,
      sessionsOnly: lane?.sessionsOnly ?? false,
      wallMinutes: span?.from && span.to ? minutesBetween(span.from, span.to) : 0,
      tokens: tokens?.n ?? 0,
    };
  });
}
