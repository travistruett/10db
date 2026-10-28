import { BatchState, type BatchDto } from '@10db/contracts';
import type { InboxService } from '../inbox';
import { worktreeCards, wrongBranchCard } from './cards';
import { raise } from './context';

export const LaunchVerdict = {
  Launch: 'launch',
  Wait: 'wait',
  WrongBranch: 'wrong_branch',
} as const;
export type LaunchVerdict = (typeof LaunchVerdict)[keyof typeof LaunchVerdict];

/**
 * Batch delivery spec §5: pull-request work launches only when its batch is OPEN, its base is set
 * and the checkout is on its branch. Work with no batch never launches.
 */
export function batchLaunchVerdict(
  batch: BatchDto | null,
  currentBranch: string | null,
): LaunchVerdict {
  if (batch?.state !== BatchState.Open || batch.baseSha === null || batch.branch === null)
    return LaunchVerdict.Wait;
  return currentBranch === batch.branch ? LaunchVerdict.Launch : LaunchVerdict.WrongBranch;
}

/** One folded card while an open batch's work waits for its branch. */
export function flagWrongBranch(
  inbox: InboxService,
  batch: BatchDto,
  current: string | null,
  repoPath: string,
): void {
  raise(inbox, batch.projectId, wrongBranchCard(batch, current, repoPath, 'waits'));
}

/** One folded card while an open batch's work waits for a worktree that is gone. */
export function flagWorktreeMissing(inbox: InboxService, batch: BatchDto, path: string): void {
  raise(inbox, batch.projectId, worktreeCards.missing(batch, path, 'waits'));
}
