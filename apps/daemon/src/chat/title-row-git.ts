import {
  CHAT_DEFAULT_TITLE,
  ConflictError,
  WorkPlace,
  type ChatCommitRequest,
  type ChatId,
  type ChatWorkStateDto,
} from '@10db/contracts';
import { getChat, getProject } from '@10db/db';
import type { StateStore } from '../events';
import type { FolderHold } from '../folder-hold';
import type { Git } from '../git';
import { blockingHolder, checkoutHolderWords } from './checkout-words';
import { gitSteps, type GitStepsDeps, type StepSite } from './git-steps';
import { isTenDbBranch } from './git-names';
import type { ChatWorkService } from './work-service';

// The git steps the title row runs (sessions spec §4.6): a daemon route each, with no warm session and no turn.
// Each one acts on the session's own root: a branch session's worktree takes no hold, a Here session's checkout is
// reserved for the step (or refused at once when something has it), and a second click on a step already running
// is that step's answer.

export interface TitleRowGitDeps extends GitStepsDeps {
  readonly state: StateStore;
  readonly folderHold: FolderHold;
  readonly work: Pick<ChatWorkService, 'state' | 'forgetPullRequest'>;
  readonly git: GitStepsDeps['git'] & Pick<Git, 'currentBranch'>;
}

export interface TitleRowGit {
  /** Commits the paths given; answers the session's state after it. */
  commit(
    chatId: ChatId,
    request: ChatCommitRequest,
    signal: AbortSignal,
  ): Promise<ChatWorkStateDto>;
}

const MOVING_WORDS = 'Wait for the move to finish.';
const NOTHING_YET_WORDS = 'This session has not changed any files yet.';
const NO_WORKTREE_WORDS =
  'This session has no worktree now, so it changes no git state until it is reopened.';

export function createTitleRowGit(deps: TitleRowGitDeps): TitleRowGit {
  const { state, folderHold } = deps;
  const steps = gitSteps(deps);
  /** The step each chat is running, so a second click answers with it. */
  const running = new Map<string, Promise<ChatWorkStateDto>>();
  /** Every step of one chat runs after the one before it. */
  const chains = new Map<ChatId, Promise<unknown>>();

  /**
   * Runs `job` in the session's folder: a branch session's worktree, or the checkout reserved for `what`. A
   * session that is moving, that has changed nothing, or whose checkout is in the builder's terminal, a Board
   * task's or a pass's hands is refused at once, in words.
   */
  async function inFolder<T>(
    chatId: ChatId,
    what: string,
    signal: AbortSignal,
    job: (site: StepSite) => Promise<T>,
  ): Promise<T> {
    const chat = getChat(state.db, chatId);
    const noGuard = (): Promise<void> => Promise.resolve();
    switch (chat.workPlace) {
      case null:
      case WorkPlace.Choosing:
        throw new ConflictError(NOTHING_YET_WORDS);
      case WorkPlace.Moving:
        throw new ConflictError(MOVING_WORDS);
      case WorkPlace.Branch:
        if (chat.worktreePath === null) throw new ConflictError(NO_WORKTREE_WORDS);
        return job({ repo: chat.worktreePath, beforeWrite: noGuard });
      case WorkPlace.Here: {
        const projectId = chat.projectId;
        const repo = getProject(state.db, projectId).repoPath;
        const branch = await deps.git.currentBranch(repo);
        const blocking = blockingHolder(folderHold.holders(projectId, chatId));
        if (blocking !== undefined) throw new ConflictError(checkoutHolderWords(blocking, branch));
        if (branch !== null && isTenDbBranch(branch))
          throw new ConflictError(
            `Your checkout is on ${branch}, which is 10db's own, so a session changes no git state there.`,
          );
        const token = await folderHold.reserveGitWhenFree(projectId, what, { signal });
        try {
          return await job({ repo, beforeWrite: noGuard });
        } finally {
          folderHold.releaseGit(token);
        }
      }
    }
  }

  /** One step of one chat: after the chat's earlier steps, and shared by a second click while it runs. */
  function step(
    chatId: ChatId,
    name: string,
    run: () => Promise<ChatWorkStateDto>,
  ): Promise<ChatWorkStateDto> {
    const key = `${chatId}:${name}`;
    const same = running.get(key);
    if (same !== undefined) return same;
    const earlier = chains.get(chatId) ?? Promise.resolve();
    const result = earlier.then(run, run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    running.set(key, result);
    chains.set(chatId, tail);
    void tail.then(() => {
      if (running.get(key) === result) running.delete(key);
      if (chains.get(chatId) === tail) chains.delete(chatId);
    });
    return result;
  }

  return {
    commit(chatId, request, signal) {
      return step(chatId, 'commit', async () => {
        const title = getChat(state.db, chatId).title ?? CHAT_DEFAULT_TITLE;
        await inFolder(chatId, `committing for the session ‘${title}’`, signal, (site) =>
          steps.commit(site, { message: request.message, paths: request.paths }),
        );
        return deps.work.state(chatId, signal);
      });
    },
  };
}
