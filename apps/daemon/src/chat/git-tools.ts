import {
  ChatToolInputs,
  ChatToolName,
  ConflictError,
  FolderAsker,
  FolderHolderKind,
  InvalidError,
  WorkPlace,
  type ChatId,
  type ConversationId,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';
import { holderWords, type FolderHold } from '../folder-hold';
import type { Git, NetworkCall } from '../git';
import type { Gh } from '../github';
import type { ChatLiveSessions } from './live-sessions';
import { chatBranchName, isTenDbBranch } from './git-names';
import { gitSteps } from './git-steps';

// Sessions spec §7.3: a chat changes git in Your folder through these tools, which run only while its turn
// holds the folder, never on 10db's branches, and never while a closed pass waits for its pull request.

export interface ChatGitToolsDeps {
  readonly git: Pick<
    Git,
    | 'currentBranch'
    | 'makeBranchHere'
    | 'switchBranch'
    | 'pullFastForward'
    | 'commitInFolder'
    | 'push'
    | 'head'
    | 'remoteTrackingCommit'
    | 'pinnedPushUrl'
  >;
  readonly gh: Pick<Gh, 'prCreate' | 'prMerge' | 'prBranches'>;
  /** A folder of the chat's own, where a pull request's body is written for the call. */
  readonly filesDir: (conversationId: ConversationId) => string;
  readonly folderHold: FolderHold;
  readonly live: ChatLiveSessions;
  /** The project's checkout. */
  readonly repoOf: (projectId: ProjectId) => string;
  /** Where the session works, from its row: a branch session runs its tools in its own worktree. */
  readonly placeOf: (chatId: ChatId) => {
    readonly place: WorkPlace | null;
    readonly worktree: string | null;
  };
  /** The checkout's secret files as a sandboxed session sees them (absolute): a commit never takes one. */
  readonly secretFilesOf: (repo: string) => Promise<readonly string[]>;
  /** How a fetch is made: in the login environment, bounded in time. */
  readonly net: () => NetworkCall;
  /**
   * A session that has not chosen where to work goes Here and takes the checkout before a push, a pull request
   * or a merge, which the judge has already let through; throws the holder's words when it can't.
   */
  readonly takeHere: (chatId: ChatId) => void;
}

export interface ChatGitSession {
  readonly sessionId: SessionId;
  readonly conversationId: ConversationId;
  readonly chatId: ChatId;
  readonly projectId: ProjectId;
}

/** What a chat's git tool answers when the turn does not hold Your folder. */
export const gitNeedsFolder = (holder: string): string =>
  `This turn does not hold Your folder (${holder}), so it can change no git state. Reading (git status, diff, log) still works.`;

export function chatGitTools(deps: ChatGitToolsDeps, session: ChatGitSession) {
  const { projectId, chatId } = session;
  const asker = { kind: FolderAsker.ChatTurn, chatId } as const;

  /** Runs in Your folder only while this session's turn holds it; answers the checkout and who shares it. */
  async function holding(takesHere = false): Promise<{ repo: string; sharedWith: string[] }> {
    if (deps.live.get(session.conversationId, session.sessionId) === null)
      throw new ConflictError('This session has ended, so it changes nothing in Your folder.');
    if (takesHere) deps.takeHere(chatId);
    const { place, worktree } = deps.placeOf(chatId);
    if (place === WorkPlace.Moving) throw new ConflictError('Wait for the move to finish.');
    if (place === WorkPlace.Branch) {
      // The worktree is the session's own: no holder shares it, so there is no hold to take.
      if (worktree === null)
        throw new ConflictError(
          'This session has no worktree now, so it changes no git state until it is reopened.',
        );
      // The agent can switch its worktree to any branch git lets it, so the branch is read each time.
      const head = await deps.git.currentBranch(worktree);
      if (head !== null && isTenDbBranch(head))
        throw new ConflictError(
          `This session's worktree is on ${head}, which is 10db's own, so a chat changes no git state there.`,
        );
      return { repo: worktree, sharedWith: [] };
    }
    if (!deps.folderHold.holdsTurn(chatId)) {
      const holder =
        deps.folderHold
          .blockers(projectId, asker)
          .map((b) => holderWords(b.holder))
          .join(' and ') || 'something else has it';
      throw new ConflictError(gitNeedsFolder(holder));
    }
    const others = deps.folderHold.holders(projectId, chatId);
    const closed = others.find((h) => h.kind === FolderHolderKind.PassClosed);
    if (closed !== undefined)
      throw new ConflictError(
        `Git in Your folder waits: ${holderWords(closed)}. Its branch is the folder's until then.`,
      );
    const repo = deps.repoOf(projectId);
    const head = await deps.git.currentBranch(repo);
    if (head !== null && isTenDbBranch(head))
      throw new ConflictError(
        `Your folder is on ${head}, which is 10db's own, so a chat changes no git state there.`,
      );
    return {
      repo,
      sharedWith: others
        .filter((h) => h.kind === FolderHolderKind.ChatTurn)
        .map((h) => holderWords(h)),
    };
  }

  /**
   * The same checks again, run by the git call under the repo lock right before it writes: a stop, a lane's
   * start or an archive can land between the first check and the lock, and a write must not follow it.
   */
  const stillHolding = async (): Promise<void> => {
    await holding();
  };

  /** The checkout, on a branch of the builder's own: not detached, not under 10db/. */
  async function onBranch(takesHere = false): Promise<{ repo: string; branch: string }> {
    const { repo } = await holding(takesHere);
    const branch = await deps.git.currentBranch(repo);
    if (branch === null) throw new ConflictError('Your folder is on no branch (a detached HEAD).');
    return { repo, branch };
  }

  const steps = gitSteps(deps);
  /** The folder a step runs in, with the same hold check repeated under the repo lock before it writes. */
  const siteOf = (repo: string) => ({ repo, beforeWrite: stillHolding });

  return {
    [ChatToolName.MakeBranch]: async (args: unknown) => {
      const { name } = ChatToolInputs.make_branch.parse(args);
      const branch = chatBranchName(name);
      const { repo } = await holding();
      await deps.git.makeBranchHere(repo, branch, stillHolding);
      return {
        done: true,
        branch,
        note: 'The changes in Your folder came along; nothing was committed.',
      };
    },
    [ChatToolName.SwitchBranch]: async (args: unknown) => {
      const { name } = ChatToolInputs.switch_branch.parse(args);
      const branch = chatBranchName(name);
      const { repo } = await holding();
      await deps.git.switchBranch(repo, branch, stillHolding);
      return { done: true, branch };
    },
    [ChatToolName.Pull]: async (args: unknown) => {
      ChatToolInputs.pull.parse(args);
      const { repo } = await holding();
      return { done: true, ...(await deps.git.pullFastForward(repo, deps.net(), stillHolding)) };
    },
    [ChatToolName.PushBranch]: async (args: unknown) => {
      ChatToolInputs.push_branch.parse(args);
      const { repo, branch } = await onBranch(true);
      // Never forced: the daemon's push names one fully qualified ref and no option.
      const run = await steps.push(siteOf(repo), branch);
      return { done: true, branch, note: run.output.trim().slice(-500) };
    },
    [ChatToolName.OpenPullRequest]: async (args: unknown) => {
      const input = ChatToolInputs.open_pull_request.parse(args);
      if (input.base !== undefined && isTenDbBranch(input.base))
        throw new InvalidError("A pull request's base is never one of 10db's own branches");
      const { repo, branch } = await onBranch(true);
      const url = await steps.openPullRequest(siteOf(repo), {
        conversationId: session.conversationId,
        branch,
        base: input.base ?? 'main',
        title: input.title,
        body: input.body,
      });
      return { done: true, url };
    },
    [ChatToolName.MergePullRequest]: async (args: unknown) => {
      const { number } = ChatToolInputs.merge_pull_request.parse(args);
      const { repo } = await holding(true);
      const url = await steps.mergePullRequest(siteOf(repo), number);
      return { done: true, url };
    },
    [ChatToolName.CommitChanges]: async (args: unknown) => {
      const input = ChatToolInputs.commit_changes.parse(args);
      const { repo, sharedWith } = await holding();
      const { sha } = await steps.commit(siteOf(repo), {
        message: input.message,
        ...(input.paths === undefined ? {} : { paths: input.paths }),
      });
      return {
        done: true,
        sha,
        // Everything changed in the folder is taken when no path is named, other chats' edits included.
        ...(input.paths === undefined && sharedWith.length > 0
          ? {
              warning: `Your folder is shared with ${sharedWith.join(' and ')}, so this commit may hold their changes too. Name paths to commit only yours.`,
            }
          : {}),
      };
    },
  };
}
