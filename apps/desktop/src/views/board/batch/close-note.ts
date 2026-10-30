import type { BatchDto } from '@10db/contracts';

/**
 * The one line under Close: closing a failed task only takes it off the Board, so whatever branch
 * or worktree its run left stays where it is for the builder to ship, abandon or delete.
 */
export function closeNote(batch: Pick<BatchDto, 'branch' | 'worktreePath'> | undefined): string {
  if (batch?.branch == null) return 'Close leaves any branch or worktree the run made as it is.';
  return batch.worktreePath === null
    ? `Close keeps the branch ${batch.branch} as it is.`
    : `Close keeps the branch ${batch.branch} and its worktree as they are.`;
}
