import { existsSync } from 'node:fs';
import {
  ChangesScope,
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
  getTask,
  getWorkstreamRow,
  listPassTurns,
  passHoldingTask,
  openItemsForWorkstream,
  type DbReader,
  type WorkstreamRow,
} from '@10db/db';
import { z } from 'zod';
import { GitError, type Git } from '../git';
import { checkoutOf } from './checkout';
import { diffOfRanges, runCommits } from './run-commits';

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
 * What a page of a pass shows for `scope`: every turn kept, from where the pass began to the latest kept commit,
 * or only the latest turn, from the commit kept before it. Null for a task no pass holds, whose work is the
 * same either way. A turn still working has kept nothing yet, so it is not shown.
 */
function keptTurnsRange(
  db: DbReader,
  row: WorkstreamRow,
  scope: ChangesScope,
): { base: string; head: string } | null {
  const pass = passHoldingTask(db, getTask(db, row.taskId));
  if (pass === undefined) return null;
  const kept = listPassTurns(db, pass.id).filter(
    (t) => t.taskId === row.taskId && t.ending !== null && t.keptSha !== null,
  );
  const latest = kept.at(-1);
  if (latest?.keptSha == null)
    throw new ConflictError('No turn of this page has been kept yet, so there is nothing to show');
  if (scope === ChangesScope.All) return { base: pass.startSha, head: latest.keptSha };
  return {
    base: kept.at(-2)?.keptSha ?? latest.keptBaseSha ?? pass.startSha,
    head: latest.keptSha,
  };
}

/**
 * What a workstream changed: the diff its own commits make from the head it started at to its head,
 * for the builder to check (`runCommits`: in the builder's own checkout, not the builder's commits).
 * The head is read once, from the check card the builder is looking at when there is one and from
 * its checkout (its batch's worktree, else the project's) otherwise, and every part of the answer is
 * read at that one commit. A Ready pass page shows its kept commit instead: work kept at a
 * ref, which no branch carries, so it lists no commits.
 */
export async function workstreamChanges(
  deps: { readonly db: DbReader; readonly git: Git },
  id: WorkstreamId,
  scope?: ChangesScope,
): Promise<WorkstreamChangesDto> {
  const row = getWorkstreamRow(deps.db, id);
  if (scope !== undefined) {
    const turns = keptTurnsRange(deps.db, row, scope);
    if (turns) return readChanges(deps.git, checkoutOf(deps.db, row), id, turns.base, turns.head);
  }
  const kept = shownKeptWork(deps.db, row);
  if (kept) return readChanges(deps.git, checkoutOf(deps.db, row), id, kept.base, kept.head);
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
  try {
    const run = await runCommits(deps, row, checkout, baseHead, head);
    const changes = await diffOfRanges(deps.git, checkout, run.ranges, MAX_CHANGES_DIFF_BYTES);
    return {
      baseHead,
      head,
      commits: [...run.commits],
      diff: changes.diff,
      truncated: changes.truncated,
      files: [...changes.files],
    };
  } catch (error) {
    if (error instanceof GitError)
      throw new ConflictError(`Workstream ${id}'s changes cannot be read: ${error.message}`);
    throw error;
  }
}

/**
 * What changed in a checkout from commit `base` to `head`, with the commits between when asked. With `uncommitted`,
 * what the folder holds beyond `head` is part of it: read as a commit made at `head` that no ref names, so
 * nothing in the checkout, its index or its branches is written. A git failure is thrown as a `GitError`.
 */
export async function checkoutChanges(input: {
  readonly git: Pick<Git, 'changedPaths' | 'recordPaths' | 'commitsSince' | 'diffSince'>;
  readonly checkout: string;
  readonly base: string;
  readonly head: string;
  readonly uncommitted: boolean;
  readonly withCommits?: boolean;
}): Promise<WorkstreamChangesDto> {
  const { git, checkout, base, head } = input;
  const paths = input.uncommitted ? await git.changedPaths(checkout) : [];
  const shown =
    paths.length === 0 ? head : (await git.recordPaths({ repo: checkout, base: head, paths })).sha;
  const [commits, changes] = await Promise.all([
    input.withCommits === false ? Promise.resolve([]) : git.commitsSince(checkout, base, head),
    git.diffSince(checkout, base, shown, MAX_CHANGES_DIFF_BYTES),
  ]);
  return {
    baseHead: base,
    head,
    commits,
    diff: changes.diff,
    truncated: changes.truncated,
    files: [...changes.files],
  };
}

/** The changes from `baseHead` to `head` in a workstream's checkout, listing no commits. */
async function readChanges(
  git: Git,
  checkout: string,
  id: WorkstreamId,
  baseHead: string,
  head: string,
): Promise<WorkstreamChangesDto> {
  if (!existsSync(checkout)) throw new NotFoundError('checkout of workstream', id);
  try {
    return await checkoutChanges({
      git,
      checkout,
      base: baseHead,
      head,
      uncommitted: false,
      withCommits: false,
    });
  } catch (error) {
    // A base the checkout no longer holds, or a checkout with no commit yet, cannot be shown.
    if (error instanceof GitError)
      throw new ConflictError(`Workstream ${id}'s changes cannot be read: ${error.message}`);
    throw error;
  }
}
