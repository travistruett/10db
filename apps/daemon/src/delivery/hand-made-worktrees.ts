import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Delivery, type ProjectDto, type ProjectId } from '@10db/contracts';
import {
  getInboxItem,
  hasAnsweredByFoldKey,
  listActiveProjects,
  listAnsweredByFoldKey,
  listOpenByFoldKeyPrefix,
  listOpenFlagRows,
  type DbReader,
} from '@10db/db';
import {
  handMadeWorktreeFolders,
  samePath,
  skippedBySpotlightByName,
  surelyInside,
  WorktreeNotOursError,
} from '../git';
import { githubRepoOf, PrState } from '../github';
import type { InboxService } from '../inbox';
import { looseWork } from './build-output';
import { detailOf, WorktreeChoice } from './cards';
import { haveCommit } from './branch-sweep';
import { ghCall, post, raise, withdraw, type DeliveryContext } from './context';
import {
  handMadeCards,
  handMadeKey,
  handMadeNotices,
  MERGED_KEY_PREFIX,
  mergedCardPaths,
  type MergedHandMade,
} from './hand-made-cards';
import { ghDown } from './pr-watch';

/** How long after a look the next one waits: each look asks GitHub about every worktree. */
const LOOK_EVERY_MS = 6 * 60 * 60_000;

/** Whether the daemon stopped; a function, so a check after an await is not read as the one before. */
const stopped = (signal: AbortSignal): boolean => signal.aborted;

/**
 * The folders of the project's hand-made worktrees that exist, the `.noindex` one first and the
 * older one while it drains.
 */
function foldersOf(project: ProjectDto): string[] {
  return handMadeWorktreeFolders(project.repoPath).filter((folder) => {
    try {
      return statSync(folder).isDirectory();
    } catch {
      return false;
    }
  });
}

/** The folders named as one, for a card's text and key. */
const labelOf = (folders: readonly string[]): string => folders.join(', ');

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
  const folders = foldersOf(project);
  if (folders.length === 0) return [];
  const repo = githubRepoOf(await ctx.git.pinnedPushUrl(main));
  if (repo === null) return [];
  const found: MergedHandMade[] = [];
  for (const entry of await ctx.git.listWorktrees(main)) {
    const { path, branch, head } = entry;
    if (entry.bare || entry.locked !== null || branch === null || head === null) continue;
    if (!existsSync(path)) continue;
    if (!folders.some((folder) => surelyInside(path, folder) && !samePath(path, folder))) continue;
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
 * telling the builder Spotlight indexes an older folder that holds worktrees. The builder's own answer is never taken for them.
 * A project with no folder gets nothing, and a card the builder answered Keep is not raised again
 * for the same worktrees. A gh that is down ends the look, and nothing else rejects.
 */
export async function offerHandMadeFolders(
  ctx: DeliveryContext,
  signal: AbortSignal,
): Promise<void> {
  closeGoneMergedWorktreeCards(ctx.state.db, ctx.inbox);
  for (const project of listActiveProjects(ctx.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    withdraw(
      ctx.state,
      ctx.inbox,
      project.id,
      handMadeWorktreeFolders(project.repoPath).map(handMadeKey.spotlightMarker),
    );
    const folders = foldersOf(project);
    if (folders.length === 0) continue;
    try {
      const listed = await ctx.git.listWorktrees(project.repoPath);
      for (const folder of folders.filter((f) => !skippedBySpotlightByName(f))) {
        const spotlight = handMadeKey.spotlight(folder);
        const holdsWorktrees = listed.some(
          (e) => existsSync(e.path) && surelyInside(e.path, folder) && !samePath(e.path, folder),
        );
        if (!holdsWorktrees) withdraw(ctx.state, ctx.inbox, project.id, [spotlight]);
        else if (!hasAnsweredByFoldKey(ctx.state.db, project.id, spotlight))
          raise(ctx.inbox, project.id, handMadeCards.spotlight(folder));
      }
      const merged = await mergedHandMadeWorktrees(ctx, project, signal);
      // A look the daemon's stop cut short found only part of the set.
      if (signal.aborted) return;
      withdrawOtherMergedCards(ctx, project.id);
      if (merged.length === 0) withdraw(ctx.state, ctx.inbox, project.id, [handMadeKey.merged]);
      else if (!allKept(ctx, project.id, merged))
        raise(ctx.inbox, project.id, handMadeCards.merged(mergedFolder(folders, merged), merged));
    } catch (error) {
      if (signal.aborted) return;
      if (ghDown(error)) throw error;
      ctx.logger.warn({ projectId: project.id, err: detailOf(error) }, 'hand-made folder not read');
    }
  }
}

/**
 * The folder a merged card names: the one folder its worktrees are in, else the directory the
 * hand-made folders share, so the title says one place however many folders hold them.
 */
function mergedFolder(folders: readonly string[], merged: readonly MergedHandMade[]): string {
  const holding = folders.filter((folder) => merged.some((w) => surelyInside(w.path, folder)));
  const [first] = holding.length > 0 ? holding : folders;
  if (first === undefined) return '';
  return holding.length > 1 ? dirname(first) : first;
}

/** Withdraws the project's open merged cards under another key: ones raised once per set of worktrees. */
function withdrawOtherMergedCards(ctx: DeliveryContext, projectId: ProjectId): void {
  const others = listOpenByFoldKeyPrefix(ctx.state.db, MERGED_KEY_PREFIX).filter(
    (card) => card.projectId === projectId && card.foldKey !== handMadeKey.merged,
  );
  withdraw(
    ctx.state,
    ctx.inbox,
    projectId,
    others.map((card) => card.foldKey),
  );
}

/** Whether the builder answered Keep on the worktrees `merged` lists, each on a card they kept. */
function allKept(
  ctx: DeliveryContext,
  projectId: ProjectId,
  merged: readonly MergedHandMade[],
): boolean {
  const kept = new Set(
    listAnsweredByFoldKey(ctx.state.db, projectId, handMadeKey.merged)
      .filter((card) => card.answer?.choice === WorktreeChoice.Keep)
      .flatMap((card) => mergedCardPaths(card) ?? []),
  );
  return merged.every((w) => kept.has(w.path));
}

/** The reason a merged-worktrees card closes by itself. */
const WORKTREES_GONE_REASON = 'The worktrees it named no longer exist.';

/**
 * Closes each open merged-worktrees card none of whose worktrees still exists on disk: its offer
 * has nothing left to remove. A card whose paths can't all be told stays. Returns how many closed.
 */
export function closeGoneMergedWorktreeCards(
  db: DbReader,
  inbox: Pick<InboxService, 'resolve'>,
): number {
  let closed = 0;
  for (const row of listOpenFlagRows(db)) {
    if (row.foldKey?.startsWith(MERGED_KEY_PREFIX) !== true) continue;
    const paths = mergedCardPaths(getInboxItem(db, row.id));
    if (paths === null || paths.some((path) => existsSync(path))) continue;
    inbox.resolve(row.id, WORKTREES_GONE_REASON);
    closed += 1;
  }
  return closed;
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
  const folders = foldersOf(project);
  if (folders.length === 0) return [];
  const folder = labelOf(folders);
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
