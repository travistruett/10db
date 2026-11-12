import { mintId, type PassTurnId, type TaskId, type WorkstreamId } from '@10db/contracts';
import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10 "Which pages": the
// routes an agent names with `report_pages`, kept for the pictures of its turn or its run.

export type TaskPageReportRow = typeof schema.taskPageReports.$inferSelect;

/** Keeps the routes an agent reported, in the caller's write; appends no event, as tool records don't. */
export function insertTaskPageReports(
  ctx: WriteContext,
  input: {
    readonly taskId: TaskId;
    readonly workstreamId: WorkstreamId;
    /** The pass turn the call was made in; null for a task outside a pass. */
    readonly turnId: PassTurnId | null;
    readonly routes: readonly string[];
  },
): void {
  for (const route of input.routes)
    ctx.tx
      .insert(schema.taskPageReports)
      .values({
        id: mintId('TaskPageReport'),
        taskId: input.taskId,
        workstreamId: input.workstreamId,
        turnId: input.turnId,
        route,
        createdAt: ctx.now,
      })
      .run();
}

/** The routes reported in one turn of the task, or in one of its runs, oldest first. */
export function listTaskPageReports(
  db: DbReader,
  of:
    | { readonly taskId: TaskId; readonly turnId: PassTurnId }
    | { readonly taskId: TaskId; readonly workstreamId: WorkstreamId },
): TaskPageReportRow[] {
  return db
    .select()
    .from(schema.taskPageReports)
    .where(
      and(
        eq(schema.taskPageReports.taskId, of.taskId),
        'turnId' in of
          ? eq(schema.taskPageReports.turnId, of.turnId)
          : eq(schema.taskPageReports.workstreamId, of.workstreamId),
      ),
    )
    .orderBy(asc(schema.taskPageReports.createdAt), asc(schema.taskPageReports.id))
    .all();
}
