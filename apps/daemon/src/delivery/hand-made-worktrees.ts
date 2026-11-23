import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Delivery, type ProjectDto } from '@10db/contracts';
import { hasAnsweredByFoldKey, listActiveProjects } from '@10db/db';
import { handMadeWorktreeFolder, samePath, surelyInside, WorktreeNotOursError } from '../git';
import { githubRepoOf, PrState } from '../github';
import { keepSpotlightOut, SPOTLIGHT_MARKER } from '../sandbox';
import { looseWork } from './build-output';
import { detailOf } from './cards';
import { haveCommit } from './branch-sweep';
import { ghCall, post, raise, withdraw, type DeliveryContext } from './context';
import {
  handMadeCards,
  handMadeKey,
  handMadeNotices,
  type MergedHandMade,
} from './hand-made-cards';
import { ghDown } from './pr-watch';

/** How long after a look the next one waits: each look asks GitHub about every worktree. */
const LOOK_EVERY_MS = 6 * 60 * 60_000;

/** Whether the daemon stopped; a function, so a check after an await is not read as the one before. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

/** Whether `folder`'s Spotlight marker is there. */
const marked = (folder: string): boolean => existsSync(join(folder, SPOTLIGHT_MARKER));

/** The folder of the project's hand-made worktrees, or null when there is none. */
function folderOf(project: ProjectDto): string | null {
  const folder = handMadeWorktreeFolder(project.repoPath);
  try {
    return statSync(folder).isDirectory() ? folder : null;
  } catch {
    return null;
  }
}

/**
 * The worktrees in the project's hand-made folder that can go: git lists them there, they are
 * unlocked, their branch's pull request merged and the branch holds nothing it lacks, and they have
 * no uncommitted change and no git-ignored file that is not build output or inside an ignored
 * directory. A worktree git or gh can't be read for stays, and the next look tries again. A gh that
 * is down ends the look and throws.
 */
export async function mergedHandMadeWorktrees(
  ctx: DeliveryContext,
  project: ProjectDto,
  signal: AbortSignal,
): Promise<MergedHandMade[]> {
  const main = project.repoPath;
  const folder = folderOf(project);
  if (folder === null) return [];
  const repo = githubRepoOf(await ctx.git.pinnedPushUrl(main));
  if (repo === null) return [];
  const found: MergedHandMade[] = [];
  for (const entry of await ctx.git.listWorktrees(main)) {
    const { path, branch, head } = entry;
    if (entry.bare || entry.locked !== null || branch === null || head === null) continue;
    if (!existsSync(path) || !surelyInside(path, folder) || samePath(path, folder)) continue;
    if (signal.aborted) return found;
    try {
      const read = await ctx.gh.prStatus({ repo, ref: branch }, ghCall(ctx, signal));
      const pullHead = read?.state === PrState.Merged ? read.headSha : null;
      if (pullHead === null) continue;
      const carried =
        head === pullHead ||
        ((await haveCommit(ctx, main, pullHead, signal)) &&
          (await ctx.git.isAncestor(main, head, pullHead)));
      if (!carried) continue;
      if ((await ctx.git.handMadeWorktreeChanges(main, path)).length > 0) continue;
      if (looseWork(await ctx.git.handMadeWorktreeIgnoredFiles(main, path)).length > 0) continue;
      found.push({ path, branch });
    } catch (error) {
      if (stopped(signal) || ghDown(error)) throw error;
      ctx.logger.warn({ path, err: detailOf(error) }, 'hand-made worktree not read');
    }
  }
  return found;
}

/**
 * Raises the cards about each pull request project's hand-made worktree folder, and withdraws one
 * whose cause is gone: one offering to remove the worktrees whose pull request merged, and one
 * offering to keep Spotlight out of the folder. The builder's own answer is never taken for them.
 * A project with no folder gets nothing, and a card the builder answered Keep is not raised again
 * for the same worktrees. A gh that is down ends the look, and nothing else rejects.
 */
export async function offerHandMadeFolders(
  ctx: DeliveryContext,
  signal: AbortSignal,
): Promise<void> {
  for (const project of listActiveProjects(ctx.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    const folder = folderOf(project);
    if (folder === null) continue;
    try {
      const spotlight = handMadeKey.spotlight(folder);
      if (marked(folder)) withdraw(ctx.state, ctx.inbox, project.id, [spotlight]);
      else if (!hasAnsweredByFoldKey(ctx.state.db, project.id, spotlight))
        raise(ctx.inbox, project.id, handMadeCards.spotlight(folder));
      const merged = await mergedHandMadeWorktrees(ctx, project, signal);
      if (merged.length === 0) continue;
      const key = handMadeKey.merged(merged);
      if (!hasAnsweredByFoldKey(ctx.state.db, project.id, key))
        raise(ctx.inbox, project.id, handMadeCards.merged(folder, merged));
    } catch (error) {
      if (signal.aborted) return;
      if (ghDown(error)) throw error;
      ctx.logger.warn({ projectId: project.id, err: detailOf(error) }, 'hand-made folder not read');
    }
  }
}

/**
 * Looks at every project's hand-made folder now and then: at the first call, and after that at most
 * every six hours, so each pull request round that follows is cheap. A failed look is tried again
 * at the next call.
 */
export function createHandMadeFolderLook(
  ctx: DeliveryContext,
): (signal: AbortSignal) => Promise<void> {
  let lastAt = Number.NEGATIVE_INFINITY;
  return async (signal) => {
    const now = ctx.clock.now().getTime();
    if (now - lastAt < LOOK_EVERY_MS) return;
    await offerHandMadeFolders(ctx, signal);
    lastAt = now;
  };
}

/**
 * The builder's Remove Merged Worktrees answer: looks again and removes each worktree that still
 * qualifies, so one that changed since the offer stays. Raises one card saying what went. Resolves
 * with the paths removed.
 */
export async function removeMergedHandMade(
  ctx: DeliveryContext,
  project: ProjectDto,
  signal: AbortSignal,
): Promise<string[]> {
  const folder = folderOf(project);
  if (folder === null) return [];
  const merged = await mergedHandMadeWorktrees(ctx, project, signal);
  const removed: string[] = [];
  for (const { path } of merged) {
    try {
      if ((await ctx.git.removeHandMadeWorktree(project.repoPath, path)) === 'removed')
        removed.push(path);
    } catch (error) {
      if (!(error instanceof WorktreeNotOursError)) throw error;
      ctx.logger.warn({ path, err: detailOf(error) }, 'hand-made worktree not removed');
    }
  }
  ctx.logger.info({ projectId: project.id, folder, removed }, 'merged hand-made worktrees removed');
  post(ctx.inbox, project.id, handMadeNotices.removed(folder, removed));
  return removed;
}

/**
 * The builder's Keep Spotlight Out answer: creates the marker in the project's hand-made folder, and
 * only there, whatever `path` the card carried. Posts a notice saying what changed.
 */
export function keepHandMadeFolderOutOfSpotlight(ctx: DeliveryContext, project: ProjectDto): void {
  const folder = folderOf(project);
  if (folder === null) return;
  const before = marked(folder);
  keepSpotlightOut(folder);
  const created = !before && marked(folder);
  ctx.logger.info(
    { projectId: project.id, folder, created },
    'hand-made folder kept out of Spotlight',
  );
  post(ctx.inbox, project.id, handMadeNotices.spotlightKept(folder, created));
}
