import { isAbsolute, relative, resolve } from 'node:path';
import {
  ChatToolInputs,
  ChatToolName,
  ConflictError,
  FolderAsker,
  FolderHolderKind,
  InvalidError,
  type ChatId,
  type ConversationId,
  type ProjectId,
  type SessionId,
} from '@10db/contracts';
import { holderWords, type FolderHold } from '../folder-hold';
import type { Git } from '../git';
import type { NetworkCall } from '../git';
import type { ChatLiveSessions } from './live-sessions';
import { chatBranchName, isTenDbBranch } from './git-names';

// Sessions spec §7.3: a chat changes git in Your folder through these tools, which run only while its turn
// holds the folder, never on 10db's branches, and never while a closed pass waits for its pull request.

export interface ChatGitToolsDeps {
  readonly git: Pick<
    Git,
    'currentBranch' | 'makeBranchHere' | 'switchBranch' | 'pullFastForward' | 'commitInFolder'
  >;
  readonly folderHold: FolderHold;
  readonly live: ChatLiveSessions;
  /** The project's checkout. */
  readonly repoOf: (projectId: ProjectId) => string;
  /** How a fetch is made: in the login environment, bounded in time. */
  readonly net: () => NetworkCall;
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

/**
 * The path as the checkout names it. A path the agent wrote may be absolute or relative to the checkout, and
 * must lie inside it; git state is refused by the commit itself.
 */
function insideCheckout(repo: string, path: string): string {
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new InvalidError(`${path} is not a path inside Your folder`);
  return rel;
}

export function chatGitTools(deps: ChatGitToolsDeps, session: ChatGitSession) {
  const { projectId, chatId } = session;
  const asker = { kind: FolderAsker.ChatTurn, chatId } as const;

  /** Runs in Your folder only while this session's turn holds it; answers the checkout and who shares it. */
  async function holding(): Promise<{ repo: string; sharedWith: string[] }> {
    if (deps.live.get(session.conversationId, session.sessionId) === null)
      throw new ConflictError('This session has ended, so it changes nothing in Your folder.');
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

  return {
    [ChatToolName.MakeBranch]: async (args: unknown) => {
      const { name } = ChatToolInputs.make_branch.parse(args);
      const branch = chatBranchName(name);
      const { repo } = await holding();
      await deps.git.makeBranchHere(repo, branch);
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
      await deps.git.switchBranch(repo, branch);
      return { done: true, branch };
    },
    [ChatToolName.Pull]: async (args: unknown) => {
      ChatToolInputs.pull.parse(args);
      const { repo } = await holding();
      return { done: true, ...(await deps.git.pullFastForward(repo, deps.net())) };
    },
    [ChatToolName.CommitChanges]: async (args: unknown) => {
      const input = ChatToolInputs.commit_changes.parse(args);
      const { repo, sharedWith } = await holding();
      const paths = input.paths?.map((p) => insideCheckout(repo, p));
      const { sha } = await deps.git.commitInFolder(repo, {
        message: input.message,
        ...(paths === undefined ? {} : { paths }),
      });
      return {
        done: true,
        sha,
        // Everything changed in the folder is taken when no path is named, other chats' edits included.
        ...(paths === undefined && sharedWith.length > 0
          ? {
              warning: `Your folder is shared with ${sharedWith.join(' and ')}, so this commit may hold their changes too. Name paths to commit only yours.`,
            }
          : {}),
      };
    },
  };
}
