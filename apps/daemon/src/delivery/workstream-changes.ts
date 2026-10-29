import { existsSync } from 'node:fs';
import {
  ConflictError,
  NotFoundError,
  WorkspaceMode,
  WorkstreamState,
  type WorkstreamChangesDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
  getProject,
  getWorkstreamRow,
  openItemsForWorkstream,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import { z } from 'zod';
import { GitError, type Git } from '../git';
import { checkoutOf } from './checkout';

/** The most diff text one answer carries; the per-file counts always cover every file. */
export const MAX_CHANGES_DIFF_BYTES = 512 * 1024;

/** What the check card holds of the head it showed; the daemon wrote it, but it is read from disk. */
const CardHead = z.object({ head: z.string().regex(/^[0-9a-f]{40,64}$/) });

/** The head the builder was asked to check, while the workstream waits on that card. */
function checkedHead(db: DbReader, row: WorkstreamRow): string | null {
  if (row.state !== WorkstreamState.WaitingHuman || row.nextAction.kind !== 'builder_review')
    return null;
  const card = openItemsForWorkstream(db, row.id).find((item) => item.kind === 'check');
  const parsed = CardHead.safeParse(card?.detail);
  return parsed.success ? parsed.data.head : null;
}

/**
 * What a workstream changed: the diff from the head it started at to its head, for the builder to
 * check. The head is read once, from the check card the builder is looking at when there is one and
 * from its checkout (its batch's worktree, else the project's) otherwise, and every part of the
 * answer is read at that one commit.
 */
export async function workstreamChanges(
  deps: { readonly db: DbReader; readonly git: Git },
  id: WorkstreamId,
): Promise<WorkstreamChangesDto> {
  const row = getWorkstreamRow(deps.db, id);
  if (row.baseHead === null)
    throw new ConflictError(`Workstream ${id} has not started work in a checkout yet`);
  // A worktree batch's work lives in its worktree alone; once that is gone the project's checkout
  // holds none of it, so reading it would show someone else's changes.
  if (row.batchId !== null && getBatch(deps.db, row.batchId).worktreePath === null) {
    if (getProject(deps.db, row.projectId).workspaceMode === WorkspaceMode.Worktree)
      throw new ConflictError(`The worktree of workstream ${id}'s batch has been removed`);
  }
  const checkout = checkoutOf(deps.db, row);
  if (!existsSync(checkout)) throw new NotFoundError('checkout of workstream', id);
  const baseHead = row.baseHead;
  try {
    const head = checkedHead(deps.db, row) ?? (await deps.git.head(checkout));
    const [commits, changes] = await Promise.all([
      deps.git.commitsSince(checkout, baseHead, head),
      deps.git.diffSince(checkout, baseHead, head, MAX_CHANGES_DIFF_BYTES),
    ]);
    return {
      baseHead,
      head,
      commits,
      diff: changes.diff,
      truncated: changes.truncated,
      files: [...changes.files],
    };
  } catch (error) {
    // A base the checkout no longer holds, or a checkout with no commit yet, cannot be shown.
    if (error instanceof GitError)
      throw new ConflictError(`Workstream ${id}'s changes cannot be read: ${error.message}`);
    throw error;
  }
}
