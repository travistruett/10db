import {
  JudgeDecision,
  mintId,
  type JudgeCallDto,
  type JudgeCallsPageDto,
  type JudgeCallId,
  type JudgeOutcome,
  type ProjectId,
  type TaskId,
  type TrustPrecedentId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
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
  /** Each yes/no question's probability of yes; absent for a choice. */
  readonly probabilities?: Readonly<Record<string, number>> | null;
  readonly outcome: JudgeOutcome;
  /** The whole wait, over every try. */
  readonly latencyMs: number | null;
  /** How many tries the call took; one when absent. */
  readonly attempts?: number;
  readonly costUsd: number | null;
  readonly workstreamId: WorkstreamId | null;
  readonly taskId: TaskId | null;
  /** The precedent that allowed the call; only on a reading by precedent. */
  readonly precedentId?: TrustPrecedentId | null;
  /** The program the shell call runs (`trust/program-key.ts`). */
  readonly programKey?: string | null;
}

/** Logs one call and answers its id, so the decision that acts on it can record what it did. */
export function insertJudgeCall(ctx: WriteContext, input: JudgeCallInput): JudgeCallId {
  const id = mintId('JudgeCall');
  ctx.tx
    .insert(schema.judgeCalls)
    .values({
      id,
      ...input,
      precedentId: input.precedentId ?? null,
      programKey: input.programKey ?? null,
      createdAt: ctx.now,
    })
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

/** What a logged call answered; null when it has no answer or does not exist. */
export function judgeCallAnswer(db: DbReader, callId: JudgeCallId): string | null {
  return (
    db
      .select({ answer: schema.judgeCalls.answer })
      .from(schema.judgeCalls)
      .where(eq(schema.judgeCalls.id, callId))
      .get()?.answer ?? null
  );
}

/** The most recent calls, newest first. The state sent is left out: it is task text and a diff. */
export function listJudgeCalls(db: DbReader, limit: number): JudgeCallDto[] {
  return pageJudgeCalls(db, { limit, offset: 0 }).calls;
}

/** One page of the call log, newest first, with every call the filters match counted in `total`. */
export function pageJudgeCalls(
  db: DbReader,
  q: {
    readonly limit: number;
    readonly offset: number;
    readonly decision?: JudgeDecision | undefined;
    readonly outcome?: JudgeOutcome | undefined;
  },
): JudgeCallsPageDto {
  const filters: SQL[] = [];
  if (q.decision !== undefined) filters.push(eq(schema.judgeCalls.decision, q.decision));
  if (q.outcome !== undefined) filters.push(eq(schema.judgeCalls.outcome, q.outcome));
  const where = filters.length > 0 ? and(...filters) : undefined;
  const calls = db
    .select({
      id: schema.judgeCalls.id,
      decision: schema.judgeCalls.decision,
      model: schema.judgeCalls.model,
      question: schema.judgeCalls.question,
      answer: schema.judgeCalls.answer,
      confidence: schema.judgeCalls.confidence,
      probabilities: schema.judgeCalls.probabilities,
      outcome: schema.judgeCalls.outcome,
      latencyMs: schema.judgeCalls.latencyMs,
      attempts: schema.judgeCalls.attempts,
      costUsd: schema.judgeCalls.costUsd,
      workstreamId: schema.judgeCalls.workstreamId,
      taskId: schema.judgeCalls.taskId,
      precedentId: schema.judgeCalls.precedentId,
      programKey: schema.judgeCalls.programKey,
      createdAt: schema.judgeCalls.createdAt,
    })
    .from(schema.judgeCalls)
    .where(where)
    .orderBy(desc(schema.judgeCalls.createdAt), desc(schema.judgeCalls.id))
    .limit(q.limit)
    .offset(q.offset)
    .all();
  const total = db.select({ n: count() }).from(schema.judgeCalls).where(where).get()?.n ?? 0;
  return { calls, total };
}

/** The part of a limits call's logged state that names the call: `call.input`, the tool's input. */
const LoggedCall = z.object({ call: z.object({ input: z.unknown() }) });

/**
 * The call a limits row judged, read out of its logged state: a shell call's command, else the tool's input as
 * JSON; null when the state can't be read or names no input.
 */
export function commandOfState(state: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return null;
  }
  const logged = LoggedCall.safeParse(parsed);
  if (!logged.success) return null;
  const input = logged.data.call.input;
  if (input === null || input === undefined) return null;
  const command = z.object({ command: z.string() }).safeParse(input);
  return command.success ? command.data.command : JSON.stringify(input);
}

