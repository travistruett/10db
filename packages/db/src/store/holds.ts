import {
  ConflictError,
  isTerminal,
  WorkstreamState,
  type TaskId,
  type WorkstreamDto,
} from '@10db/contracts';
import { getTask } from './tasks';
import type { WriteContext } from './store';
import { getWorkstream, latestWorkstreamOf, transitionWorkstream } from './workstreams';

/**
 * Sets a started task aside before it runs: its QUEUED run becomes HELD, so it leaves the queue and
 * takes no lane, and its batch, branch and worktree stay as they are. It gives up a place Run Next
 * gave it: started again, it waits its turn in start order. A run that has begun (a lane, a
 * session, a recovery or a send-back behind it) is refused, naming the way to stop it. Holding a
 * held task answers it again and emits nothing.
 */
export function holdTask(ctx: WriteContext, taskId: TaskId): WorkstreamDto {
  const task = getTask(ctx.tx, taskId);
  const run = latestWorkstreamOf(ctx.tx, taskId);
  if (!run || isTerminal(run.state))
    throw new ConflictError(`${task.title} hasn't been started, so there is nothing to hold`);
  if (run.state === WorkstreamState.Held) return getWorkstream(ctx.tx, run.id);
  const dto = getWorkstream(ctx.tx, run.id);
  if (run.state !== WorkstreamState.Queued)
    throw new ConflictError(
      `${task.title} is running: cancel it in Factory (/workstreams/${run.id}/cancel) instead`,
    );
  if (dto.sessionCount > 0 || run.attempt > 0 || run.recoveryAttempts > 0)
    throw new ConflictError(
      `${task.title} has already run: cancel it in Factory (/workstreams/${run.id}/cancel) instead`,
    );
  return transitionWorkstream(ctx, run.id, {
    to: WorkstreamState.Held,
    fence: null,
    patch: { runNextAt: null },
    reason: 'held by the builder',
  });
}

/** Puts a held run back in the queue, as the run it was: it takes the next free lane. */
export function resumeTask(ctx: WriteContext, taskId: TaskId): WorkstreamDto {
  const task = getTask(ctx.tx, taskId);
  const run = latestWorkstreamOf(ctx.tx, taskId);
  if (run?.state !== WorkstreamState.Held) throw new ConflictError(`${task.title} isn't held`);
  return transitionWorkstream(ctx, run.id, {
    to: WorkstreamState.Queued,
    fence: null,
    reason: 'started again by the builder',
  });
}
