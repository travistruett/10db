import { Urgency, type ProjectId, type TaskId, type WorkstreamId } from '@10db/contracts';
import { findOpenByFoldKey, getTask, type WriteContext } from '@10db/db';
import { CardTier } from './card-tier';
import { flagCard, withdrawCard } from './service';

/** A task has one card for a run held because it was starting when 10db went down. */
const startHoldKey = (taskId: TaskId): string => `start-hold:${taskId}`;

/** The run that was held, as the card needs it. */
export interface StartHeldRun {
  readonly id: WorkstreamId;
  readonly taskId: TaskId;
  readonly projectId: ProjectId;
}

/**
 * Raises the card, in the caller's write, for a run held because it was starting at two unclean restarts
 * in a row: it may be what brings 10db down, so it waits for the builder instead of starting a third time.
 */
export function raiseStartHoldCard(
  ctx: WriteContext,
  run: StartHeldRun,
  cause: { readonly frozen: boolean },
): void {
  const task = getTask(ctx.tx, run.taskId);
  const happened = cause.frozen
    ? '10db stopped answering and the app restarted it'
    : '10db stopped unexpectedly';
  flagCard(ctx, {
    projectId: run.projectId,
    workstreamId: run.id,
    tier: CardTier.Ask,
    urgency: Urgency.High,
    closesWhen: {
      by: 'withdrawn',
      when: 'the task is started again (startTask) or the run is cancelled (cancelForWorkstream)',
    },
    title: `Held: ${task.title} stopped 10db while starting`,
    body: [
      `${happened}, the second time in a row while this run was starting, so the run may be what brings 10db down.`,
      'It is held instead of starting a third time, and no recovery attempt was counted against it.',
      'Start it again from the board once the cause is fixed, or remove it.',
    ].join(' '),
    foldKey: startHoldKey(run.taskId),
    refresh: true,
  });
}

/** Closes the task's start-hold card in the caller's write, once the task is started again. */
export function withdrawStartHoldCard(ctx: WriteContext, run: StartHeldRun): void {
  const open = findOpenByFoldKey(ctx.tx, run.projectId, startHoldKey(run.taskId));
  if (open !== undefined) withdrawCard(ctx, open.id);
}
