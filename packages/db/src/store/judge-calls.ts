import {
  mintId,
  type JudgeCallDto,
  type JudgeCallId,
  type JudgeDecision,
  type JudgeOutcome,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { desc, eq, lt } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface JudgeCallInput {
  readonly decision: JudgeDecision;
  readonly model: string;
  /** What 10db built from the task for the model to read. */
  readonly state: string;
  readonly question: string;
  readonly answer: string | null;
  readonly confidence: number | null;
  readonly outcome: JudgeOutcome;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
  readonly workstreamId: WorkstreamId | null;
  readonly taskId: TaskId | null;
}

/** Logs one call and answers its id, so the decision that acts on it can record what it did. */
export function insertJudgeCall(ctx: WriteContext, input: JudgeCallInput): JudgeCallId {
  const id = mintId('JudgeCall');
  ctx.tx
    .insert(schema.judgeCalls)
    .values({ id, ...input, createdAt: ctx.now })
    .run();
  return id;
}

/** Replaces the outcome of a logged call with the one the decision reached (`acted` or `below_floor`). */
export function recordJudgeOutcome(
  ctx: WriteContext,
  callId: JudgeCallId,
  outcome: JudgeOutcome,
): void {
  ctx.tx.update(schema.judgeCalls).set({ outcome }).where(eq(schema.judgeCalls.id, callId)).run();
}

/** The most recent calls, newest first. The state sent is left out: it is task text and a diff. */
export function listJudgeCalls(db: DbReader, limit: number): JudgeCallDto[] {
  return db
    .select({
      id: schema.judgeCalls.id,
      decision: schema.judgeCalls.decision,
      model: schema.judgeCalls.model,
      question: schema.judgeCalls.question,
      answer: schema.judgeCalls.answer,
      confidence: schema.judgeCalls.confidence,
      outcome: schema.judgeCalls.outcome,
      latencyMs: schema.judgeCalls.latencyMs,
      costUsd: schema.judgeCalls.costUsd,
      workstreamId: schema.judgeCalls.workstreamId,
      taskId: schema.judgeCalls.taskId,
      createdAt: schema.judgeCalls.createdAt,
    })
    .from(schema.judgeCalls)
    .orderBy(desc(schema.judgeCalls.createdAt), desc(schema.judgeCalls.id))
    .limit(limit)
    .all();
}

/** Deletes calls made before `cutoff` (an ISO time) and answers how many. */
export function deleteJudgeCallsBefore(ctx: WriteContext, cutoff: string): number {
  return ctx.tx.delete(schema.judgeCalls).where(lt(schema.judgeCalls.createdAt, cutoff)).run()
    .changes;
}
