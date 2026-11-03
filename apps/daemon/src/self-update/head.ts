import { CommitSha } from '@10db/contracts';
import type { GhCall, GhExec } from '../github';
import { REPOSITORY } from './build-info';

/**
 * The commit at the head of `main` on GitHub for an `owner/name` repository, through gh. Rejects when
 * gh fails or answers anything but a commit SHA, so a captive portal or an error page is no commit.
 */
export function githubHeadOfMain(
  exec: GhExec,
  call: () => GhCall,
): (repo: string) => Promise<string> {
  return async (repo) => {
    if (!REPOSITORY.test(repo)) throw new Error(`'${repo}' is not a GitHub repository name`);
    const result = await exec(['api', `repos/${repo}/commits/main`, '--jq', '.sha'], call());
    if (result.exitCode !== 0) {
      throw new Error(`gh could not read main of ${repo}: ${result.stderr.trim() || 'no message'}`);
    }
    const sha = CommitSha.safeParse(result.stdout.trim());
    if (!sha.success)
      throw new Error(`GitHub answered something that is not a commit for main of ${repo}`);
    return sha.data;
  };
}

const COMPARISON = new Set(['ahead', 'behind', 'identical', 'diverged']);
/** gh's words for a commit GitHub does not have, or cannot compare with: not an error to retry. */
const UNKNOWN_COMMIT = /HTTP (404|422)/;

/**
 * Whether `head` is ahead of `base` in the repository: it holds every commit of `base` and more. A
 * build installed from another branch, or from a commit nobody pushed, is not behind main, and main
 * is not an update for it; a build older than the running one is no update either. Rejects when
 * GitHub can't be asked or answers something else, so the check is tried again.
 */
export function githubMainIsAhead(
  exec: GhExec,
  call: () => GhCall,
): (repo: string, base: string, head: string) => Promise<boolean> {
  return async (repo, base, head) => {
    if (!REPOSITORY.test(repo)) throw new Error(`'${repo}' is not a GitHub repository name`);
    if (!CommitSha.safeParse(base).success || !CommitSha.safeParse(head).success) {
      throw new Error('a commit to compare is not a full commit SHA');
    }
    const result = await exec(
      ['api', `repos/${repo}/compare/${base}...${head}`, '--jq', '.status'],
      call(),
    );
    if (result.exitCode !== 0) {
      if (UNKNOWN_COMMIT.test(result.stderr)) return false;
      throw new Error(
        `gh could not compare main of ${repo}: ${result.stderr.trim() || 'no message'}`,
      );
    }
    const status = result.stdout.trim();
    if (!COMPARISON.has(status)) {
      throw new Error(`GitHub answered something that is not a comparison for main of ${repo}`);
    }
    return status === 'ahead';
  };
}
