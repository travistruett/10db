import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ConflictError, InvalidError, type ConversationId } from '@10db/contracts';
import type { Git, NetworkCall } from '../git';
import { githubRepoOf, type Gh } from '../github';
import { isTenDbBranch } from './git-names';

// The git a chat changes, as the agent's tools and the title row's buttons both do it: one body each, so a commit
// from either takes the same paths and refuses the same files. Whether the caller may change anything, and in which
// folder, is the caller's to decide; these run where they are told.

export interface GitStepsDeps {
  readonly git: Pick<
    Git,
    'commitInFolder' | 'push' | 'head' | 'remoteTrackingCommit' | 'pinnedPushUrl'
  >;
  readonly gh: Pick<Gh, 'prCreate' | 'prMerge' | 'prBranches'>;
  /** A folder of the chat's own, where a pull request's body is written for the call. */
  readonly filesDir: (conversationId: ConversationId) => string;
  /** The checkout's secret files as a sandboxed session sees them (absolute): a commit never takes one. */
  readonly secretFilesOf: (repo: string) => Promise<readonly string[]>;
  /** How a fetch is made: in the login environment, bounded in time. */
  readonly net: () => NetworkCall;
}

/** Where a step runs: the folder, and the caller's last look at whether writing there is still allowed. */
export interface StepSite {
  readonly repo: string;
  readonly beforeWrite: () => Promise<void>;
}

/**
 * The path as the folder names it. A path may be absolute or relative to the folder, and must lie inside it; git
 * state is refused by the commit itself.
 */
function insideFolder(repo: string, path: string): string {
  const absolute = resolve(repo, path);
  const rel = relative(repo, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new InvalidError(`${path} is not a path inside Your folder`);
  return rel;
}

export function gitSteps(deps: GitStepsDeps) {
  /** The GitHub repository the folder's pinned origin names. */
  async function pinnedRepo(repo: string): Promise<string> {
    const slug = githubRepoOf(await deps.git.pinnedPushUrl(repo));
    if (slug === null) throw new InvalidError("Your folder's origin is not a GitHub repository");
    return slug;
  }

  return {
    /** Commits `paths`, or every change when none are named; a secret file is refused. */
    async commit(
      site: StepSite,
      input: { readonly message: string; readonly paths?: readonly string[] },
    ): Promise<{ readonly sha: string }> {
      const paths = input.paths?.map((p) => insideFolder(site.repo, p));
      return deps.git.commitInFolder(site.repo, {
        message: input.message,
        secretFiles: await deps.secretFilesOf(site.repo),
        beforeWrite: site.beforeWrite,
        ...(paths === undefined ? {} : { paths }),
      });
    },

    /** Pushes `branch`, never forced: one fully qualified ref and no option. */
    async push(site: StepSite, branch: string): Promise<{ readonly output: string }> {
      return deps.git.push(site.repo, branch, deps.net());
    },

    /** Opens a pull request for `branch`, which must be pushed at its current commit. */
    async openPullRequest(
      site: StepSite,
      input: {
        readonly conversationId: ConversationId;
        readonly branch: string;
        readonly base: string;
        readonly title: string;
        readonly body: string;
      },
    ): Promise<string> {
      if (isTenDbBranch(input.base))
        throw new InvalidError("A pull request's base is never one of 10db's own branches");
      const head = await deps.git.head(site.repo);
      if ((await deps.git.remoteTrackingCommit(site.repo, input.branch)) !== head)
        throw new ConflictError(
          `${input.branch} is not pushed at its current commit; call push_branch first.`,
        );
      const slug = await pinnedRepo(site.repo);
      const dir = deps.filesDir(input.conversationId);
      mkdirSync(dir, { recursive: true });
      const bodyFile = join(dir, `pr-body-${randomUUID()}.md`);
      writeFileSync(bodyFile, input.body, { flag: 'wx', mode: 0o600 });
      try {
        return await deps.gh.prCreate(
          {
            repo: slug,
            base: input.base,
            head: input.branch,
            title: input.title,
            bodyFile,
          },
          deps.net(),
        );
      } finally {
        rmSync(bodyFile, { force: true });
      }
    },

    /** Merges pull request `number` of the pinned repository, unless either end is 10db's own branch. */
    async mergePullRequest(site: StepSite, number: number): Promise<string> {
      const slug = await pinnedRepo(site.repo);
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
      return url;
    },
  };
}
