import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { BatchId, Delivery, NotFoundError, type BatchDto } from '@10db/contracts';
import { deleteAppSetting, getBatch, listProjects } from '@10db/db';
import type { StateStore } from '../events';
import {
  equalOrUnder,
  GitTrustError,
  lockedBatchId,
  samePath,
  surelyInside,
  WorktreeNotOursError,
  type Git,
  type WorktreeEntry,
} from '../git';
import { realPathOf } from '../guard';
import type { Logger } from '../log';
import { worktreePinKey } from './worktree-cleanup';

/** A path as the file system names it, or resolved as text once nothing is there. */
function comparable(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** True when `path` lies under `root`, not at it: by real path, or as text once the directory is gone. */
function underRoot(path: string, root: string): boolean {
  if (existsSync(path)) return surelyInside(path, root) && !samePath(realpathSync(path), root);
  try {
    const realRoot = realPathOf(root);
    const resolved = resolve(path);
    return equalOrUnder(resolved, realRoot) && !samePath(resolved, realRoot);
  } catch {
    return false;
  }
}

/** The batch with `id`, or undefined when no row has it. */
function findBatch(state: StateStore, id: BatchId): BatchDto | undefined {
  try {
    return getBatch(state.db, id);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/**
 * The batch id of a worktree the sweep removes: one under `root` locked `10db <batch id>` whose
 * batch is gone, or whose `worktree_path` is cleared or names another place. Null for anything else.
 */
function orphanOf(state: StateStore, entry: WorktreeEntry, root: string): BatchId | null {
  if (entry.bare) return null;
  // The lock reason is git's output: parse the id it names.
  const parsed = BatchId.safeParse(lockedBatchId(entry));
  if (!parsed.success || !underRoot(entry.path, root)) return null;
  const live = findBatch(state, parsed.data)?.worktreePath ?? null;
  if (live !== null && samePath(comparable(live), comparable(entry.path))) return null;
  return parsed.data;
}

/**
 * W12 at startup: in each pull_request project's main checkout, remove every worktree under `root`
 * (this daemon's hashed level) locked `10db <batch id>` whose batch is gone or whose `worktree_path`
 * is cleared or different, with its stored pin; then prune. An unmarked entry, another lock reason
 * and anything outside `root` are never touched. A project git won't trust is skipped (its card is
 * raised). Resolves with the paths removed.
 */
export async function sweepWorktrees(deps: {
  readonly state: StateStore;
  readonly git: Git;
  readonly root: string;
  readonly logger: Logger;
}): Promise<string[]> {
  const swept: string[] = [];
  for (const project of listProjects(deps.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    const main = project.repoPath;
    try {
      for (const entry of await deps.git.listWorktrees(main)) {
        const batchId = orphanOf(deps.state, entry, deps.root);
        if (batchId === null) continue;
        try {
          await deps.git.removeWorktree(main, entry.path);
        } catch (error) {
          if (!(error instanceof WorktreeNotOursError)) throw error;
          deps.logger.warn({ path: entry.path, err: error.message }, 'orphaned worktree kept');
          continue;
        }
        // The row that would key the pin may be gone, so the lock reason's id names it.
        deps.state.write((w) => {
          deleteAppSetting(w, worktreePinKey(batchId));
        });
        swept.push(entry.path);
        deps.logger.info(
          { projectId: project.id, batchId, path: entry.path },
          'orphaned worktree removed',
        );
      }
      await deps.git.pruneWorktrees(main);
    } catch (error) {
      if (!(error instanceof GitTrustError)) throw error;
      deps.logger.warn({ projectId: project.id, err: error.message }, 'worktree sweep skipped');
    }
  }
  return swept;
}
