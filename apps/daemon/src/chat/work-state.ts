import {
  ConversationItemBody,
  ConversationItemKind,
  Delivery,
  WorkPlace,
  type ChatId,
  type ChatWorkStateDto,
  type ConversationId,
  type ProjectId,
} from '@10db/contracts';
import { getChat, getProject, listItems, type DbReader } from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { FolderHold } from '../folder-hold';
import { GitError, type Git } from '../git';
import { githubRepoOf, PrMergeable, PrState, type Gh, type GhCall } from '../github';
import { blockingHolder, checkoutHolderWords } from './checkout-words';
import { nextGitStep } from './next-git-step';
import { touchedPaths } from './touched-paths';
import { chatRoot } from './work-root';

// The facts behind the title row and the bar (`GET /chats/:id/work`), computed on demand from the session's root:
// what it changed, what is ahead, who has the checkout, and its pull request. GitHub is asked once per branch for a
// while, since the title row reads often and nothing here may poll.

/** How long a branch's pull request is trusted before GitHub is asked again; the pull-request watcher's pace. */
export const PULL_REQUEST_READ_MS = 2 * 60_000;

export interface ChatWorkStateDeps {
  readonly state: Pick<StateStore, 'db'>;
  readonly git: Pick<Git, 'currentBranch' | 'changedPaths' | 'countCommits' | 'pinnedPushUrl'>;
  readonly gh: Pick<Gh, 'prView' | 'prStatus'>;
  /** How a GitHub call is made: in the login environment, bounded in time. */
  readonly net: () => GhCall;
  readonly folderHold: Pick<FolderHold, 'holders'>;
  readonly clock: Pick<Clock, 'now'>;
}

export interface ChatWorkStateReader {
  /** The session's facts; `moveFailure` is why its last move failed, which only the work service knows. */
  read(chatId: ChatId, signal: AbortSignal, moveFailure: string | null): Promise<ChatWorkStateDto>;
  /** A pull request just opened or merged: the branch's next read asks GitHub afresh. */
  forgetPullRequest(projectId: ProjectId, branch: string): void;
}

type PullRequestFacts = NonNullable<ChatWorkStateDto['pullRequest']>;

interface Cached {
  readonly at: number;
  readonly read: Promise<PullRequestFacts | null>;
}

const PULL_NUMBER = /\/pull\/(\d+)\/?$/;

/** A git read that fails on a repository state (no such ref, no origin) is a fact that reads as `fallback`. */
async function orElse<T>(read: Promise<T>, fallback: T): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof GitError) return fallback;
    throw error;
  }
}

/** The root-relative paths of the session's allowed edits, from its transcript. */
function touchedBy(db: DbReader, conversationId: ConversationId, root: string): string[] {
  const calls = listItems(db, conversationId).flatMap((item) => {
    if (item.kind !== ConversationItemKind.ToolCall) return [];
    const parsed = ConversationItemBody.tool_call.safeParse(item.body);
    return parsed.success ? [parsed.data] : [];
  });
  return touchedPaths(calls, root);
}

