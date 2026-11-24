import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BatchId,
  ChatId,
  Delivery,
  NotFoundError,
  WorkPlace,
  type BatchDto,
  type ProjectDto,
} from '@10db/contracts';
import {
  deleteAppSetting,
  getBatch,
  getChat,
  listActiveProjects,
  setChatWork,
  type ChatRow,
} from '@10db/db';
import type { StateStore } from '../events';
import {
  comparablePath,
  equalOrUnder,
  existsAsEntry,
  lockedOwner,
  samePath,
  surelyInside,
  chatWorktreePinKey,
  type Git,
  type WorktreeEntry,
  worktreePinKey,
} from '../git';
import { realPathOf } from '../guard';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { COPY_REFS_PREFIX, batchOfTeardownRef } from './copy-teardown-ref';
import { looseWork } from './build-output';
import { keptWorktreeKey, worktreeCards } from './cards';
import type { ChatMergedCheck } from './chat-worktree-merged';
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
  /** Whether a closed chat's branch has landed; absent, a closed chat's worktree is never removed as merged. */
  readonly merged?: ChatMergedCheck;
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
  // The lock reason is git's output: the owner it names must be a batch.
  const owner = lockedOwner(entry);
  const parsed = BatchId.safeParse(owner?.kind === 'batch' ? owner.id : null);
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

