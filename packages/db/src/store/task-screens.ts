import {
  EventType,
  Provider,
  mintId,
  NotFoundError,
  ScreenKind,
  TaskStatus,
  type PassTurnId,
  type ScreenTheme,
  type ScreenViewport,
  type TaskId,
  type TaskScreenDto,
  type TaskScreenId,
} from '@10db/contracts';
import { and, asc, count, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §11: a task's pictures
// as rows. The daemon writes a picture's file, named by its hash, before it calls these.

export type TaskScreenRow = typeof schema.taskScreens.$inferSelect;

/** A picture whose file is already written, at `storedPath`. */
export interface NewTaskScreen {
  readonly taskId: TaskId;
  readonly turnId: PassTurnId | null;
  readonly kind: ScreenKind;
  readonly route: string;
  readonly viewport: ScreenViewport;
  readonly theme: ScreenTheme;
  readonly sha256: string;
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly storedPath: string;
  readonly keptSha: string | null;
}

const columns = {
  row: schema.taskScreens,
  turnSeq: schema.passTurns.seq,
};

function toDto(row: TaskScreenRow, turnSeq: number | null): TaskScreenDto {
  return {
    id: row.id,
    taskId: row.taskId,
    turnId: row.turnId,
    turnSeq,
    kind: row.kind,
    route: row.route,
    viewport: row.viewport,
    theme: row.theme,
    width: row.width,
    height: row.height,
    size: row.size,
    sha256: row.sha256,
    keptSha: row.keptSha,
    createdAt: row.createdAt,
  };
}

/**
 * Keeps a picture's row and appends `task.screen_added`, in the caller's write. A turn picture with the
 * same hash as the newest unpruned turn picture of its task, route, viewport and theme is not kept:
 * answers null and writes nothing.
 */
export function insertTaskScreen(ctx: WriteContext, input: NewTaskScreen): TaskScreenDto | null {
  getTask(ctx.tx, input.taskId);
  if (input.kind === ScreenKind.Turn) {
    const last = ctx.tx
      .select({ sha256: schema.taskScreens.sha256, viewport: schema.taskScreens.viewport })
      .from(schema.taskScreens)
      .where(
        and(
          eq(schema.taskScreens.taskId, input.taskId),
          eq(schema.taskScreens.kind, ScreenKind.Turn),
          eq(schema.taskScreens.route, input.route),
          eq(schema.taskScreens.theme, input.theme),
          isNull(schema.taskScreens.prunedAt),
        ),
      )
      .orderBy(desc(schema.taskScreens.createdAt), desc(schema.taskScreens.id))
      .all()
      .find(
        (s) =>
          s.viewport.width === input.viewport.width && s.viewport.height === input.viewport.height,
      );
    if (last?.sha256 === input.sha256) return null;
  }
  const row: TaskScreenRow = {
    id: mintId('TaskScreen'),
    ...input,
    createdAt: ctx.now,
    prunedAt: null,
  };
  ctx.tx.insert(schema.taskScreens).values(row).run();
  ctx.emit({
    type: EventType.TaskScreenAdded,
    entityType: 'task',
    entityId: input.taskId,
    data: { taskId: input.taskId, screenId: row.id, turnId: row.turnId, kind: row.kind },
  });
  const turnSeq =
    row.turnId === null
      ? null
      : (ctx.tx
          .select({ seq: schema.passTurns.seq })
          .from(schema.passTurns)
          .where(eq(schema.passTurns.id, row.turnId))
          .get()?.seq ?? null);
  return toDto(row, turnSeq);
}

/** A task's unpruned pictures, oldest first, each with its turn's number. */
export function listTaskScreens(db: DbReader, taskId: TaskId): TaskScreenDto[] {
  return db
    .select(columns)
    .from(schema.taskScreens)
    .leftJoin(schema.passTurns, eq(schema.passTurns.id, schema.taskScreens.turnId))
    .where(and(eq(schema.taskScreens.taskId, taskId), isNull(schema.taskScreens.prunedAt)))
    .orderBy(asc(schema.taskScreens.createdAt), asc(schema.taskScreens.id))
    .all()
    .map((r) => toDto(r.row, r.turnSeq));
}

/** One picture's row, pruned or not, with where its file is. */
export function getTaskScreenRow(db: DbReader, id: TaskScreenId): TaskScreenRow {
  const row = db.select().from(schema.taskScreens).where(eq(schema.taskScreens.id, id)).get();
  if (!row) throw new NotFoundError('task screen', id);
  return row;
}

/** Whether an unpruned picture names the file of `sha256`; a file no such row names may be deleted. */
export function hashNamed(db: DbReader, sha256: string): boolean {
  return (
    db
      .select({ id: schema.taskScreens.id })
      .from(schema.taskScreens)
      .where(and(eq(schema.taskScreens.sha256, sha256), isNull(schema.taskScreens.prunedAt)))
      .get() !== undefined
  );
}

/** Whether the task has an unpruned picture of `kind`. */
export function hasTaskScreen(db: DbReader, taskId: TaskId, kind: ScreenKind): boolean {
  return (
    db
      .select({ id: schema.taskScreens.id })
      .from(schema.taskScreens)
      .where(
        and(
          eq(schema.taskScreens.taskId, taskId),
          eq(schema.taskScreens.kind, kind),
          isNull(schema.taskScreens.prunedAt),
        ),
      )
      .get() !== undefined
  );
}

/** What the before rule reads of a task: its pass turns and sessions on every run, and its kept work. */
export function taskStartFacts(
  db: DbReader,
  taskId: TaskId,
): { readonly turns: number; readonly sessions: number; readonly keptWorkSha: string | null } {
  const turns =
    db
      .select({ n: count() })
      .from(schema.passTurns)
      .where(eq(schema.passTurns.taskId, taskId))
      .get()?.n ?? 0;
  const sessions =
    db
      .select({ n: count() })
      .from(schema.sessions)
      .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
      .where(eq(schema.workstreams.taskId, taskId))
      .get()?.n ?? 0;
  const task = getTask(db, taskId);
  const keptWorkSha =
    db
      .select({ sha: schema.tasks.keptWorkSha })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, task.id))
      .get()?.sha ?? null;
  return { turns, sessions, keptWorkSha };
}