export function createChatWorkStateReader(deps: ChatWorkStateDeps): ChatWorkStateReader {
  const { git, gh } = deps;
  const cache = new Map<string, Cached>();
  const keyOf = (projectId: ProjectId, branch: string): string => `${projectId}\u0000${branch}`;

  async function readPullRequest(repo: string, branch: string): Promise<PullRequestFacts | null> {
    const call = deps.net();
    const found = await gh.prView({ repo, ref: branch }, call);
    if (found === null || found.state === PrState.Closed) return null;
    const number = Number(PULL_NUMBER.exec(found.url)?.[1] ?? '');
    if (!Number.isInteger(number) || number <= 0) return null;
    if (found.state === PrState.Merged)
      return {
        number,
        url: found.url,
        checks: { passed: 0, total: 0, failing: 0 },
        mergeable: null,
        merged: true,
      };
    const status = await gh.prStatus({ repo, ref: found.url }, call);
    return {
      number,
      url: found.url,
      checks: status?.counts ?? { passed: 0, total: 0, failing: 0 },
      mergeable:
        status === null || status.mergeable === PrMergeable.Unknown
          ? null
          : status.mergeable === PrMergeable.Mergeable,
      merged: false,
    };
  }

  /**
   * The branch's pull request, from GitHub at most once per interval; a read that failed is not kept. The read is
   * shared by every caller, so it answers to none of their signals; the net's own timeout bounds it.
   */
  function pullRequestOf(
    projectId: ProjectId,
    repo: string,
    branch: string,
  ): Promise<PullRequestFacts | null> {
    const key = keyOf(projectId, branch);
    const now = deps.clock.now().getTime();
    const held = cache.get(key);
    if (held !== undefined && now - held.at < PULL_REQUEST_READ_MS) return held.read;
    const read = readPullRequest(repo, branch).catch(() => {
      if (cache.get(key)?.read === read) cache.delete(key);
      return null;
    });
    cache.set(key, { at: now, read });
    return read;
  }

  return {
    forgetPullRequest(projectId, branch) {
      cache.delete(keyOf(projectId, branch));
    },

    async read(chatId, signal, moveFailure) {
      signal.throwIfAborted();
      const db = deps.state.db;
      const chat = getChat(db, chatId);
      const project = getProject(db, chat.projectId);
      const checkout = project.repoPath;
      const { root, writes } = chatRoot(chat, project);
      const place = chat.workPlace;
      const own = place === WorkPlace.Here || place === WorkPlace.Branch;
      const local = project.delivery === Delivery.Local;
      const baseBranch = project.baseBranch;

      const checkoutBranch = await orElse(git.currentBranch(checkout), null);
      const branch =
        place === WorkPlace.Branch || place === WorkPlace.Moving
          ? chat.branch
          : place === WorkPlace.Here && root !== checkout
            ? await orElse(git.currentBranch(root), null)
            : checkoutBranch;

      const touched = writes ? touchedBy(db, chat.conversationId, root) : [];
      const rootChanges = writes ? await orElse(git.changedPaths(root), []) : [];
      const checkoutChanges =
        root === checkout && writes ? rootChanges : await orElse(git.changedPaths(checkout), []);
      const uncommittedInCheckout =
        place === WorkPlace.Here
          ? checkoutChanges.filter((path) => !touched.includes(path)).length
          : checkoutChanges.length;

      const aheadOf = local
        ? baseBranch
        : place === WorkPlace.Branch && chat.baseHead !== null
          ? chat.baseHead
          : `origin/${baseBranch}`;
      const ahead = writes ? await orElse(git.countCommits(root, aheadOf, 'HEAD'), 0) : 0;

      const repo = local ? null : githubRepoOf(await orElse(git.pinnedPushUrl(checkout), ''));
      const pullRequest =
        own && repo !== null && branch !== null && branch !== baseBranch
          ? await pullRequestOf(chat.projectId, repo, branch)
          : null;

      // Commits past the pushed copy of the branch; a branch never pushed has no copy, and reads as none.
      const unpushed =
        writes && pullRequest !== null && branch !== null
          ? await orElse(git.countCommits(root, `origin/${branch}`, 'HEAD'), 0)
          : 0;

      const blocking =
        place === null || place === WorkPlace.Choosing || place === WorkPlace.Here
          ? blockingHolder(deps.folderHold.holders(chat.projectId, chatId))
          : undefined;
      const holder = blocking === undefined ? null : checkoutHolderWords(blocking, checkoutBranch);

      const step = nextGitStep({
        place,
        writes,
        local,
        hasGithub: repo !== null,
        baseBranch,
        onBase: branch === baseBranch,
        dirtyFiles: rootChanges.length,
        ahead,
        unpushed,
        pullRequest,
        checkout: { branch: checkoutBranch, dirtyFiles: checkoutChanges.length },
        holder: place === WorkPlace.Here ? holder : null,
        moveFailure,
      });

      return {
        place,
        branch,
        base: chat.baseHead,
        baseBranch,
        dirtyFiles: rootChanges.length,
        ahead,
        uncommittedInCheckout,
        touched,
        pullRequest,
        next: step.next,
        refusal: step.refusal,
        holder,
      };
    },
  };
}
