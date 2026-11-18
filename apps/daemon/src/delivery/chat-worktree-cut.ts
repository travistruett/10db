import type { ProjectDto } from '@10db/contracts';
import type { ChatRow } from '@10db/db';
import { existsAsEntry, lockedOwner, WORKTREE_LOCK_PREFIX } from '../git';
import type { DeliveryContext } from './context';
import { seedAndInstall } from './worktree-prepare';

/** A session's worktree could not be made; the message is the bar's words. */
export class ChatWorktreeError extends Error {
  override readonly name = 'ChatWorktreeError';
}

/** The lock reason on a session's worktree: the marker the startup sweep looks for. */
export const chatWorktreeLockReason = (chat: Pick<ChatRow, 'id'>): string =>
  `${WORKTREE_LOCK_PREFIX}${chat.id}`;

const wordsOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Cuts a session's worktree at the path and on the branch its row already names. A move cuts a new branch at the
 * checkout's `HEAD` (uncommitted files stay where they are); a reopen, whose row keeps its `base_head`, cuts the
 * worktree from the branch as it is. Then the seed and install, as a lane's cut does.
 *
 * Every failure removes what this call made (the worktree, and the branch unless it existed before) and throws a
 * `ChatWorktreeError` in the bar's words. It is idempotent by path: a worktree already locked by this session
 * skips the cut and runs the seed and install again, which is what a restart mid-move finishes. A stopped
 * signal leaves everything for that restart and answers null.
 */
export async function cutChatWorktree(
  ctx: Pick<DeliveryContext, 'state' | 'git' | 'logger' | 'dependencies'>,
  chat: ChatRow,
  project: ProjectDto,
  signal: AbortSignal,
): Promise<{ readonly baseHead: string } | null> {
  const { worktreePath: path, branch } = chat;
  if (path === null || branch === null)
    throw new ChatWorktreeError('This session has no branch or folder to cut.');
  const main = project.repoPath;
  // A reopen's branch is the builder's from before, and survives an undone cut.
  const reopened = chat.baseHead !== null;
  const entries = await ctx.git.listWorktrees(main);
  const ours = entries.find(
    (entry) =>
      entry.path === path &&
      lockedOwner(entry)?.kind === 'chat' &&
      lockedOwner(entry)?.id === chat.id,
  );
  let madeWorktree = false;
  /** Where the branch this cut made is, so an undo deletes it only while it is still there. */
  let madeAt: string | null = null;
  let baseHead: string | null;
  const undo = async (): Promise<void> => {
    if (madeWorktree || ours !== undefined)
      await ctx.git.removeWorktree(main, path).catch((error: unknown) => {
        ctx.logger.warn(
          { chatId: chat.id, path, err: wordsOf(error) },
          'could not undo a session worktree',
        );
      });
    if (madeAt !== null) await ctx.git.deleteBranchIfAt(main, branch, madeAt).catch(() => false);
  };
  try {
    if (ours === undefined) {
      const head = await ctx.git.commitAt(main, 'HEAD');
      const filters = await ctx.git.filtersIn(main, reopened ? branch : head);
      if (filters.length > 0)
        throw new ChatWorktreeError(
          `10db commits and pushes files exactly as they are and never runs a filter, so it can't start a branch where the repository's attributes ask for one (Git LFS is the usual one): ${filters.map((f) => `${f.path} (${f.filter})`).join(', ')}.`,
        );
      if (existsAsEntry(path))
        throw new ChatWorktreeError(
          `${path} already exists, so the branch can't be started there.`,
        );
      if (signal.aborted) return null;
      let cutAt: string;
      try {
        cutAt = await ctx.git.addWorktree({
          repo: main,
          path,
          branch,
          startPoint: reopened ? null : head,
          lockReason: chatWorktreeLockReason(chat),
        });
      } catch (error) {
        // addWorktree leaves nothing behind when it throws.
        throw new ChatWorktreeError(wordsOf(error));
      }
      madeWorktree = true;
      if (!reopened) madeAt = cutAt;
      // A reopen keeps the base it was first cut from.
      baseHead = chat.baseHead ?? cutAt;
    } else {
      // A worktree an earlier run made: the branch it cut is this move's, unless the row is a reopen's.
      if (!reopened) madeAt = ours.head;
      baseHead = chat.baseHead ?? ours.head;
    }
    if (baseHead === null) throw new ChatWorktreeError('The new worktree has no commit.');
    const prepared = await seedAndInstall(ctx, {
      owner: { kind: 'chat', id: chat.id },
      project,
      main,
      path,
      signal,
    });
    if ('failed' in prepared)
      throw new ChatWorktreeError(
        `Copying the project's installed folders failed: ${wordsOf(prepared.error)}`,
      );
    switch (prepared.installed.kind) {
      case 'aborted':
        return null;
      case 'failed':
        throw new ChatWorktreeError(
          `Installing the packages failed (exit ${String(prepared.installed.exitCode)}). Its log is ${prepared.installed.logPath}.`,
        );
      case 'installed':
      case 'skipped':
        break;
    }
    if (signal.aborted) return null;
    ctx.logger.info({ chatId: chat.id, branch, path, baseHead }, 'session worktree cut');
    return { baseHead };
  } catch (error) {
    await undo();
    throw error instanceof ChatWorktreeError ? error : new ChatWorktreeError(wordsOf(error));
  }
}
