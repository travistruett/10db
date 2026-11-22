import {
  ConflictError,
  ConversationOwnerKind,
  type ConversationId,
  type ProjectFileMatchDto,
} from '@10db/contracts';
import { chatOfConversation, getConversation, getProject } from '@10db/db';
import type { StateStore } from '../events';
import { rankFiles } from './file-rank';
import { chatRoot } from './work-root';

// Sessions spec §10, §11: `@` lists the files git tracks in the checkout the daemon resolves from the
// conversation; the client never names a folder. A chat's checkout is its project's; a task's comes
// with Do It.

/** How long a checkout's tracked files are reused before git is asked again. */
const TRACKED_FILES_TTL_MS = 30_000;

const REPORTER_FILES = "A reporter's conversation takes no files.";
export const TASK_FILES_LATER = 'Files for a task come with Do It.';

export function createConversationFiles(deps: {
  readonly state: StateStore;
  readonly now: () => number;
  /** The files git tracks in a checkout; none when it can't be read. */
  readonly trackedFiles: (repoPath: string) => readonly string[];
}): (conversationId: ConversationId, query: string) => ProjectFileMatchDto[] {
  const cache = new Map<string, { readonly at: number; readonly files: readonly string[] }>();
  const tracked = (repoPath: string): readonly string[] => {
    const now = deps.now();
    const kept = cache.get(repoPath);
    if (kept !== undefined && now - kept.at < TRACKED_FILES_TTL_MS) return kept.files;
    const files = deps.trackedFiles(repoPath);
    cache.set(repoPath, { at: now, files });
    return files;
  };
  return (conversationId, query) => {
    const conv = getConversation(deps.state.db, conversationId);
    switch (conv.ownerKind) {
      case ConversationOwnerKind.Task:
        throw new ConflictError(TASK_FILES_LATER);
      case ConversationOwnerKind.Reporter:
        throw new ConflictError(REPORTER_FILES);
      case ConversationOwnerKind.Chat: {
        // A session on its own branch mentions the files of its worktree.
        const project = getProject(deps.state.db, conv.projectId);
        const chat = chatOfConversation(deps.state.db, conv.id);
        return rankFiles(
          tracked(chat === null ? project.repoPath : chatRoot(chat, project).root),
          query,
        );
      }
    }
  };
}
