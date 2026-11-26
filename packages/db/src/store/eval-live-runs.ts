import {
  EvalLiveRunState,
  type EvalLiveRunId,
  type EvalSuiteKey,
  type ProjectId,
} from '@10db/contracts';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type EvalLiveRunRow = typeof schema.evalLiveRuns.$inferSelect;

/** What a live run starts with: everything the confirm window showed, and the log it writes. */
export type EvalLiveRunInput = Pick<
  EvalLiveRunRow,
  | 'id'
  | 'projectId'
  | 'suiteKey'
  | 'command'
  | 'stopCommand'
  | 'previewHash'
  | 'docker'
  | 'hostsJson'
  | 'envFilesJson'
  | 'costShownUsd'
  | 'logPath'
>;

/** What ends a run. */
export interface EvalLiveRunEnd {
  readonly state: EvalLiveRunState;
  readonly exitCode: number | null;
  readonly tail: string;
  readonly stopRan: boolean;
}

/** The project's `running` row, if any. */
export function runningEvalLiveRun(db: DbReader, projectId: ProjectId): EvalLiveRunRow | null {
  return (
    db
      .select()
      .from(schema.evalLiveRuns)
      .where(
        and(
          eq(schema.evalLiveRuns.projectId, projectId),
          eq(schema.evalLiveRuns.state, EvalLiveRunState.Running),
        ),
      )
      .get() ?? null
  );
}

/**
 * Inserts a `running` row unless the project already has one, in the same write, so two clicks can't both
 * start. Returns null for the one that lost.
 */
export function insertEvalLiveRun(
  ctx: WriteContext,
  input: EvalLiveRunInput,
): EvalLiveRunRow | null {
  if (runningEvalLiveRun(ctx.tx, input.projectId) !== null) return null;
  const row: EvalLiveRunRow = {
    ...input,
    state: EvalLiveRunState.Running,
    startedAt: ctx.now,
    endedAt: null,
    exitCode: null,
    tail: '',
    stopRan: false,
  };
  ctx.tx.insert(schema.evalLiveRuns).values(row).run();
  return row;
}

/** Ends a run, once: a row no longer `running` is left as it is. Returns whether this write ended it. */
export function finishEvalLiveRun(
  ctx: WriteContext,
  id: EvalLiveRunId,
  end: EvalLiveRunEnd,
): boolean {
  const result = ctx.tx
    .update(schema.evalLiveRuns)
    .set({ ...end, endedAt: ctx.now })
    .where(
      and(eq(schema.evalLiveRuns.id, id), eq(schema.evalLiveRuns.state, EvalLiveRunState.Running)),
    )
    .run();
  return result.changes > 0;
}

/** A project's runs, newest first, of one suite or of all. */
export function listEvalLiveRuns(
  db: DbReader,
  projectId: ProjectId,
  suiteKey: EvalSuiteKey | null,
  limit: number,
): EvalLiveRunRow[] {
  const where =
    suiteKey === null
      ? eq(schema.evalLiveRuns.projectId, projectId)
      : and(
          eq(schema.evalLiveRuns.projectId, projectId),
          eq(schema.evalLiveRuns.suiteKey, suiteKey),
        );
  return db
    .select()
    .from(schema.evalLiveRuns)
    .where(where)
    .orderBy(desc(schema.evalLiveRuns.startedAt), desc(schema.evalLiveRuns.id))
    .limit(limit)
    .all();
}

/** Marks every `running` row `interrupted` (a daemon that died left them) and returns them as they were. */
export function interruptRunningEvalLiveRuns(ctx: WriteContext): EvalLiveRunRow[] {
  const rows = ctx.tx
    .select()
    .from(schema.evalLiveRuns)
    .where(eq(schema.evalLiveRuns.state, EvalLiveRunState.Running))
    .all();
  if (rows.length === 0) return rows;
  ctx.tx
    .update(schema.evalLiveRuns)
    .set({ state: EvalLiveRunState.Interrupted, endedAt: ctx.now })
    .where(eq(schema.evalLiveRuns.state, EvalLiveRunState.Running))
    .run();
  return rows;
}

/** Records that the stop command of an interrupted run ran. */
export function markEvalLiveRunStopRan(ctx: WriteContext, id: EvalLiveRunId): void {
  ctx.tx
    .update(schema.evalLiveRuns)
    .set({ stopRan: true })
    .where(eq(schema.evalLiveRuns.id, id))
    .run();
}
