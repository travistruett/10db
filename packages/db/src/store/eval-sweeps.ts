import {
  EvalSweepState,
  type EvalSuiteKey,
  type EvalSweepId,
  type EvalSweepKind,
  type EvalSweepReason,
  type ProjectId,
} from '@10db/contracts';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type EvalSweepRow = typeof schema.evalSweeps.$inferSelect;

/** What a sweep starts with; its state is `running` and its steps are the caller's JSON. */
export interface EvalSweepInput {
  readonly id: EvalSweepId;
  readonly projectId: ProjectId;
  readonly suiteKey: EvalSuiteKey;
  readonly kind: EvalSweepKind;
  readonly capUsd: number;
  readonly modelsJson: string;
  readonly previewHash: string;
  readonly stepsJson: string;
}

/** What moves a running sweep: its steps, and, once it ends, how. */
export interface EvalSweepUpdate {
  readonly stepsJson: string;
  readonly end?: {
    readonly state: EvalSweepState;
    readonly reason: EvalSweepReason | null;
    readonly reasonText: string | null;
    readonly winner: string | null;
  };
}

/** The project's `running` sweep, if any. */
export function runningEvalSweep(db: DbReader, projectId: ProjectId): EvalSweepRow | null {
  return (
    db
      .select()
      .from(schema.evalSweeps)
      .where(
        and(
          eq(schema.evalSweeps.projectId, projectId),
          eq(schema.evalSweeps.state, EvalSweepState.Running),
        ),
      )
      .get() ?? null
  );
}

/** Every `running` sweep of every project: what a daemon stop or a crash leaves to end. */
export function listRunningEvalSweeps(db: DbReader): EvalSweepRow[] {
  return db
    .select()
    .from(schema.evalSweeps)
    .where(eq(schema.evalSweeps.state, EvalSweepState.Running))
    .all();
}

/**
 * Inserts a `running` sweep unless the project already has one, in the same write, so two clicks can't both
 * start. Returns null for the one that lost.
 */
export function insertEvalSweep(ctx: WriteContext, input: EvalSweepInput): EvalSweepRow | null {
  if (runningEvalSweep(ctx.tx, input.projectId) !== null) return null;
  const row: EvalSweepRow = {
    ...input,
    state: EvalSweepState.Running,
    reason: null,
    reasonText: null,
    winner: null,
    startedAt: ctx.now,
    endedAt: null,
  };
  ctx.tx.insert(schema.evalSweeps).values(row).run();
  return row;
}

/**
 * Moves a sweep that is still `running`, ending it when `end` is given, and answers the row as written, or null
 * when the sweep had already ended (a late settle, a Stop, a daemon stop): an ended sweep never changes again.
 */
export function updateRunningEvalSweep(
  ctx: WriteContext,
  id: EvalSweepId,
  update: EvalSweepUpdate,
): EvalSweepRow | null {
  const set = update.end
    ? {
        stepsJson: update.stepsJson,
        state: update.end.state,
        reason: update.end.reason,
        reasonText: update.end.reasonText,
        winner: update.end.winner,
        endedAt: ctx.now,
      }
    : { stepsJson: update.stepsJson };
  const result = ctx.tx
    .update(schema.evalSweeps)
    .set(set)
    .where(and(eq(schema.evalSweeps.id, id), eq(schema.evalSweeps.state, EvalSweepState.Running)))
    .run();
  return result.changes > 0 ? getEvalSweep(ctx.tx, id) : null;
}

/** Writes a sweep's steps whatever its state: a step's run id learned after the sweep ended. */
export function setEvalSweepSteps(ctx: WriteContext, id: EvalSweepId, stepsJson: string): void {
  ctx.tx.update(schema.evalSweeps).set({ stepsJson }).where(eq(schema.evalSweeps.id, id)).run();
}

export function getEvalSweep(db: DbReader, id: EvalSweepId): EvalSweepRow | null {
  return db.select().from(schema.evalSweeps).where(eq(schema.evalSweeps.id, id)).get() ?? null;
}

/** A suite's newest sweep. */
export function latestEvalSweep(
  db: DbReader,
  projectId: ProjectId,
  suiteKey: EvalSuiteKey,
): EvalSweepRow | null {
  return (
    db
      .select()
      .from(schema.evalSweeps)
      .where(
        and(eq(schema.evalSweeps.projectId, projectId), eq(schema.evalSweeps.suiteKey, suiteKey)),
      )
      .orderBy(desc(schema.evalSweeps.startedAt), desc(schema.evalSweeps.id))
      .limit(1)
      .get() ?? null
  );
}