/** A limits call of 10db's judge that wasn't sure, with the program it ran and the run it came from. */
export interface UnclearCall {
  readonly id: JudgeCallId;
  readonly programKey: string;
  /** The call's command, or its input as JSON; null when the logged state can't be read. */
  readonly command: string | null;
  readonly probabilities: Readonly<Record<string, number>> | null;
  readonly workstreamId: WorkstreamId;
  readonly taskId: TaskId;
  /** The run was in a separate copy. */
  readonly inCopy: boolean;
  readonly createdAt: string;
}

/**
 * The project's limits calls answered `unsure` (the answer `logged` in `trust/crosses-limit.ts` gives an unclear
 * reading) since `since`, each with a program key, oldest first. A call is the project's through its run.
 */
export function listUnclearLimitCalls(
  db: DbReader,
  projectId: ProjectId,
  since: string,
): UnclearCall[] {
  return db
    .select({
      id: schema.judgeCalls.id,
      programKey: schema.judgeCalls.programKey,
      state: schema.judgeCalls.state,
      probabilities: schema.judgeCalls.probabilities,
      workstreamId: schema.workstreams.id,
      taskId: schema.workstreams.taskId,
      copy: schema.localCopies.batchId,
      createdAt: schema.judgeCalls.createdAt,
    })
    .from(schema.judgeCalls)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.judgeCalls.workstreamId))
    .leftJoin(schema.localCopies, eq(schema.localCopies.batchId, schema.workstreams.batchId))
    .where(
      and(
        eq(schema.workstreams.projectId, projectId),
        eq(schema.judgeCalls.decision, JudgeDecision.CrossesLimit),
        eq(schema.judgeCalls.answer, 'unsure'),
        isNotNull(schema.judgeCalls.programKey),
        gte(schema.judgeCalls.createdAt, since),
      ),
    )
    .orderBy(asc(schema.judgeCalls.createdAt), asc(schema.judgeCalls.id))
    .all()
    .flatMap((row) =>
      row.programKey === null
        ? []
        : [
            {
              id: row.id,
              programKey: row.programKey,
              command: commandOfState(row.state),
              probabilities: row.probabilities,
              workstreamId: row.workstreamId,
              taskId: row.taskId,
              inCopy: row.copy !== null,
              createdAt: row.createdAt,
            },
          ],
    );
}

/** A call of a kind a precedent covers that a limit stopped while the same reading found the precedent applying. */
export interface PrecedentStop {
  /** The call's command, or its input as JSON; null when the logged state can't be read. */
  readonly call: string | null;
  /** The limit the call was stopped at (the row's answer). */
  readonly limit: string;
  readonly at: string;
}

/** Rows read before the precedent filter, so the few that matter are found among a busy key's calls. */
const STOP_SCAN_MAX = 200;

/**
 * The project's calls of a program key since `since` that a limit stopped, newest first, up to `max`, among the
 * rows that were asked whether a precedent applies: those a precedent's conflicts counted. A call is the
 * project's through its run.
 */
export function listPrecedentStops(
  db: DbReader,
  projectId: ProjectId,
  programKey: string,
  since: string,
  max: number,
): PrecedentStop[] {
  return db
    .select({
      state: schema.judgeCalls.state,
      answer: schema.judgeCalls.answer,
      probabilities: schema.judgeCalls.probabilities,
      createdAt: schema.judgeCalls.createdAt,
    })
    .from(schema.judgeCalls)
    .innerJoin(schema.workstreams, eq(schema.workstreams.id, schema.judgeCalls.workstreamId))
    .where(
      and(
        eq(schema.workstreams.projectId, projectId),
        inArray(schema.judgeCalls.decision, [
          JudgeDecision.CrossesLimit,
          JudgeDecision.CrossesLimitSecond,
        ]),
        eq(schema.judgeCalls.programKey, programKey),
        isNotNull(schema.judgeCalls.answer),
        notInArray(schema.judgeCalls.answer, ['allow', 'unsure']),
        gte(schema.judgeCalls.createdAt, since),
      ),
    )
    .orderBy(desc(schema.judgeCalls.createdAt), desc(schema.judgeCalls.id))
    .limit(STOP_SCAN_MAX)
    .all()
    .filter((row) => row.probabilities !== null && 'precedent_applies' in row.probabilities)
    .slice(0, max)
    .flatMap((row) =>
      row.answer === null
        ? []
        : [{ call: commandOfState(row.state), limit: row.answer, at: row.createdAt }],
    );
}

/** Deletes calls made before `cutoff` (an ISO time) and answers how many. */
export function deleteJudgeCallsBefore(ctx: WriteContext, cutoff: string): number {
  return ctx.tx.delete(schema.judgeCalls).where(lt(schema.judgeCalls.createdAt, cutoff)).run()
    .changes;
}
