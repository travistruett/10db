import {
  PassState,
  TaskStatus,
  WorkstreamState,
  type TaskId,
  type TaskMessageId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertSystemNotice,
  passHoldingTask,
  patchWorkstream,
  setTaskStatus,
  type WriteContext,
} from '@10db/db';
import { passPlan } from '../delivery';
import { insertPlannedWorkstream } from '../team';

// Workbench spec §6.1: a message to a signed-off page of an open pass reopens it. The signed-off run
// stays DONE, its commit landed; a new run of the task takes the message as a `feedback` turn in a
// fresh session that starts from the thread's digest. The scheduler claims the page for it, or it
// waits for the page as any pass page does, and its sign-off lands a second commit.

/**
 * In the caller's write: when `taskId` is a signed-off page of an open pass, makes its new run,
 * queued with `messageId`, and answers it; otherwise changes nothing and answers null.
 */
export function reopenSignedOffPage(
  ctx: WriteContext,
  taskId: TaskId,
  messageId: TaskMessageId,
): WorkstreamDto | null {
  const task = getTask(ctx.tx, taskId);
  const pass = passHoldingTask(ctx.tx, task);
  if (pass?.state !== PassState.Open || task.workstreamId === null) return null;
  if (getWorkstreamRow(ctx.tx, task.workstreamId).state !== WorkstreamState.Done) return null;
  setTaskStatus(ctx, taskId, TaskStatus.Open);
  const run = insertPlannedWorkstream(ctx, taskId, passPlan(ctx.tx, task), pass.batchId);
  patchWorkstream(ctx, run.id, null, {
    nextAction: { kind: 'feedback', messageId, providerSessionId: null },
  });
  insertSystemNotice(
    ctx,
    taskId,
    'Reopened: the page takes this message in a new session, and its next sign-off lands a second commit.',
  );
  return getWorkstream(ctx.tx, run.id);
}
