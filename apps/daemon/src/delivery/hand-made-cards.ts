import { createHash } from 'node:crypto';
import { SPOTLIGHT_MARKER } from '../sandbox';
import { detailOf, listPaths, worktreeOffer, type Card } from './cards';

/** A worktree in the hand-made folder whose pull request merged and which holds nothing unsaved. */
export interface MergedHandMade {
  readonly path: string;
  readonly branch: string;
}

/**
 * The fold keys of the hand-made folder's cards. The merged card's key names the set it lists, so
 * Keep holds for that set and a newly merged worktree is offered on its own.
 */
export const handMadeKey = {
  merged: (worktrees: readonly MergedHandMade[]): string =>
    `hand-made-merged:${createHash('sha256')
      .update(
        worktrees
          .map((w) => w.path)
          .sort()
          .join('\n'),
      )
      .digest('hex')
      .slice(0, 16)}`,
  spotlight: (folder: string): string => `hand-made-spotlight:${folder}`,
  spotlightDone: (folder: string): string => `hand-made-spotlight-done:${folder}`,
} as const;

export const handMadeCards = {
  merged: (folder: string, worktrees: readonly MergedHandMade[]): Card => ({
    title: `${String(worktrees.length)} worktree${worktrees.length === 1 ? '' : 's'} in ${folder} ${worktrees.length === 1 ? 'has' : 'have'} merged`,
    body: `Each pull request below merged, the branch holds nothing the pull request lacks, and the worktree has no uncommitted changes or loose files. Every one keeps a copy of node_modules and build output that the editor, Spotlight and the file watcher keep reading, which adds to the load.\n\n${listPaths(worktrees.map((w) => `${w.path} (${w.branch})`))}\n\nRemove Merged Worktrees removes them; the branches stay.`,
    foldKey: handMadeKey.merged(worktrees),
    ...worktreeOffer({ kind: 'merged-hand-made' }),
  }),
  /** What the removal did, for the builder to read. */
  removed: (folder: string, removed: readonly string[]): Card => ({
    title: `Removed ${String(removed.length)} merged worktree${removed.length === 1 ? '' : 's'} from ${folder}`,
    body:
      removed.length === 0
        ? 'Nothing was removed: each worktree changed since the offer (a new change, a lock, or a pull request no longer merged).'
        : `Removed:\n${listPaths(removed)}\n\nThe branches are still in your repository. Any worktree that changed since the offer was left.`,
    foldKey: `hand-made-removed:${folder}`,
    refresh: true,
  }),
  spotlight: (folder: string): Card => ({
    title: `Spotlight indexes ${folder}`,
    body: `${folder} holds your hand-made worktrees, each with its own node_modules and build output. Spotlight (mds_stores and mdworker) indexes every file there, and installs and test runs keep it busy.\n\nKeep Spotlight Out creates one empty file, ${folder}/${SPOTLIGHT_MARKER}, which tells Spotlight to skip the folder and everything under it. It changes nothing else, and deleting that file lets Spotlight index the folder again. Files there stop showing in Spotlight search.`,
    foldKey: handMadeKey.spotlight(folder),
    ...worktreeOffer({ kind: 'spotlight', path: folder }),
  }),
  /** A Remove Merged Worktrees answer that failed: the same offer again. */
  removeFailed: (error: unknown): Card => ({
    title: 'Merged worktrees were not removed',
    body: `${detailOf(error)}\n\nWhat was removed before the failure is gone. 10db does not offer the same worktrees again; remove the rest yourself with git worktree remove.`,
    foldKey: 'hand-made-remove-failed',
    refresh: true,
  }),
  /** What the Keep Spotlight Out answer changed. */
  spotlightKept: (folder: string, created: boolean): Card => ({
    title: created
      ? `Spotlight now skips ${folder}`
      : `Spotlight already skipped ${folder}, or the file could not be written`,
    body: created
      ? `10db created ${folder}/${SPOTLIGHT_MARKER}, an empty file, and changed nothing else. Spotlight skips the folder and everything under it. Delete that file to let Spotlight index the folder again.`
      : `10db found ${SPOTLIGHT_MARKER} in ${folder} already, or could not write it there, and changed nothing. Create the empty file ${folder}/${SPOTLIGHT_MARKER} yourself if Spotlight still indexes it.`,
    foldKey: handMadeKey.spotlightDone(folder),
    refresh: true,
  }),
};
