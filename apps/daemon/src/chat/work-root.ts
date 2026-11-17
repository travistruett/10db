import { WorkPlace } from '@10db/contracts';

/** What a session's root reads of its row. */
export interface ChatRootFacts {
  readonly workPlace: WorkPlace | null;
  readonly worktreePath: string | null;
}

/**
 * The folder a session works in, and the only place in `chat/` that picks one: the builder's checkout while it
 * reads, chooses, moves or works here; its worktree on a branch. A branch with no worktree (archived, swept or
 * not remade) reads the checkout, and `writes` says it may not change anything there.
 */
export function chatRoot(
  chat: ChatRootFacts,
  project: { readonly repoPath: string },
): { readonly root: string; readonly writes: boolean } {
  if (chat.workPlace === WorkPlace.Branch) {
    if (chat.worktreePath !== null) return { root: chat.worktreePath, writes: true };
    return { root: project.repoPath, writes: false };
  }
  return { root: project.repoPath, writes: chat.workPlace === WorkPlace.Here };
}
