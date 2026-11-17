import { getProject } from '@10db/db';
import type { ChatWorktrees } from '../chat';
import { chatWorktreeLosses } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';

/** A session's worktree as Archive reads and removes it: git's side of the chat service. */
export function createChatWorktrees(deps: {
  readonly state: StateStore;
  readonly git: Git;
}): ChatWorktrees {
  const { state, git } = deps;
  return {
    losses: (chat) =>
      chatWorktreeLosses(git, getProject(state.db, chat.projectId), chat.worktreePath ?? ''),
    remove: async (chat) => {
      if (chat.worktreePath === null) return;
      await git.removeWorktree(getProject(state.db, chat.projectId).repoPath, chat.worktreePath);
    },
  };
}
