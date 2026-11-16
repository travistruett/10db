import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
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
import type { Git, NetworkCall } from '../git';
import { githubRepoOf, type Gh } from '../github';
import type { ChatLiveSessions } from './live-sessions';
import { chatBranchName, isTenDbBranch } from './git-names';

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
  /** The checkout's secret files as a sandboxed session sees them (absolute): a commit never takes one. */
  readonly secretFilesOf: (repo: string) => Promise<readonly string[]>;
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

  /**
   * The same checks again, run by the git call under the repo lock right before it writes: a stop, a lane's
   * start or an archive can land between the first check and the lock, and a write must not follow it.
   */
  const stillHolding = async (): Promise<void> => {
    await holding();
  };

  /** The checkout, on a branch of the builder's own: not detached, not under 10db/. */
  async function onBranch(): Promise<{ repo: string; branch: string }> {
    const { repo } = await holding();
    const branch = await deps.git.currentBranch(repo);
    if (branch === null) throw new ConflictError('Your folder is on no branch (a detached HEAD).');
    return { repo, branch };
  }

  /** The GitHub repository the checkout's pinned origin names. */
  async function pinnedRepo(repo: string): Promise<string> {
    const slug = githubRepoOf(await deps.git.pinnedPushUrl(repo));
    if (slug === null) throw new InvalidError("Your folder's origin is not a GitHub repository");
    return slug;
  }

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
      const { repo, branch } = await onBranch();
      // Never forced: the daemon's push names one fully qualified ref and no option.
      const run = await deps.git.push(repo, branch, deps.net());
      return { done: true, branch, note: run.output.trim().slice(-500) };
    },
    [ChatToolName.OpenPullRequest]: async (args: unknown) => {
      const input = ChatToolInputs.open_pull_request.parse(args);
      if (input.base !== undefined && isTenDbBranch(input.base))
        throw new InvalidError("A pull request's base is never one of 10db's own branches");
      const { repo, branch } = await onBranch();
      const head = await deps.git.head(repo);
      if ((await deps.git.remoteTrackingCommit(repo, branch)) !== head)
        throw new ConflictError(
          `${branch} is not pushed at its current commit; call push_branch first.`,
        );
      const slug = await pinnedRepo(repo);
      const dir = deps.filesDir(session.conversationId);
      mkdirSync(dir, { recursive: true });
      const bodyFile = join(dir, `pr-body-${randomUUID()}.md`);
      writeFileSync(bodyFile, input.body, { flag: 'wx', mode: 0o600 });
      try {
        const url = await deps.gh.prCreate(
          { repo: slug, base: input.base ?? 'main', head: branch, title: input.title, bodyFile },
          deps.net(),
        );
        return { done: true, url };
      } finally {
        rmSync(bodyFile, { force: true });
      }
    },
    [ChatToolName.MergePullRequest]: async (args: unknown) => {
      const { number } = ChatToolInputs.merge_pull_request.parse(args);
      const { repo } = await holding();
      const slug = await pinnedRepo(repo);
      // The address comes from the pinned repository and the number alone, so another repository's pull
      // request cannot be named.
      const url = `https://github.com/${slug}/pull/${String(number)}`;
      const branches = await deps.gh.prBranches({ repo: slug, ref: url }, deps.net());
      if (branches === null)
        throw new InvalidError(`${slug} has no pull request #${String(number)}`);
      if (isTenDbBranch(branches.head))
        throw new ConflictError(
          `Pull request #${String(number)} comes from ${branches.head}, which is 10db's own; 10db merges those, not a chat.`,
        );
      if (isTenDbBranch(branches.base))
        throw new ConflictError(
          `Pull request #${String(number)} merges into ${branches.base}, which is 10db's own; 10db merges into those, not a chat.`,
        );
      await deps.gh.prMerge({ repo: slug, url }, deps.net());
      return { done: true, url };
    },
    [ChatToolName.CommitChanges]: async (args: unknown) => {
      const input = ChatToolInputs.commit_changes.parse(args);
      const { repo, sharedWith } = await holding();
      const paths = input.paths?.map((p) => insideCheckout(repo, p));
      const { sha } = await deps.git.commitInFolder(repo, {
        message: input.message,
        secretFiles: await deps.secretFilesOf(repo),
        beforeWrite: stillHolding,
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