/** The chat with `id`, or undefined when no row has it. */
function findChat(state: StateStore, id: ChatId): ChatRow | undefined {
  try {
    return getChat(state.db, id);
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/**
 * Whether a chat's worktree is finished: its chat is gone, archived, or no longer names it; or the chat is
 * closed and its branch needs checking for commits of its own that have landed. A chat that is moving, or open,
 * keeps its worktree.
 */
type ChatVerdict =
  | { readonly remove: true; readonly id: ChatId; readonly chat: ChatRow | undefined }
  | { readonly check: true; readonly id: ChatId; readonly chat: ChatRow }
  | { readonly keep: string };

function chatOrphanVerdict(state: StateStore, entry: WorktreeEntry, root: string): ChatVerdict {
  if (entry.bare) return { keep: 'it is a bare repository entry' };
  const owner = lockedOwner(entry);
  const id = ChatId.safeParse(owner?.kind === 'chat' ? owner.id : null);
  if (!id.success) return { keep: 'its lock reason does not name a chat' };
  if (!underRoot(entry.path, root)) return { keep: "it is outside 10db's worktree root" };
  const chat = findChat(state, id.data);
  if (chat === undefined) return { remove: true, id: id.data, chat };
  if (chat.workPlace === WorkPlace.Moving) return { keep: 'its session is moving' };
  if (
    chat.worktreePath === null ||
    !samePath(comparablePath(chat.worktreePath), comparablePath(entry.path))
  )
    return { remove: true, id: id.data, chat };
  if (chat.archivedAt !== null) return { remove: true, id: id.data, chat };
  if (chat.tabPosition !== null) return { keep: 'its session is open' };
  return { check: true, id: id.data, chat };
}

/** A closed chat's worktree is finished when its tip holds commits of its own and its branch has landed. */
async function chatFinished(
  deps: SweepDeps,
  project: ProjectDto,
  entry: WorktreeEntry,
  chat: ChatRow,
): Promise<boolean> {
  if (deps.merged === undefined || chat.branch === null) return false;
  if (entry.head === null || entry.head === chat.baseHead) return false;
  try {
    return await deps.merged(project, chat.branch, entry.head);
  } catch (error) {
    // GitHub or git could not say, so nothing is assumed merged.
    deps.logger.warn({ path: entry.path, err: message(error) }, 'chat worktree merge unknown');
    return false;
  }
}

/** Sweeps one chat's worktree entry; true when it was removed. */
async function sweepChatEntry(
  deps: SweepDeps,
  project: ProjectDto,
  entry: WorktreeEntry,
): Promise<boolean> {
  const main = project.repoPath;
  const verdict = chatOrphanVerdict(deps.state, entry, deps.root);
  if ('keep' in verdict) return false;
  if ('check' in verdict && !(await chatFinished(deps, project, entry, verdict.chat))) return false;
  const changed = await changesIn(deps, main, entry.path);
  if (changed === null) {
    raise(deps.inbox, project.id, worktreeCards.orphanKept(main, entry.path, null, []));
    return false;
  }
  const ignored = await unseededIgnoredFiles(deps.git, main, entry.path, project.worktreeSeed);
  if (changed.length > 0 || ignored === null) {
    raise(
      deps.inbox,
      project.id,
      worktreeCards.orphanKept(main, entry.path, ignored === null ? null : changed, ignored ?? []),
    );
    return false;
  }
  const loose = looseWork(ignored);
  if (loose.length > 0) {
    raise(deps.inbox, project.id, worktreeCards.orphanIgnored(main, entry.path, loose));
    return false;
  }
  const outcome = await deps.git.removeWorktree(main, entry.path);
  withdraw(deps.state, deps.inbox, project.id, [
    keptWorktreeKey.orphanChanges(entry.path),
    keptWorktreeKey.orphanIgnored(entry.path),
  ]);
  if (outcome !== 'removed') return false;
  // The pin and the row's path go together, so a restart never finds one without the other. They are the chat's
  // only when this entry is the worktree the row names (or the chat is gone or archived): a stale entry of a chat
  // that lives elsewhere leaves them alone.
  const row = verdict.chat;
  const ownsPin = ((): boolean => {
    // Gone, or archived: undefined and a set time both differ from null.
    if (row?.archivedAt !== null) return true;
    return (
      row.worktreePath !== null &&
      samePath(comparablePath(row.worktreePath), comparablePath(entry.path))
    );
  })();
  if (ownsPin)
    deps.state.write((w) => {
      deleteAppSetting(w, chatWorktreePinKey(verdict.id));
      if (row !== undefined && row.workPlace !== null)
        setChatWork(w, verdict.id, row.workPlace, { place: row.workPlace, worktreePath: null });
    });
  deps.logger.info({ chatId: verdict.id, path: entry.path }, 'chat worktree removed');
  return true;
}

/** Deletes the teardown refs of local copies whose batch is gone (a cut that never opened, a start deleted). */
async function dropOrphanedTeardownRefs(deps: SweepDeps, project: ProjectDto): Promise<void> {
  try {
    for (const ref of await deps.git.keptRefs(project.repoPath, COPY_REFS_PREFIX)) {
      const batchId = batchOfTeardownRef(ref);
      if (batchId !== null && findBatch(deps.state, batchId) === undefined)
        await deps.git.deleteKeptRef(project.repoPath, ref);
    }
  } catch (error) {
    deps.logger.warn({ projectId: project.id, err: message(error) }, 'copy refs not swept');
  }
}

/** Sweeps one project's main checkout; resolves with the paths removed. */
async function sweepProject(deps: SweepDeps, project: ProjectDto): Promise<string[]> {
  const main = project.repoPath;
  const swept: string[] = [];
  // A local project has batch worktrees only while it allows separate copies, and a chat's always.
  const batches = project.delivery === Delivery.PullRequest || project.localCopies;
  for (const entry of await deps.git.listWorktrees(main)) {
    if (lockedOwner(entry)?.kind === 'chat') {
      try {
        if (await sweepChatEntry(deps, project, entry)) swept.push(entry.path);
      } catch (error) {
        deps.logger.warn({ path: entry.path, err: message(error) }, 'chat worktree kept');
      }
      continue;
    }
    if (!batches) continue;
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
  if (batches)
    await dropOrphanStarts(
      { db: deps.state.db, git: deps.git, logger: deps.logger, worktreeRoot: deps.root },
      main,
    ).catch((error: unknown) => {
      deps.logger.warn({ projectId: project.id, err: message(error) }, 'task starts not swept');
    });
  if (batches) await dropOrphanedTeardownRefs(deps, project);
  await deps.git.pruneWorktrees(main);
  return swept;
}

/**
 * At startup, so no crash leaves a worktree behind for good: in each pull_request project's main
 * checkout (a local project's too, for a chat's worktree only), remove every worktree under `root` locked `10db <batch id>` whose batch is gone or
 * whose `worktree_path` is cleared or different, then prune. An orphan with uncommitted changes,
 * one git can't read, or one holding git-ignored files 10db didn't seed that are not build output
 * is kept and named on a card, which a later removal withdraws. It then drops the kept task starts no
 * live worktree batch holds. An unmarked entry, another lock reason and anything outside `root`
 * are never touched. A project or an entry git refuses is logged and skipped (a trust refusal
 * raises its own card), so startup goes on. Resolves with the paths removed.
 */
export async function sweepWorktrees(deps: SweepDeps): Promise<string[]> {
  const swept: string[] = [];
  for (const project of listActiveProjects(deps.state.db)) {
    if (!existsSync(project.repoPath)) continue;
    try {
      swept.push(...(await sweepProject(deps, project)));
    } catch (error) {
      deps.logger.warn({ projectId: project.id, err: message(error) }, 'worktree sweep skipped');
    }
  }
  return swept;
}
