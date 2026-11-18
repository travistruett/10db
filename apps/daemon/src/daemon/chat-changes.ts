import { ConflictError, WorkPlace, type ChatId, type WorkstreamChangesDto } from '@10db/contracts';
import { getChat, getProject } from '@10db/db';
import { chatRoot } from '../chat';
import { checkoutChanges } from '../delivery';
import type { StateStore } from '../events';
import { GitError, type Git } from '../git';

/** What a session's Changes reads of git. */
export type ChatChanges = (chatId: ChatId) => Promise<WorkstreamChangesDto>;

/**
 * What a session changed, in the shape a Board task's Changes has, read from the session's root: a branch
 * compares where its work began with its worktree (commits and what is still uncommitted); a session working
 * here compares `HEAD` with the folder, which is the work not yet committed. A branch with no worktree shows
 * its commits only, read from the branch. A session that has changed nothing, or is moving, has none to show.
 */
export function createChatChanges(deps: {
  readonly state: Pick<StateStore, 'db'>;
  readonly git: Pick<
    Git,
    'head' | 'branchTip' | 'changedPaths' | 'recordPaths' | 'commitsSince' | 'diffSince'
  >;
}): ChatChanges {
  return async (chatId) => {
    const chat = getChat(deps.state.db, chatId);
    const project = getProject(deps.state.db, chat.projectId);
    const { root } = chatRoot(chat, project);
    const { git } = deps;
    try {
      switch (chat.workPlace) {
        case null:
        case WorkPlace.Choosing:
          throw new ConflictError('This session has not changed any files yet.');
        case WorkPlace.Moving:
          throw new ConflictError('Wait for the move to finish.');
        case WorkPlace.Here: {
          const head = await git.head(root);
          return await checkoutChanges({
            git,
            checkout: root,
            base: head,
            head,
            uncommitted: true,
          });
        }
        case WorkPlace.Branch: {
          if (chat.baseHead === null || chat.branch === null)
            throw new ConflictError('This session has no branch to show yet.');
          if (chat.worktreePath !== null)
            return await checkoutChanges({
              git,
              checkout: root,
              base: chat.baseHead,
              head: await git.head(root),
              uncommitted: true,
            });
          const tip = await git.branchTip(root, chat.branch);
          if (tip === null) throw new ConflictError(`The branch ${chat.branch} is gone.`);
          return await checkoutChanges({
            git,
            checkout: root,
            base: chat.baseHead,
            head: tip,
            uncommitted: false,
          });
        }
      }
    } catch (error) {
      if (error instanceof GitError)
        throw new ConflictError(`This session's changes cannot be read: ${error.message}`);
      throw error;
    }
  };
}
