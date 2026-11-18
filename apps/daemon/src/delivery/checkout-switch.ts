import { BatchState, type BatchId } from '@10db/contracts';
import { getBatch, getProject } from '@10db/db';
import { FolderWaitCancelledError, type FolderHold } from '../folder-hold';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { resolveBranchReadyCards } from './branch-ready';
import { wrongBranchCard } from './cards';
import { batchCheckout } from './checkout';
import { raise } from './context';
import { reserveGitNaming } from './folder-wait';

export interface CheckoutSwitchDeps {
  readonly state: StateStore;
  readonly folderHold: FolderHold;
  readonly git: Git;
  readonly inbox: InboxService;
  readonly logger: Logger;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Switches the checkout of an open or failed batch onto the batch's branch, as the Switch Back of a
 * wrong-branch card asks, and closes that batch's wrong-branch cards once it is there. Nothing
 * uncommitted is touched: a checkout with changes in the way, a branch checked out in another worktree
 * or a detached HEAD stays as it is, and a new card says why.
 */
export async function switchToBatchBranch(
  deps: CheckoutSwitchDeps,
  batchId: BatchId,
  opts: { readonly signal?: AbortSignal } = {},
): Promise<void> {
  const db = deps.state.db;
  const batch = getBatch(db, batchId);
  if (
    (batch.state !== BatchState.Open && batch.state !== BatchState.Failed) ||
    batch.branch === null
  )
    return;
  const branch = batch.branch;
  const project = getProject(db, batch.projectId);
  const checkout = batchCheckout(db, batch);
  const refuse = (current: string | null, why: string): void => {
    deps.logger.info({ batchId, branch, why }, 'checkout not switched to the batch branch');
    raise(deps.inbox, project.id, wrongBranchCard(batch, current, checkout, 'waits', why));
  };
  const reserveFolder = checkout === project.repoPath;
  let token: symbol | null = null;
  if (reserveFolder) {
    try {
      token = await reserveGitNaming(deps, {
        projectId: project.id,
        batchId,
        what: `switching Your folder to \`${branch}\``,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      });
    } catch (error) {
      // 10db is stopping: the card is answered, and the next tick raises it again if the checkout is still off.
      if (error instanceof FolderWaitCancelledError) return;
      throw error;
    }
  }
  let current: string | null = null;
  try {
    current = await deps.git.currentBranch(checkout);
    if (current === branch) {
      await resolveBranchReadyCards({ db, git: deps.git, inbox: deps.inbox }, batch);
      return;
    }
    if (current === null) {
      refuse(current, 'the checkout is on a detached HEAD, so it has no branch to leave.');
      return;
    }
    const outcome = await deps.git.switchBack(checkout, current, {
      branch,
      sha: batch.baseSha ?? '',
    });
    switch (outcome.kind) {
      case 'switched':
        await resolveBranchReadyCards({ db, git: deps.git, inbox: deps.inbox }, batch);
        return;
      case 'moved':
        // The builder moved it again meanwhile; the next look at the branch decides.
        return;
      case 'dirty':
        refuse(
          current,
          `these files have changes that would be lost:\n${outcome.paths.join('\n')}`,
        );
        return;
      case 'ignored':
        refuse(
          current,
          `these git-ignored files are where the switch writes:\n${outcome.paths.join('\n')}`,
        );
        return;
      case 'checked_out':
        refuse(current, `${branch} is checked out in the worktree at ${outcome.path}.`);
        return;
      case 'gone':
        refuse(current, `${branch} no longer exists.`);
        return;
    }
  } catch (error) {
    refuse(current, message(error));
  } finally {
    if (token !== null) deps.folderHold.releaseGit(token);
  }
}
