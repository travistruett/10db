import {
  CHAT_DEFAULT_TITLE,
  ConflictError,
  ChatGitStep,
  Delivery,
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
import { branchFor } from './chat-worktree';
import { refuseOwnBranch } from './git-names';
import type { ChatWorkService } from './work-service';

// The git steps the title row runs (sessions spec §4.6): a daemon route each, with no warm session and no turn.
// Each one acts on the session's own root: a branch session's worktree takes no hold, a Here session's checkout is
// reserved for the step (or refused at once when something has it), and a second click on a step already running
// is that step's answer.

export interface TitleRowGitDeps extends GitStepsDeps {
  readonly state: StateStore;
  readonly folderHold: FolderHold;
  readonly work: Pick<ChatWorkService, 'state' | 'forgetPullRequest'>;
  readonly git: GitStepsDeps['git'] &
    Pick<
      Git,
      | 'currentBranch'
      | 'changedPaths'
      | 'trackingTip'
      | 'localBranches'
      | 'moveCommitsToBranch'
      | 'mergeIntoBranch'
    >;
}

export interface TitleRowGit {
  /** Commits the paths given; answers the session's state after it. */
  commit(
    chatId: ChatId,
    request: ChatCommitRequest,
    signal: AbortSignal,
  ): Promise<ChatWorkStateDto>;
  /**
   * Pushes the session's branch and opens its pull request. From the base branch, the commits first move to a
   * branch of their own and the base goes back to its origin.
   */
  openPullRequest(chatId: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
  /**
   * Merges the session's pull request, or on a local project its branch into the base branch of the builder's
   * checkout, which must be clean and on the base. A conflict writes nothing.
   */
  merge(chatId: ChatId, signal: AbortSignal): Promise<ChatWorkStateDto>;
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
    switch (chat.workPlace) {
      case null:
      case WorkPlace.Choosing:
        throw new ConflictError(NOTHING_YET_WORDS);
      case WorkPlace.Moving:
        throw new ConflictError(MOVING_WORDS);
      case WorkPlace.Branch:
        if (chat.worktreePath === null) throw new ConflictError(NO_WORKTREE_WORDS);
        {
          const worktree = chat.worktreePath;
          const recheck = (): Promise<void> =>
            refuseOwnBranch(deps.git, worktree, "This session's worktree");
          await recheck();
          return job({ repo: worktree, beforeWrite: recheck });
        }
      case WorkPlace.Here: {
        const projectId = chat.projectId;
        const repo = getProject(state.db, projectId).repoPath;
        const branch = await deps.git.currentBranch(repo);
        const blocking = blockingHolder(folderHold.holders(projectId, chatId));
        if (blocking !== undefined) throw new ConflictError(checkoutHolderWords(blocking, branch));
        await refuseOwnBranch(deps.git, repo, 'Your checkout');
        const token = await folderHold.reserveGitWhenFree(projectId, what, { signal });
        try {
          return await job({
            repo,
            beforeWrite: () => refuseOwnBranch(deps.git, repo, 'Your checkout'),
          });
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

  /** The branch a session's commits are on, made from the base branch first when the checkout is still on it. */
  async function branchForPullRequest(
    site: StepSite,
    chatId: ChatId,
    base: string,
  ): Promise<string> {
    const chat = getChat(state.db, chatId);
    const branch = await deps.git.currentBranch(site.repo);
    if (branch === null)
      throw new ConflictError(
        'The session is on no branch (a detached HEAD), so there is nothing to push.',
      );
    if (chat.workPlace !== WorkPlace.Here || branch !== base) return branch;
    if ((await deps.git.changedPaths(site.repo)).length > 0)
      throw new ConflictError(
        `Your checkout has uncommitted changes on ${base}. Commit them first, so the commits can move to a branch of their own.`,
      );
    const origin = await deps.git.trackingTip(site.repo, base);
    if (origin === null)
      throw new ConflictError(`origin/${base} is not known here, so ${base} can't be put back.`);
    const head = await deps.git.head(site.repo);
    const taken = (await deps.git.localBranches(site.repo, '')).map((b) => b.name);
    const { branch: name } = branchFor(
      chat.title ?? CHAT_DEFAULT_TITLE,
      { branches: taken, paths: [] },
      (b) => b,
    );
    await deps.git.moveCommitsToBranch(site.repo, {
      name,
      base,
      to: origin,
      expectedOld: head,
      beforeWrite: site.beforeWrite,
    });
    return name;
  }

  /** A local merge into the builder's checkout: reserved for the step, whoever the session is. */
  async function mergeLocally(chatId: ChatId, signal: AbortSignal): Promise<void> {
    const chat = getChat(state.db, chatId);
    const project = getProject(state.db, chat.projectId);
    const repo = project.repoPath;
    const base = project.baseBranch;
    if (chat.branch === null) throw new ConflictError('This session has no branch to merge.');
    const blocking = blockingHolder(folderHold.holders(chat.projectId, chatId));
    if (blocking !== undefined)
      throw new ConflictError(checkoutHolderWords(blocking, await deps.git.currentBranch(repo)));
    const title = chat.title ?? CHAT_DEFAULT_TITLE;
    const token = await folderHold.reserveGitWhenFree(
      chat.projectId,
      `merging ‘${title}’ into ${base}`,
      { signal },
    );
    try {
      // Read again under the reservation: the checkout may have changed while the step waited.
      const on = await deps.git.currentBranch(repo);
      if (on !== base)
        throw new ConflictError(
          `Your checkout is on ${on === null ? 'no branch' : `\`${on}\``}; it must be on \`${base}\` to take the merge.`,
        );
      if ((await deps.git.changedPaths(repo)).length > 0)
        throw new ConflictError('Your checkout has uncommitted changes, so it can’t take a merge.');
      const merged = await deps.git.mergeIntoBranch({
        repo,
        branch: base,
        from: `refs/heads/${chat.branch}`,
        message: `Merge ${chat.branch} into ${base}`,
      });
      if (merged.kind === 'conflict')
        throw new ConflictError(
          `Merging ${chat.branch} into ${base} conflicts in ${merged.paths.join(', ')}, so nothing was merged.`,
        );
    } finally {
      folderHold.releaseGit(token);
    }
  }

  return {
    merge(chatId, signal) {
      return step(chatId, 'merge', async () => {
        const chat = getChat(state.db, chatId);
        const project = getProject(state.db, chat.projectId);
        const now = await deps.work.state(chatId, signal);
        const title = chat.title ?? CHAT_DEFAULT_TITLE;
        if (project.delivery === Delivery.Local) {
          if (now.next !== ChatGitStep.MergeLocal)
            throw new ConflictError(now.refusal ?? 'This session has nothing to merge.');
          await mergeLocally(chatId, signal);
        } else {
          const pull = now.pullRequest;
          if (now.next !== ChatGitStep.Merge || pull === null)
            throw new ConflictError(now.refusal ?? 'This session has no pull request to merge.');
          if (now.refusal !== null) throw new ConflictError(now.refusal);
          await inFolder(chatId, `merging the pull request of ‘${title}’`, signal, (site) =>
            steps.mergePullRequest(site, pull.number),
          );
          deps.work.forgetPullRequest(chatId, now.branch ?? undefined);
        }
        return deps.work.state(chatId, signal);
      });
    },

    openPullRequest(chatId, signal) {
      return step(chatId, 'pull-request', async () => {
        const chat = getChat(state.db, chatId);
        const project = getProject(state.db, chat.projectId);
        if (project.delivery === Delivery.Local)
          throw new ConflictError(
            'This project merges locally, so there is no pull request to open.',
          );
        const title = chat.title ?? CHAT_DEFAULT_TITLE;
        const made: { branch: string | null } = { branch: null };
        try {
          await inFolder(chatId, `opening a pull request for ‘${title}’`, signal, async (site) => {
            const branch = await branchForPullRequest(site, chatId, project.baseBranch);
            made.branch = branch;
            await steps.push(site, branch);
            await steps.openPullRequest(site, {
              conversationId: chat.conversationId,
              branch,
              base: project.baseBranch,
              title,
              body: '',
            });
          });
        } finally {
          if (made.branch !== null) deps.work.forgetPullRequest(chatId, made.branch);
        }
        return deps.work.state(chatId, signal);
      });
    },

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
