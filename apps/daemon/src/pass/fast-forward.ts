import type { PassBranchMovedDetail, PassDto, PassId } from '@10db/contracts';
import { findOpenByFoldKey, getProject } from '@10db/db';
import { flagCard, withdrawCard } from '../inbox';
import { passBranch, type PassWorkDeps } from './kept-work';

// Workbench spec §5.4 (D8): at close the branch the folder came from fast-forwards to the pass's tip
// and the folder returns to it, so the signed-off work stays on screen. Each step checks first
// whether it is done, so a rerun after a crash changes nothing twice, and nothing is ever forced.

/** The fold key of the card that says the folder stays on the pass's branch. */
export const branchMovedKey = (passId: PassId): string => `pass-branch-moved:${passId}`;

/** What D8's fast-forward did. */
export type FastForward =
  | { readonly kind: 'returned' }
  /** The return branch is checked out, rebased or bisected elsewhere: nothing moved. */
  | { readonly kind: 'in_use'; readonly where: string }
  /** The return branch is no longer where the pass started, or HEAD moved: nothing was forced. */
  | { readonly kind: 'moved' };

function raiseBranchMoved(
  deps: PassWorkDeps,
  pass: PassDto,
  reason: PassBranchMovedDetail['reason'],
  where: string | null,
): void {
  const branch = passBranch(deps.state.db, pass);
  const detail: PassBranchMovedDetail = {
    kind: 'pass_branch_moved',
    passId: pass.id,
    returnBranch: pass.returnBranch,
    passBranch: branch,
    reason,
    mergeCommand: `git switch ${pass.returnBranch} && git merge ${branch}`,
  };
  const why =
    reason === 'in_use_elsewhere'
      ? `${pass.returnBranch} is in use in ${where ?? 'another worktree'}, and moving a branch another worktree sits on would leave its files behind.`
      : `${pass.returnBranch} moved since the pass opened, so 10db did not move it.`;
  deps.state.write((ctx) =>
    flagCard(ctx, {
      projectId: pass.projectId,
      workstreamId: null,
      title: `Your folder stays on ${branch}`,
      body: `Workbench pass "${pass.name}" closed. ${why} Your folder stays on ${branch}, which holds every signed-off page. To bring them into ${pass.returnBranch}, run \`${detail.mergeCommand}\`.`,
      foldKey: branchMovedKey(pass.id),
      refresh: true,
      detail,
    }),
  );
}

/** Withdraws the pass's card about the branch it could not move, if it is open. */
export function withdrawBranchMoved(deps: PassWorkDeps, pass: PassDto): void {
  deps.state.write((ctx) => {
    const card = findOpenByFoldKey(ctx.tx, pass.projectId, branchMovedKey(pass.id));
    if (card) withdrawCard(ctx, card.id);
  });
}

/**
 * D8 for a closing pass, under the repo lock of each git call: 1 a return branch in use in another
 * worktree stops it, with one card; 2 the return branch moves from the pass's start to its tip by
 * compare-and-swap (done when it is there), and one that moved meanwhile stops it, with one card
 * and the command that merges; 3 HEAD is pointed at the return branch, writing no file (done when it
 * names it); 4 the folder's own index is refreshed for the paths the pass landed. A stacked pass
 * starts where the pass below it ended, so its close moves the return branch on from that tip.
 */
export async function fastForwardReturn(deps: PassWorkDeps, pass: PassDto): Promise<FastForward> {
  const db = deps.state.db;
  const { git } = deps;
  const repo = getProject(db, pass.projectId).repoPath;
  const branch = passBranch(db, pass);
  const tip = await git.commitAt(repo, branch);
  const on = await git.currentBranch(repo);
  // HEAD on the return branch away from the tip is the builder's own switch: never forced.
  if (on === pass.returnBranch && (await git.commitAt(repo, pass.returnBranch)) !== tip) {
    raiseBranchMoved(deps, pass, 'moved', null);
    return { kind: 'moved' };
  }
  if (on !== pass.returnBranch) {
    const where = await git.branchInUse(repo, pass.returnBranch);
    if (where !== null) {
      raiseBranchMoved(deps, pass, 'in_use_elsewhere', where);
      return { kind: 'in_use', where };
    }
    if (
      (await git.moveBranchCas({
        repo,
        branch: pass.returnBranch,
        to: tip,
        expect: pass.startSha,
      })) === 'raced' ||
      !(await git.pointHeadAt({ repo, from: branch, to: pass.returnBranch, sha: tip }))
    ) {
      raiseBranchMoved(deps, pass, 'moved', null);
      return { kind: 'moved' };
    }
  }
  await git.refreshIndex(repo, await git.filesChangedBetween(repo, pass.startSha, tip));
  withdrawBranchMoved(deps, pass);
  return { kind: 'returned' };
}
