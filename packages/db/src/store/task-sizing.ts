import {
  EventType,
  RigorSource,
  TaskKindSource,
  TaskStatus,
  type JudgeCallId,
  type Rigor,
  type TaskDto,
  type GoalId,
  type PassId,
  type TaskId,
  type TaskKind,
} from '@10db/contracts';
import { and, asc, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import { listKinds } from './kinds';
import type { DbReader, WriteContext } from './store';
import { getTask, movedByProposal, type Placement } from './tasks';

/** The judge calls whose answers sizing applied: the rigor call, and one call per kind key. */
export interface SizingCalls {
  readonly rigor: JudgeCallId | null;
  readonly kinds: Readonly<Record<string, JudgeCallId>>;
}

/** What sizing found for a task, to be written under the guard `applyTaskSizing` holds. */
export interface TaskSizing {
  /** The fingerprint of the text this sizing was made for. */
  readonly fingerprint: string;
  /** The kinds sizing gives the task, each with the source that found it (`rules` or `judge`). */
  readonly kinds: readonly TaskKind[];
  /** The rigor the judge chose; left out when it answered none. */
  readonly rigor?: Rigor;
  readonly rigorReason?: string;
  readonly sizingCalls?: SizingCalls;
  /**
   * Drops a rigor the judge set earlier, for a task whose text changed and whose new answer has not come.
   * A rigor the builder or an agent set stays.
   */
  readonly clearJudged?: boolean;
}

/** What sizing reads of a task: its text, pins, fingerprint and whether it can still be sized. */
export interface TaskSizingState {
  readonly status: TaskStatus;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly areas: readonly string[];
  readonly goalId: GoalId | null;
  readonly passId: PassId | null;
  readonly rigorSource: RigorSource | null;
  readonly kinds: readonly TaskKind[];
  readonly kindsOff: readonly string[];
  /** The fingerprint of the text last sized; null before the first sizing. */
  readonly sizedFor: string | null;
  /** The judge calls whose answers sizing applied: the rigor call and one call per kind key. */
  readonly sizingCalls: SizingCalls;
  /** Whether any workstream of the task exists. */
  readonly started: boolean;
}

/** Open tasks no sizing has ever fingerprinted, oldest first, each with when it was made. */
export function listUnsizedTasks(db: DbReader): { id: TaskId; createdAt: string }[] {
  return db
    .select({ id: schema.tasks.id, createdAt: schema.tasks.createdAt })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.status, TaskStatus.Open), isNull(schema.tasks.sizedFor)))
    .orderBy(asc(schema.tasks.createdAt), asc(schema.tasks.id))
    .all();
}

/** The task's sizing state, one light read; null for a task that does not exist. */
export function readTaskSizing(db: DbReader, taskId: TaskId): TaskSizingState | null {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (row === undefined) return null;
  const started = db
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .get();
  return {
    status: row.status,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    areas: row.areas,
    goalId: row.goalId,
    passId: row.passId,
    rigorSource: row.rigorSource,
    kinds: row.kinds,
    kindsOff: row.kindsOff,
    sizedFor: row.sizedFor,
    sizingCalls: row.sizingCalls,
    started: started !== undefined,
  };
}

/**
 * Where the task works once its kinds are `kinds`; undefined keeps it where it is, as for a task whose join
 * into a batch is still pending.
 */
export type PlacementForKinds = (
  task: TaskDto,
  kinds: readonly TaskKind[],
) => Placement | undefined;

const PINNED_KIND_SOURCES: readonly TaskKind['source'][] = [
  TaskKindSource.Builder,
  TaskKindSource.Agent,
];

const sameKeys = (a: readonly TaskKind[], b: readonly TaskKind[]): boolean =>
  a.length === b.length && a.every((kind) => b.some((other) => other.key === kind.key));

/**
 * Writes what sizing found, and only what the task's pins allow; never throws. A task that has started,
 * is removed or does not exist is left untouched, the fingerprint included, and the answer is null.
 * Otherwise:
 *
 * - the kinds the builder or an agent gave stay, nothing the builder took off (`kindsOff`) is added, and
 *   a key no kind has is dropped; the rest of the kinds are the sizing's;
 * - a rigor is written only while the task's own is not the builder's or an agent's, and `clearJudged`
 *   drops one the judge set when no new one is given;
 * - the fingerprint is always written;
 * - when the kinds change, `placement` is asked where the task works, and the answer is taken as an edit of
 *   the task's areas or kinds takes it.
 */
export function applyTaskSizing(
  ctx: WriteContext,
  taskId: TaskId,
  sizing: TaskSizing,
  placement?: PlacementForKinds,
): TaskDto | null {
  const row = ctx.tx.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).get();
  if (row?.status !== TaskStatus.Open) return null;
  const started = ctx.tx
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, taskId))
    .get();
  if (started !== undefined) return null;

  const known = new Set(listKinds(ctx.tx).map((k) => k.key));
  const kept = row.kinds.filter((k) => PINNED_KIND_SOURCES.includes(k.source));
  const taken = new Set([...kept.map((k) => k.key), ...row.kindsOff]);
  const added = sizing.kinds.filter(
    (k, i) =>
      known.has(k.key) &&
      !taken.has(k.key) &&
      sizing.kinds.findIndex((other) => other.key === k.key) === i,
  );
  const kinds = [...kept, ...added];

  const rigorOpen =
    row.rigorSource !== RigorSource.Builder && row.rigorSource !== RigorSource.Agent;
  const writesRigor = sizing.rigor !== undefined && rigorOpen;
  const task = getTask(ctx.tx, taskId);
  const proposed = sameKeys(kinds, row.kinds) ? undefined : placement?.(task, kinds);
  const moved = proposed === undefined ? null : movedByProposal(ctx.tx, task, proposed);

  ctx.tx
    .update(schema.tasks)
    .set({
      kinds,
      sizedFor: sizing.fingerprint,
      ...(sizing.clearJudged === true && row.rigorSource === RigorSource.Judge
        ? { rigor: null, rigorSource: null, rigorReason: null }
        : {}),
      ...(sizing.sizingCalls === undefined
        ? {}
        : {
            sizingCalls: {
              rigor: sizing.sizingCalls.rigor,
              kinds: { ...sizing.sizingCalls.kinds },
            },
          }),
      ...(writesRigor
        ? {
            rigor: sizing.rigor ?? null,
            rigorSource: RigorSource.Judge,
            rigorReason: sizing.rigorReason ?? null,
          }
        : {}),
      ...(moved ?? {}),
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, taskId))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: taskId });
  return getTask(ctx.tx, taskId);
}

/**
 * Sets the rigor an agent chose for its own task, with the reason it gave, replacing any the judge or an
 * earlier agent set. The caller has already checked the pins and the kinds' floor; a task that has started
 * is the one an agent resizes, so unlike sizing this does not refuse one.
 */
export function setAgentRigor(
  ctx: WriteContext,
  taskId: TaskId,
  rigor: Rigor,
  reason: string,
): TaskDto {
  ctx.tx
    .update(schema.tasks)
    .set({
      rigor,
      rigorSource: RigorSource.Agent,
      rigorReason: reason,
      updatedAt: ctx.now,
    })
    .where(eq(schema.tasks.id, taskId))
    .run();
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: taskId });
  return getTask(ctx.tx, taskId);
}
