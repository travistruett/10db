import { z } from 'zod';
import { TaskId, WorkstreamId } from './ids';

const Timestamp = z.iso.datetime();

/** Why the scheduler passed over a queued run on its last tick. */
export const QueueWaitKind = {
  /** The lanes it may use are full of runs that are moving. */
  Lane: 'lane',
  /** Its account is signing in, reading its models, not ready, blocked or paused. */
  Account: 'account',
  /** The Mac is too loaded to start more work. */
  Machine: 'machine',
  /** A chat or 10db's own git work holds Your folder. */
  Folder: 'folder',
  /** A UI Workbench pass holds Your folder, or the run is a pass's page waiting for its turn. */
  Pass: 'pass',
  /** Its checkout is on another branch, its worktree is missing, or its branch has not been read yet. */
  Checkout: 'checkout',
  /** Its batch's copy is not made yet, or the batch is no longer open. */
  Copy: 'copy',
  /** A task it depends on is not done. */
  Dependency: 'dependency',
  /** An area or hazard it needs is held by another run. */
  Claim: 'claim',
  /** The builder parked the task. */
  Parked: 'parked',
  /** Its task's saved Workbench work is being put back first. */
  KeptWork: 'kept_work',
  /** It gave up a claim to another task twice and waits for that task. */
  Turn: 'turn',
} as const;
export type QueueWaitKind = (typeof QueueWaitKind)[keyof typeof QueueWaitKind];

/** The longest `QueueWait.line`: one clause on a task's card. */
export const QUEUE_WAIT_LINE_MAX = 300;

/**
 * What a queued run waits for, in plain words, as the scheduler last found it. `endless` says the wait
 * can never end by itself (a dependency that failed or was cancelled, a copy waiting for its own
 * member, a claim held by a finished run, a batch that is over). `on` names the run or task it waits
 * on, when there is one. `since` is when the scheduler first found this same wait.
 */
export const QueueWait = z.object({
  kind: z.enum(QueueWaitKind),
  line: z.string().min(1).max(QUEUE_WAIT_LINE_MAX),
  endless: z.boolean(),
  since: Timestamp,
  on: z.object({ taskId: TaskId, workstreamId: WorkstreamId.nullable() }).nullable(),
});
export type QueueWait = z.infer<typeof QueueWait>;