/** The tool calls the task's sessions reported up to `until`, on every run, oldest first. */
export function listTaskToolCalls(
  db: DbReader,
  taskId: TaskId,
  until: string,
): { readonly tool: string; readonly at: string }[] {
  const sessions = db
    .select({ id: schema.sessions.id })
    .from(schema.sessions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .where(eq(schema.workstreams.taskId, taskId))
    .all()
    .map((s) => s.id);
  if (sessions.length === 0) return [];
  return db
    .select({
      tool: sql<string | null>`json_extract(${schema.events.data}, '$.tool.name')`,
      at: schema.events.at,
    })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.entityType, 'session'),
        inArray(schema.events.entityId, sessions),
        eq(schema.events.type, EventType.SessionActivity),
        lte(schema.events.at, until),
      ),
    )
    .orderBy(asc(schema.events.seq))
    .all()
    .flatMap((r) => (r.tool === null ? [] : [{ tool: r.tool, at: r.at }]));
}

/**
 * The unpruned turn pictures of tasks done or cancelled, each with when its task finished (its last
 * update, read as the moment it was done), for the pruning sweep.
 */
export function listFinishedTurnScreens(db: DbReader): {
  readonly id: TaskScreenId;
  readonly taskId: TaskId;
  readonly kind: ScreenKind;
  readonly sha256: string;
  readonly doneAt: string;
}[] {
  return db
    .select({
      id: schema.taskScreens.id,
      taskId: schema.taskScreens.taskId,
      kind: schema.taskScreens.kind,
      sha256: schema.taskScreens.sha256,
      doneAt: schema.tasks.updatedAt,
    })
    .from(schema.taskScreens)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskScreens.taskId))
    .where(
      and(
        eq(schema.taskScreens.kind, ScreenKind.Turn),
        isNull(schema.taskScreens.prunedAt),
        inArray(schema.tasks.status, [TaskStatus.Done, TaskStatus.Cancelled]),
      ),
    )
    .orderBy(asc(schema.taskScreens.createdAt), asc(schema.taskScreens.id))
    .all();
}

/**
 * Marks pictures pruned: their rows stay as a record, and their files may go once no unpruned row
 * names them. Appends `task.changed` once per task whose pictures it pruned.
 */
export function markScreensPruned(ctx: WriteContext, ids: readonly TaskScreenId[]): void {
  if (ids.length === 0) return;
  const rows = ctx.tx
    .select({ taskId: schema.taskScreens.taskId })
    .from(schema.taskScreens)
    .where(and(inArray(schema.taskScreens.id, [...ids]), isNull(schema.taskScreens.prunedAt)))
    .all();
  ctx.tx
    .update(schema.taskScreens)
    .set({ prunedAt: ctx.now })
    .where(and(inArray(schema.taskScreens.id, [...ids]), isNull(schema.taskScreens.prunedAt)))
    .run();
  for (const taskId of new Set(rows.map((r) => r.taskId)))
    ctx.emit({
      type: EventType.TaskChanged,
      entityType: 'task',
      entityId: taskId,
      data: { screensPruned: rows.filter((r) => r.taskId === taskId).length },
    });
}

/** When each of the task's Codex sessions started, on every run, oldest first. */
export function listTaskCodexStarts(db: DbReader, taskId: TaskId): string[] {
  return db
    .select({ startedAt: schema.sessions.startedAt })
    .from(schema.sessions)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.sessions.workstreamId))
    .where(and(eq(schema.workstreams.taskId, taskId), eq(schema.sessions.provider, Provider.Codex)))
    .orderBy(asc(schema.sessions.startedAt))
    .all()
    .map((s) => s.startedAt);
}
