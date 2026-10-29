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
