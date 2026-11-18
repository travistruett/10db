import type { ProjectDto } from '@10db/contracts';
import { Delivery } from '@10db/contracts';
import { githubRepoOf } from '../github';
import { PrState } from '../github';
import { ghCall, type DeliveryContext } from './context';

/** Whether a chat's branch, at `tip`, has landed in the project. A failure to find out throws. */
export type ChatMergedCheck = (
  project: ProjectDto,
  branch: string,
  tip: string,
) => Promise<boolean>;

/**
 * How the sweep knows a chat's branch is finished. On a pull request project the branch's pull request is
 * merged, which a squash merge satisfies although no commit of the branch is in main; on a local project the
 * branch's tip is in the base branch's history.
 */
export function chatBranchMerged(ctx: DeliveryContext, signal: AbortSignal): ChatMergedCheck {
  return async (project, branch, tip) => {
    if (project.delivery === Delivery.Local)
      return ctx.git.isAncestor(project.repoPath, tip, project.baseBranch);
    const repo = githubRepoOf(await ctx.git.pinnedPushUrl(project.repoPath));
    if (repo === null) return false;
    const pull = await ctx.gh.prView({ repo, ref: branch }, ghCall(ctx, signal));
    return pull?.state === PrState.Merged;
  };
}
