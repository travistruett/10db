import { existsSync } from 'node:fs';
import {
  ConflictError,
  NotFoundError,
  PassCheckDetail,
  UNFINISHED_BATCH_STATES,
  WorkstreamState,
  type WorkstreamChangesDto,
  type WorkstreamId,
} from '@10db/contracts';
import {
  getBatch,
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

/** The head the builder was asked to check, while the workstream waits on the card it points at. */
function checkedHead(db: DbReader, row: WorkstreamRow): string | null {
  if (row.state !== WorkstreamState.WaitingHuman || row.nextAction.kind !== 'builder_review')
    return null;
  const { inboxId } = row.nextAction;
  const card = openItemsForWorkstream(db, row.id).find(
    (item) => item.id === inboxId && item.kind === 'check',
  );
  const parsed = CardHead.safeParse(card?.detail);
  return parsed.success ? parsed.data.head : null;
}

/**
 * What a Ready pass page shows, while the workstream waits on its `check` item: the turn's kept commit
 * against the pass branch tip it was kept on. A page with no kept commit yet shows that tip alone.
 */
function shownKeptWork(db: DbReader, row: WorkstreamRow): { base: string; head: string } | null {
  if (row.state !== WorkstreamState.WaitingHuman || row.nextAction.kind !== 'pass_review')
    return null;
  const { inboxId } = row.nextAction;
  const item = openItemsForWorkstream(db, row.id).find(
    (i) => i.id === inboxId && i.kind === 'check',
  );
  const parsed = PassCheckDetail.safeParse(item?.detail);
  if (!parsed.success) return null;
  return { base: parsed.data.keptBaseSha, head: parsed.data.keptSha ?? parsed.data.keptBaseSha };
}

/**
 * What a workstream changed: the diff from the head it started at to its head, for the builder to
 * check. The head is read once, from the check card the builder is looking at when there is one and
 * from its checkout (its batch's worktree, else the project's) otherwise, and every part of the
 * answer is read at that one commit. A Ready pass page shows its kept commit instead: work kept at a
 * ref, which no branch carries, so it lists no commits.
 */
export async function workstreamChanges(
  deps: { readonly db: DbReader; readonly git: Git },
  id: WorkstreamId,
): Promise<WorkstreamChangesDto> {
  const row = getWorkstreamRow(deps.db, id);
  const kept = shownKeptWork(deps.db, row);
  if (kept) return readChanges(deps.git, checkoutOf(deps.db, row), id, kept.base, kept.head, false);
  if (row.baseHead === null)
    throw new ConflictError(`Workstream ${id} has not started work in a checkout yet`);
  // A worktree's path is cleared only once its batch has finished, so an unfinished batch without
  // one is a shared batch. A finished batch without a path may have been either, and the project's
  // checkout holds none of a worktree's work, so reading it would show someone else's changes.
  if (row.batchId !== null) {
    const batch = getBatch(deps.db, row.batchId);
    if (batch.worktreePath === null && !UNFINISHED_BATCH_STATES.includes(batch.state))
      throw new ConflictError(
        `The batch of workstream ${id} has finished, so its work is not shown`,
      );
  }
  const checkout = checkoutOf(deps.db, row);
  if (!existsSync(checkout)) throw new NotFoundError('checkout of workstream', id);
  const baseHead = row.baseHead;
  let head: string;
  try {
    head = checkedHead(deps.db, row) ?? (await deps.git.head(checkout));
  } catch (error) {
    if (error instanceof GitError)
      throw new ConflictError(`Workstream ${id}'s changes cannot be read: ${error.message}`);
    throw error;
  }
  return readChanges(deps.git, checkout, id, baseHead, head, true);
}

/** The changes from `baseHead` to `head` in the checkout, with the commits between when asked. */
async function readChanges(
  git: Git,
  checkout: string,
  id: WorkstreamId,
  baseHead: string,
  head: string,
  withCommits: boolean,
): Promise<WorkstreamChangesDto> {
  if (!existsSync(checkout)) throw new NotFoundError('checkout of workstream', id);
  try {
    const [commits, changes] = await Promise.all([
      withCommits ? git.commitsSince(checkout, baseHead, head) : Promise.resolve([]),
      git.diffSince(checkout, baseHead, head, MAX_CHANGES_DIFF_BYTES),
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
