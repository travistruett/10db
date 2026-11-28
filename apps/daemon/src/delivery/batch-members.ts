import {
  BatchState,
  LEFT_OUT_NOTICE_KEY,
  latestPerTask,
  McpToolName,
  TaskStatus,
  WorkstreamState,
  type BatchId,
  type WorkstreamDto,
} from '@10db/contracts';
import {
  getBatch,
  getTask,
  getWorkstream,
  hasToolOp,
  listWorkstreams,
  type DbReader,
} from '@10db/db';

/**
 * A failed member its task started over from: the task's current workstream is another, so nothing
 * can retry this one.
 */
export function superseded(db: DbReader, member: WorkstreamDto): boolean {
  if (member.state !== WorkstreamState.Failed) return false;
  const current = getTask(db, member.taskId).workstreamId;
  return current !== null && current !== member.id;
}

/** Whether the attempt committed through the commit tool, so its commits may be on the batch's branch. */
export function committed(db: DbReader, member: WorkstreamDto): boolean {
  return hasToolOp(db, member.id, McpToolName.Commit);
}

/**
 * Whether Ship without it left this run out of the batch's pull request. Only a failed run is: one
 * that ran again carries its work to the pull request whatever its notice says.
 */
export function leftOut(member: WorkstreamDto): boolean {
  return member.state === WorkstreamState.Failed && member.notice?.key === LEFT_OUT_NOTICE_KEY;
}

/**
 * Whether the run that replaced a superseded member has not got going yet, so the attempt may still
 * be the task's only one: the replacement's batch is still being cut (the cut may be refused), or
 * its cut was refused and detached it from any batch, leaving it cancelled before it ran. In both
 * cases the builder could still want the old batch to keep the attempt.
 */
function replacementUnsettled(db: DbReader, member: WorkstreamDto): boolean {
  const task = getTask(db, member.taskId);
  // A closed task will not start again, so nothing is left to wait for.
  if (task.status === TaskStatus.Cancelled || task.workstreamId === null) return false;
  const next = getWorkstream(db, task.workstreamId);
  if (next.batchId === null) return next.state === WorkstreamState.Cancelled;
  return getBatch(db, next.batchId).state === BatchState.Cutting;
}

/**
 * Whether a superseded member is held only because its replacement's cut was refused: the task's
 * latest run is cancelled and detached from any batch, and the task is still open to start again.
 */
export function replacementRefused(db: DbReader, member: WorkstreamDto): boolean {
  const task = getTask(db, member.taskId);
  if (task.status === TaskStatus.Cancelled || task.workstreamId === null) return false;
  const next = getWorkstream(db, task.workstreamId);
  return next.batchId === null && next.state === WorkstreamState.Cancelled;
}

/**
 * A batch's members: each task's latest workstream in it, except a superseded one that committed
 * nothing. It holds nothing the batch should wait for, so the batch ships the work of the rest. One
 * that committed stays a member: its commits are on the branch and passed no gate or review, so the
 * batch ships them only through Ship anyway, and its tasks' notice says so (`supersededNotices`).
 * One whose replacement is not yet cut stays too, until the cut has ended (`replacementUnsettled`).
 */
export function members(db: DbReader, batchId: BatchId): WorkstreamDto[] {
  return latestPerTask(listWorkstreams(db, { batchId })).filter(
    (m) => !superseded(db, m) || committed(db, m) || replacementUnsettled(db, m),
  );
}
