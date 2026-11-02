import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { BatchId, Delivery, NotFoundError, type BatchDto, type ProjectDto } from '@10db/contracts';
import { deleteAppSetting, getBatch, listProjects } from '@10db/db';
import type { StateStore } from '../events';
import {
  comparablePath,
  equalOrUnder,
  existsAsEntry,
  lockedBatchId,
  samePath,
  surelyInside,
  type Git,
  type WorktreeEntry,
  worktreePinKey,
} from '../git';
import { realPathOf } from '../guard';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { looseWork } from './build-output';
import { keptWorktreeKey, worktreeCards } from './cards';
import { raise, withdraw } from './context';
import { dropOrphanStarts } from './start-refs';
import { unseededIgnoredFiles } from './worktree-cleanup';

export interface SweepDeps {
  readonly state: StateStore;
  readonly git: Git;
  readonly inbox: InboxService;
  /** This daemon's hashed level of the worktree root: the sweep never looks outside it. */
  readonly root: string;
  readonly logger: Logger;
}

/** A worktree the sweep may remove, and whether the pin stored under its batch id is its own. */
interface Orphan {
  readonly batchId: BatchId;
  /** False when the batch still names a worktree elsewhere: that pin is the live worktree's. */
  readonly ownsPin: boolean;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** True when `path` lies under `root`, not at it: by real path, or as text once the directory is gone. */
function underRoot(path: string, root: string): boolean {
  try {
    const realRoot = realPathOf(root);
    if (existsSync(path))
      return surelyInside(path, root) && !samePath(realpathSync(path), realRoot);
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
 * A worktree under `root` locked `10db <batch id>` whose batch is gone, or whose `worktree_path` is
 * cleared or names another place; null for anything else.
 */
function orphanOf(state: StateStore, entry: WorktreeEntry, root: string): Orphan | null {
  const verdict = orphanVerdict(state, entry, root);
  return 'why' in verdict ? null : verdict;
}

/** Why a worktree is not an orphan, in words the builder can read after "10db removed nothing: ". */
interface NotOrphan {
  readonly why: string;
}

function orphanVerdict(state: StateStore, entry: WorktreeEntry, root: string): Orphan | NotOrphan {
  if (entry.bare) return { why: 'it is a bare repository entry' };
  // The lock reason is git's output: parse the id it names.
  const parsed = BatchId.safeParse(lockedBatchId(entry));
  if (!parsed.success)
    return { why: '10db no longer has it locked (its lock reason does not name a batch)' };
  if (!underRoot(entry.path, root)) return { why: "it is outside 10db's worktree root" };
  const live = findBatch(state, parsed.data)?.worktreePath ?? null;
  if (live !== null && samePath(comparablePath(live), comparablePath(entry.path)))
    return { why: 'a batch uses it again' };
  return { batchId: parsed.data, ownsPin: live === null };
}

/**
 * The orphan's uncommitted changes; null when git can't read them, which counts as changed. A
 * directory that is gone has none.
 */
async function changesIn(deps: SweepDeps, main: string, path: string): Promise<string[] | null> {
  if (!existsAsEntry(path)) return [];
  try {
    return await deps.git.worktreeChanges(main, path);
  } catch (error) {
    deps.logger.warn({ path, err: message(error) }, 'orphaned worktree unreadable');
    return null;
  }
}

/**
 * The builder's Remove worktree answer on an orphan's card: removes the orphan at `path` whatever it
 * holds, uncommitted changes and git-ignored files included, and withdraws its cards. Only an orphan
 * the sweep itself would consider (locked by 10db, under the root, held by no batch); anything else
 * is left and answered with the reason (`why`), for the builder to read.
 */
export async function removeOrphanedWorktree(
  deps: SweepDeps,
  project: ProjectDto,
  path: string,
): Promise<{ readonly removed: true } | { readonly removed: false; readonly why: string }> {
  const main = project.repoPath;
  const entry = (await deps.git.listWorktrees(main)).find((e) =>
    samePath(comparablePath(e.path), comparablePath(path)),
  );
  if (entry === undefined) return { removed: false, why: 'git no longer lists it as a worktree' };
  const orphan = orphanVerdict(deps.state, entry, deps.root);
  if ('why' in orphan) return { removed: false, why: orphan.why };
  await deps.git.removeWorktree(main, entry.path);
  withdraw(deps.state, deps.inbox, project.id, [
    keptWorktreeKey.orphanChanges(path),
    keptWorktreeKey.orphanIgnored(path),
  ]);
  if (orphan.ownsPin)
    deps.state.write((w) => {
      deleteAppSetting(w, worktreePinKey(orphan.batchId));
    });
  deps.logger.info({ projectId: project.id, path }, 'orphaned worktree removed by the builder');
  return { removed: true };
}

/** Sweeps one project's main checkout; resolves with the paths removed. */
async function sweepProject(deps: SweepDeps, project: ProjectDto): Promise<string[]> {
  const main = project.repoPath;
  const swept: string[] = [];
  for (const entry of await deps.git.listWorktrees(main)) {
    const orphan = orphanOf(deps.state, entry, deps.root);
    if (orphan === null) continue;
    try {
      const changed = await changesIn(deps, main, entry.path);
      if (changed === null) {
        raise(deps.inbox, project.id, worktreeCards.orphanKept(main, entry.path, null, []));
        continue;
      }
      const ignored = await unseededIgnoredFiles(deps.git, main, entry.path, project.worktreeSeed);
      if (changed.length > 0 || ignored === null) {
        raise(
          deps.inbox,
          project.id,
          worktreeCards.orphanKept(
            main,
            entry.path,
            ignored === null ? null : changed,
            ignored ?? [],
          ),
        );
        continue;
      }
      const loose = looseWork(ignored);
      if (loose.length > 0) {
        raise(deps.inbox, project.id, worktreeCards.orphanIgnored(main, entry.path, loose));
        continue;
      }
      const outcome = await deps.git.removeWorktree(main, entry.path);
      withdraw(deps.state, deps.inbox, project.id, [
        keptWorktreeKey.orphanChanges(entry.path),
        keptWorktreeKey.orphanIgnored(entry.path),
      ]);
      // The row that would key the pin may be gone, so the lock reason's id names it.
      if (orphan.ownsPin)
        deps.state.write((w) => {
          deleteAppSetting(w, worktreePinKey(orphan.batchId));
        });
      if (outcome !== 'removed') continue;
      swept.push(entry.path);
      deps.logger.info(
        { projectId: project.id, batchId: orphan.batchId, path: entry.path },
        'orphaned worktree removed',
      );
    } catch (error) {
      deps.logger.warn({ path: entry.path, err: message(error) }, 'orphaned worktree kept');
    }
  }
  await dropOrphanStarts(
    { db: deps.state.db, git: deps.git, logger: deps.logger, worktreeRoot: deps.root },
    main,
  ).catch((error: unknown) => {
    deps.logger.warn({ projectId: project.id, err: message(error) }, 'task starts not swept');
  });
  await deps.git.pruneWorktrees(main);
  return swept;
}

/**
 * At startup, so no crash leaves a worktree behind for good: in each pull_request project's main
 * checkout, remove every worktree under `root` locked `10db <batch id>` whose batch is gone or
 * whose `worktree_path` is cleared or different, then prune. An orphan with uncommitted changes,
 * one git can't read, or one holding git-ignored files 10db didn't seed that are not build output
 * is kept and named on a card, which a later removal withdraws. It then drops the kept task starts no
 * live worktree batch holds. An unmarked entry, another lock reason and anything outside `root`
 * are never touched. A project or an entry git refuses is logged and skipped (a trust refusal
 * raises its own card), so startup goes on. Resolves with the paths removed.
 */
export async function sweepWorktrees(deps: SweepDeps): Promise<string[]> {
  const swept: string[] = [];
  for (const project of listProjects(deps.state.db)) {
    if (project.delivery !== Delivery.PullRequest || !existsSync(project.repoPath)) continue;
    try {
      swept.push(...(await sweepProject(deps, project)));
    } catch (error) {
      deps.logger.warn({ projectId: project.id, err: message(error) }, 'worktree sweep skipped');
    }
  }
  return swept;
}
