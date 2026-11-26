import { CopyStep, type CopyId, type TaskId } from '@10db/contracts';
import {
  getBatch,
  getLocalCopy,
  isLocalCopy,
  latestWorkstreamOf,
  type TendbDatabase,
} from '@10db/db';

/** Whether the task's newest workstream runs in a local copy's batch. */
export function taskInLocalCopy(db: TendbDatabase, taskId: TaskId): boolean {
  const batchId = latestWorkstreamOf(db, taskId)?.batchId ?? null;
  return batchId !== null && isLocalCopy(db, batchId);
}

/** The separate copy a task's work stands in before it lands: its id and its folder. */
export interface TaskCopy {
  readonly copyId: CopyId;
  readonly folder: string;
}

/** A copy that has landed shows its work in the shared app; one going or gone has no app of its own. */
const GONE: readonly CopyStep[] = [CopyStep.Landed, CopyStep.Retiring, CopyStep.Retired];

/** The copy the task's newest workstream runs in while its folder stands; null for any other task. */
export function copyOfTask(db: TendbDatabase, taskId: TaskId): TaskCopy | null {
  const batchId = latestWorkstreamOf(db, taskId)?.batchId ?? null;
  if (batchId === null) return null;
  const copy = getLocalCopy(db, batchId);
  if (copy === null || GONE.includes(copy.step)) return null;
  const folder = getBatch(db, batchId).worktreePath;
  return folder === null ? null : { copyId: copy.copyId, folder };
}
