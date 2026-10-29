import { GitError } from './run';

/** What `Git.inspect` reads of a repository. */
export interface RepoFacts {
  /** The working tree's top level, as a real path. */
  readonly root: string;
  /** Origin's branches first, then local branches not on origin. */
  readonly branches: readonly { readonly name: string; readonly remote: boolean }[];
  /** origin/HEAD's target, else the current branch when it has commits, else null. */
  readonly defaultBranch: string | null;
  readonly originFetchUrl: string | null;
}

/** Why `Git.inspect` read nothing; the message is one line of git's own words. */
export interface RepoRefusal {
  readonly refused: 'not_a_repository' | 'bare_repository' | 'unreadable';
  readonly message: string;
}

/** The tracked files of HEAD and the files each of its latest commits changed. */
export interface RepoSurvey {
  readonly files: readonly string[];
  /** Newest first; a commit that changed more than `SURVEY_MAX_COMMIT_FILES` files is left out. */
  readonly commits: readonly (readonly string[])[];
}

/** Printed before each commit in `git log -z --name-only --format=<mark>`. */
export const SURVEY_COMMIT_MARK = '%x01';

/** A commit that changes more files than this is an import or a sweep, and says nothing about seams. */
export const SURVEY_MAX_COMMIT_FILES = 200;

/** The commits in the output of `git log -z --name-only --format=%x01`: each one's changed paths. */
export function parseSurveyLog(out: string): string[][] {
  return (
    out
      .split('\u0001')
      // Git prints a newline after the mark's format, which lands in front of the commit's first path.
      .map((chunk) =>
        chunk
          .split('\0')
          .map((name) => name.replace(/^\n/u, ''))
          .filter((name) => name !== ''),
      )
      .filter((names) => names.length > 0 && names.length <= SURVEY_MAX_COMMIT_FILES)
  );
}

/** Why git read nothing from `error`, in the words `Git.inspect` and `Git.survey` answer with. */
export function refusalOf(error: unknown): RepoRefusal {
  if (
    error instanceof GitError &&
    /not a git repository \((?:or any of the parent directories|or any parent up to mount point)/i.test(
      error.stderr,
    )
  )
    return { refused: 'not_a_repository', message: firstLine(error.stderr) };
  return {
    refused: 'unreadable',
    message: firstLine(error instanceof GitError ? error.stderr : String(error)),
  };
}

const HEADS = 'refs/heads/';
const ORIGIN = 'refs/remotes/origin/';

/** The branches `for-each-ref --format=%(refname)` lists under `refs/heads` and `refs/remotes/origin`. */
export function parseBranches(out: string): { name: string; remote: boolean }[] {
  const refs = out.split('\n').filter((line) => line !== '');
  const remote = refs
    .filter((ref) => ref.startsWith(ORIGIN))
    .map((ref) => ref.slice(ORIGIN.length))
    .filter((name) => name !== 'HEAD');
  const onOrigin = new Set(remote);
  const local = refs
    .filter((ref) => ref.startsWith(HEADS))
    .map((ref) => ref.slice(HEADS.length))
    .filter((name) => !onOrigin.has(name));
  return [
    ...remote.map((name) => ({ name, remote: true })),
    ...local.map((name) => ({ name, remote: false })),
  ];
}

/** The branch a `symbolic-ref` answer names under `prefix`; null for anything else. */
export function branchOfRef(out: string, prefix: 'heads' | 'origin'): string | null {
  const ref = out.trim();
  const base = prefix === 'heads' ? HEADS : ORIGIN;
  return ref.startsWith(base) && ref.length > base.length ? ref.slice(base.length) : null;
}

/** The first line of git's complaint, for a builder to read. */
export function firstLine(stderr: string): string {
  const line =
    stderr.split('\n').find((l) => l.trim() !== '') ?? 'git could not read this repository';
  return line.trim().replace(/^fatal: /, '');
}
