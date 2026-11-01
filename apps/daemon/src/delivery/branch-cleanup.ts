import { BRANCH_PREFIX, BatchState, type BatchId } from '@10db/contracts';
import { getBatch, getProject } from '@10db/db';
import type { Git } from '../git';
import { branchCards } from './cards';
import { raise, type DeliveryContext } from './context';

/** What `removeBranch` did. */
export type BranchRemoval =
  | { readonly kind: 'removed' }
  /** There is no such local branch. */
  | { readonly kind: 'absent' }
  /** Not a branch 10db makes: its name does not start with `10db/`. */
  | { readonly kind: 'foreign' }
  /**
   * Checked out, or being rebased or bisected, in the main checkout or a worktree at `path`, where
   * git won't let it go.
   */
  | { readonly kind: 'checked_out'; readonly path: string }
  /** `mayRemove` said no, or the branch moved while it was being removed. */
  | { readonly kind: 'kept' };

/**
 * Deletes local branch `branch` of `repo`, the only way 10db deletes one. It refuses a name that is
 * not 10db's and a branch in use anywhere (checked out, rebased or bisected in the main checkout or
 * any worktree), and asks `mayRemove` about the tip it read; the delete then names that tip, so a
 * branch that moves in between is left. What 10db's push left goes with it: the remote-tracking ref
 * `origin/<branch>`, when `mayRemove` allows its tip too, and the branch's config section.
 */
export async function removeBranch(
  git: Git,
  repo: string,
  branch: string,
  mayRemove: (tip: string) => Promise<boolean>,
): Promise<BranchRemoval> {
  if (!branch.startsWith(BRANCH_PREFIX)) return { kind: 'foreign' };
  const tip = await git.branchTip(repo, branch);
  if (tip === null) return { kind: 'absent' };
  const holder = await git.branchInUse(repo, branch);
  if (holder !== null) return { kind: 'checked_out', path: holder };
  if (!(await mayRemove(tip))) return { kind: 'kept' };
  const tracking = await git.trackingTip(repo, branch);
  const withTracking = tracking !== null && (tracking === tip || (await mayRemove(tracking)));
  return (await git.deleteBranchIfAt(repo, branch, tip, withTracking ? tracking : null))
    ? { kind: 'removed' }
    : { kind: 'kept' };
}

/**
 * After a batch is CLOSED or ABANDONED and nothing runs in its branch's worktree: deletes the
 * branch while it is still at the commit it was cut from. An abandoned batch whose branch holds
 * commits keeps it and raises one card offering to delete it. A closed batch's branch that moved is
 * kept without a card. Safe to repeat; a card is raised again only while the branch still holds the
 * commits and no card for it is open, so answer Keep before the batch is retired again.
 */
export async function settleBranch(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const batch = getBatch(ctx.state.db, batchId);
  const base = batch.baseSha;
  if (batch.branch === null || base === null) return;
  // A CI fix batch's branch is its pull request's, which the batch it fixes owns.
  if (batch.ciFixOf !== null) return;
  if (batch.state !== BatchState.Closed && batch.state !== BatchState.Abandoned) return;
  const repo = getProject(ctx.state.db, batch.projectId).repoPath;
  const removal = await removeBranch(ctx.git, repo, batch.branch, (tip) =>
    Promise.resolve(tip === base),
  );
  if (batch.state !== BatchState.Abandoned) return;
  if (removal.kind !== 'kept' && removal.kind !== 'checked_out') return;
  const commits = (await ctx.git.commitsSince(repo, base, batch.branch)).length;
  if (commits > 0) raise(ctx.inbox, batch.projectId, branchCards.abandoned(batch, commits));
}

/**
 * Carries out the builder's Delete Branch answer: removes the batch's branch whatever it holds. A
 * branch that is checked out stays, and a new card says where.
 */
export async function deleteAskedBranch(ctx: DeliveryContext, batchId: BatchId): Promise<void> {
  const batch = getBatch(ctx.state.db, batchId);
  if (batch.branch === null) return;
  const repo = getProject(ctx.state.db, batch.projectId).repoPath;
  const removal = await removeBranch(ctx.git, repo, batch.branch, () => Promise.resolve(true));
  switch (removal.kind) {
    case 'checked_out':
      raise(ctx.inbox, batch.projectId, branchCards.checkedOut(batch, removal.path));
      return;
    case 'removed':
    case 'absent':
      ctx.logger.info({ batchId, branch: batch.branch, removal: removal.kind }, 'branch deleted');
      return;
    case 'foreign':
    case 'kept':
      ctx.logger.warn({ batchId, branch: batch.branch, removal: removal.kind }, 'branch kept');
      return;
  }
}
