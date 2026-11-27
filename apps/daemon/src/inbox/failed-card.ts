import {
  BuilderOwns,
  CARD_RELEASED_WORKSTREAMS,
  CARD_RESOLVES_WHEN,
  ReleasedWorkstreams,
  Urgency,
  WORKSTREAM_FAILED_TITLE_PREFIX,
  type BatchId,
  type InboxOption,
  type ProjectId,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getTask,
  updateInboxItem,
  type Json,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import { CardTier, decidedByBuilder } from './card-tier';
import { flagCard, withdrawCard } from './service';

/** A task has one failed card: a later run's failure folds into it. */
const failedCardKey = (taskId: TaskId): string => `failed:${taskId}`;

/** The detail key counting the runs of the task whose failures the card has stood for. */
const FAILED_RUNS = 'failedRuns';
const FailedRuns = z.number().int().min(2);

/** The run that failed, as the card needs it. */
export interface FailedRun {
  readonly id: WorkstreamId;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
  /** The batch the run was in: the card closes itself once it is over (`batch_over`). */
  readonly batchId?: BatchId | null;
}

/** What the card says of the run that failed last, and what its answers act on. */
export interface FailedCardContent {
  readonly body: string;
  readonly options?: readonly InboxOption[];
  readonly detail?: Record<string, Json>;
}

/**
 * Raises the task's failed card in the caller's write, or folds the failure into the one already open:
 * the card then speaks for this run, its answers act on it, and its title counts the runs. The earlier
 * runs leave its targets but keep the minutes they waited on it, as a lane cancelled off a card does.
 */
export function flagFailedRun(ctx: WriteContext, run: FailedRun, content: FailedCardContent): void {
  const foldKey = failedCardKey(run.taskId);
  const open = findOpenByFoldKey(ctx.tx, run.projectId, foldKey);
  const earlier = (open?.targets ?? []).map((t) => t.workstreamId).filter((id) => id !== run.id);
  // The detail is JSON read back from the database: a boundary, so parse it.
  const counted = FailedRuns.safeParse(open?.detail?.[FAILED_RUNS]).data ?? 1;
  const runs = open === undefined ? 1 : counted + (earlier.length > 0 ? 1 : 0);
  const released = [
    ...new Set([
      ...(ReleasedWorkstreams.safeParse(open?.detail?.[CARD_RELEASED_WORKSTREAMS]).data ?? []),
      ...earlier,
    ]),
  ];
  const detail: Record<string, Json> = {
    ...content.detail,
    ...(runs > 1 ? { [FAILED_RUNS]: runs } : {}),
    ...(released.length > 0 ? { [CARD_RELEASED_WORKSTREAMS]: released } : {}),
    ...(run.batchId === undefined || run.batchId === null
      ? {}
      : { [CARD_RESOLVES_WHEN]: { event: 'batch_over', batchId: run.batchId } }),
  };
  const task = getTask(ctx.tx, run.taskId);
  const card = flagCard(ctx, {
    projectId: run.projectId,
    workstreamId: run.id,
    tier: CardTier.Ask,
    urgency: Urgency.High,
    closesWhen: {
      by: 'withdrawn',
      when: 'the run is retried, cancelled or shipped (cancelForWorkstream), or a later run of the task finishes',
    },
    decision: decidedByBuilder(BuilderOwns.OutOfMoves),
    title: `${WORKSTREAM_FAILED_TITLE_PREFIX}${task.title}${runs > 1 ? ` (${String(runs)} runs)` : ''}`,
    body: content.body,
    ...(content.options === undefined ? {} : { options: content.options }),
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
    foldKey,
    refresh: true,
  });
  if (earlier.length > 0)
    updateInboxItem(ctx, card.id, { targets: [{ workstreamId: run.id, sessionId: null }] });
}

/** Closes the task's failed card in the caller's write, once a run of the task has finished. */
export function withdrawFailedCard(ctx: WriteContext, run: FailedRun): void {
  const open = findOpenByFoldKey(ctx.tx, run.projectId, failedCardKey(run.taskId));
  if (open !== undefined) withdrawCard(ctx, open.id);
}

/**
 * Says on the task's open failed card, after the run's own reason, what became of the run's work once
 * it failed. Each call replaces the last one's words. Answers false when no open card speaks for the
 * run, so the caller can say it another way.
 */
export function noteOnFailedCard(
  ctx: WriteContext,
  run: FailedRun & { readonly failureReason: string | null },
  note: string,
): boolean {
  const open = findOpenByFoldKey(ctx.tx, run.projectId, failedCardKey(run.taskId));
  if (!open?.targets.some((t) => t.workstreamId === run.id)) return false;
  const reason = run.failureReason ?? 'The run failed.';
  updateInboxItem(ctx, open.id, { body: `${reason}\n\n${note}` });
  return true;
}
