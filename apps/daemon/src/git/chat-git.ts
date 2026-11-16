import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, normalize, sep } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { foldPathCase, isSecretFileName } from '../guard';
import type { NetworkCall, NetworkRun } from './network';
import { GitError } from './run';
import { isGitComponent } from './worktree-files';

/**
 * Git changes made in Your folder for a chat's tools, with the daemon's own rules: nothing in the checkout
 * runs (no hook, no filter, no submodule), paths are literal, a message goes on stdin, and a commit carries
 * the builder's identity and signing config. Each call refuses where a filter would change what is written.
 */

/** Where a call works: the checkout's real path and the variables that point git at its git dir. */
interface ChatSite {
  readonly real: string;
}

type Runner<C> = (
  c: C,
  args: readonly string[],
  run?: {
    readonly input?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly config?: readonly string[];
  },
) => Promise<string>;

/** What the daemon's git gives these calls; `createGit` supplies each from the same pinned checkout. */
export interface ChatGitContext<C extends ChatSite> {
  pinned(repo: string): Promise<C>;
  /** Runs `fn` after every earlier locked call for the checkout. */
  lock<T>(repo: string, fn: () => Promise<T>): Promise<T>;
  git: Runner<C>;
  gitDir(c: C): string;
  revParse(c: C, rev: string): Promise<string | null>;
  currentBranch(c: C): Promise<string | null>;
  /** Paths whose content differs from HEAD, untracked ones included; with `only`, those under it. */
  changes(c: C, only?: readonly string[]): Promise<string[]>;
  /** Filters the `.gitattributes` of the commit name. */
  treeFilters(c: C, rev: string): Promise<{ path: string; filter: string }[]>;
  /** Filters the worktree's attributes name for `paths`. */
  worktreeFilters(c: C, paths: readonly string[]): Promise<{ path: string; filter: string }[]>;
  /** The `-c` pins and flags that sign a commit as the builder's own config asks. */
  signing(c: C): Promise<{ config: string[]; flags: string[] }>;
  /** The last trusted value of a config key. */
  configValue(c: C, key: string): Promise<string | null>;
  isAncestor(c: C, ancestor: string, tip: string): Promise<boolean>;
  fetch(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun>;
  moveCheckedOutBranch(input: {
    /** Runs under the repo lock before anything is written; a throw stops the move. */
    readonly beforeWrite?: BeforeWrite;
    readonly repo: string;
    readonly branch: string;
    readonly from: string;
    readonly to: string;
  }): Promise<PullMoved>;
}

/**
 * Run under the repo lock, after the call's own checks and before its first write: the caller's last look at
 * whether the write is still allowed. A throw stops the call with nothing written.
 */
export type BeforeWrite = () => Promise<void>;

/** What moving a checked-out branch answers when it did not move it. */
export type PullMoved =
  | { readonly kind: 'switched' }
  | { readonly kind: 'moved'; readonly found: string | null }
  | { readonly kind: 'dirty'; readonly paths: readonly string[] }
  | { readonly kind: 'gone' }
  | { readonly kind: 'checked_out'; readonly path: string }
  | { readonly kind: 'ignored'; readonly paths: readonly string[] };

/** What a pull did. */
export type PullResult =
  | { readonly kind: 'up_to_date' }
  | { readonly kind: 'ahead' }
  | { readonly kind: 'diverged' }
  | { readonly kind: 'pulled'; readonly from: string; readonly to: string }
  | Exclude<PullMoved, { readonly kind: 'switched' }>;

export interface ChatGit {
  /** Creates `name` at HEAD and points HEAD at it; the files and the index stay as they are. */
  makeBranchHere(repo: string, name: string, beforeWrite?: BeforeWrite): Promise<void>;
  /**
   * Commits `paths` (staged first, so an untracked path counts, and only those: other staged files stay
   * staged), or every change with no paths. Resolves with the new commit.
   */
  commitInFolder(
    repo: string,
    input: {
      readonly message: string;
      readonly paths?: readonly string[];
      /** The session's secret files, absolute; with every `.env*` file, a commit holding one is refused. */
      readonly secretFiles?: readonly string[];
      readonly beforeWrite?: BeforeWrite;
    },
  ): Promise<{ readonly sha: string }>;
  /** Checks out the local branch `name`, keeping changes git can carry, and refusing what it would overwrite. */
  switchBranch(repo: string, name: string, beforeWrite?: BeforeWrite): Promise<void>;
  /** Fetches the branch's upstream and moves the checked-out branch to it when that is a fast-forward. */
  pullFastForward(repo: string, net: NetworkCall, beforeWrite?: BeforeWrite): Promise<PullResult>;
}

/**
 * The paths among `paths` (relative to the checkout, which `roots` name as given and as resolved) that a sandboxed session may not read: a `.env*` file, or
 * one of `secretFiles`. A commit would put them in git's objects, which the session can read.
 */
function secretsAmong(
  roots: readonly string[],
  paths: readonly string[],
  secretFiles: readonly string[],
): string[] {
  const listed = secretFiles.map(foldPathCase);
  return paths.filter(
    (path) =>
      isSecretFileName(basename(path)) ||
      roots.some((root) => {
        const folded = foldPathCase(join(root, path));
        // A listed folder holds everything under it, as the sandbox's read rule for it does.
        return listed.some((secret) => folded === secret || folded.startsWith(`${secret}/`));
      }),
  );
}

function refuseSecrets(secrets: readonly string[]): void {
  if (secrets.length === 0) return;
  throw new InvalidError(
    `${secrets.join(', ')} ${secrets.length === 1 ? 'is a secret file' : 'are secret files'} the session may not read, so ${secrets.length === 1 ? 'it is' : 'they are'} never committed. Add ${secrets.length === 1 ? 'it' : 'them'} to .gitignore, or name the paths to commit.`,
  );
}

const LITERAL = { GIT_LITERAL_PATHSPECS: '1' } as const;
const NO_SUBMODULES = ['-c', 'submodule.recurse=false'] as const;
/**
 * A nested repository's own state is never read: its status would run in a git dir the agent can write. A
 * moved gitlink still shows; only what is dirty inside it is left unread.
 */
const NO_NESTED_STATUS = ['-c', 'diff.ignoreSubmodules=dirty', ...NO_SUBMODULES] as const;

/** Files whose presence in the git dir says an operation is half done. */
const OPERATION_FILES = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
  'BISECT_LOG',
];

/** Git's own words for a refusal, as an error the tool can pass on. */
async function said<T>(run: () => Promise<T>, what: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const detail = error.stderr.trim().split('\n').slice(0, 6).join('\n');
    throw new InvalidError(`${what}: ${detail === '' ? error.message : detail}`);
  }
}

function refuseFilters(found: readonly { path: string; filter: string }[]): void {
  if (found.length === 0) return;
  const named = found
    .slice(0, 5)
    .map((f) => `${f.path} (${f.filter})`)
    .join(', ');
  throw new InvalidError(
    `${named} asks for a filter (Git LFS, for one), which 10db does not run in Your folder. Do this in your own terminal.`,
  );
}

/** A path inside the checkout, as git names it: relative, no `..`, never git state. */
function inFolder(path: string): string {
  const clean = normalize(path).split(sep).join('/');
  if (
    path === '' ||
    path.includes('\0') ||
    isAbsolute(path) ||
    clean === '..' ||
    clean.startsWith('../')
  )
    throw new InvalidError(`${path} is not a path inside Your folder`);
  if (clean.split('/').some(isGitComponent))
    throw new InvalidError(`${path} is git's own state, which a chat never commits`);
  return clean === '.' ? '.' : clean.replace(/\/$/, '');
}

export function createChatGit<C extends ChatSite>(ctx: ChatGitContext<C>): ChatGit {
  function noOperation(c: C): void {
    const dir = ctx.gitDir(c);
    const found = OPERATION_FILES.find((name) => existsSync(join(dir, name)));
    if (found !== undefined)
      throw new InvalidError(
        'A merge, rebase, cherry-pick, revert or bisect is in progress in Your folder; finish or abort it first.',
      );
  }

  async function localBranch(c: C, name: string): Promise<string> {
    // `check-ref-format --branch` also refuses a name that starts with `-`, so it never reads as an option.
    const checked = await said(
      () => ctx.git(c, ['check-ref-format', '--branch', name]),
      `${name} is not a branch name`,
    );
    const branch = checked.trim();
    // `--branch` expands `@{-N}` to the branch the folder was on; a caller's checks read the text it passed.
    if (branch !== name)
      throw new InvalidError(`${name} is a reference git expands (@{), not a branch name`);
    return branch;
  }

  return {
    makeBranchHere(repo, name, beforeWrite) {
      return ctx.lock(repo, async () => {
        const c = await ctx.pinned(repo);
        noOperation(c);
        const branch = await localBranch(c, name);
        await beforeWrite?.();
        const head = await ctx.revParse(c, 'HEAD^{commit}');
        if (head === null) throw new InvalidError('Your folder has no commit to branch from');
        const ref = `refs/heads/${branch}`;
        await said(
          // The zero old value creates the branch only if it does not exist yet.
          () => ctx.git(c, ['update-ref', '--no-deref', ref, head, '0'.repeat(head.length)]),
          `A branch named ${branch} already exists, or the name is not valid`,
        );
        await ctx.git(c, ['symbolic-ref', 'HEAD', ref]);
      });
    },

    async commitInFolder(repo, input) {
      const message = input.message.trim();
      if (message === '') throw new InvalidError('A commit needs a message');
      const named = input.paths?.map(inFolder);
      return await ctx.lock(repo, async () => {
        const c = await ctx.pinned(repo);
        noOperation(c);
        const changed = await ctx.changes(c, named);
        if (changed.length === 0 && named === undefined)
          throw new InvalidError('Nothing has changed');
        await input.beforeWrite?.();
        const secretFiles = input.secretFiles ?? [];
        refuseSecrets(secretsAmong([repo, c.real], changed, secretFiles));
        refuseFilters(await ctx.worktreeFilters(c, changed));
        const sign = await ctx.signing(c);
        const flags = sign.flags.length > 0 ? sign.flags : ['--no-gpg-sign'];
        // Exactly the paths checked above are staged, never a sweep: a file that appeared since is left out.
        await said(
          () =>
            ctx.git(c, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], {
              input: changed.map((path) => `${path}\0`).join(''),
              env: LITERAL,
              config: NO_NESTED_STATUS,
            }),
          'git add failed',
        );
        const staged = (
          await ctx.git(
            c,
            ['diff', '--cached', '--name-only', '-z', ...(named ? ['--', ...named] : [])],
            {
              env: LITERAL,
              config: NO_NESTED_STATUS,
            },
          )
        )
          .split('\0')
          .filter(Boolean);
        if (staged.length === 0) throw new InvalidError('Nothing has changed there');
        refuseSecrets(secretsAmong([repo, c.real], staged, secretFiles));
        await said(
          () =>
            ctx.git(
              c,
              [
                'commit',
                ...(named === undefined ? [] : ['--only']),
                '-F',
                '-',
                ...flags,
                ...(named === undefined ? [] : ['--', ...named]),
              ],
              {
                input: `${message}\n`,
                env: LITERAL,
                config: [...NO_NESTED_STATUS, ...sign.config],
              },
            ),
          'git commit failed',
        );
        const sha = await ctx.revParse(c, 'HEAD^{commit}');
        if (sha === null) throw new InvalidError('The commit left HEAD without a commit');
        return { sha };
      });
    },

    switchBranch(repo, name, beforeWrite) {
      return ctx.lock(repo, async () => {
        const c = await ctx.pinned(repo);
        noOperation(c);
        const branch = await localBranch(c, name);
        await beforeWrite?.();
        const tip = await ctx.revParse(c, `refs/heads/${branch}^{commit}`);
        if (tip === null) throw new InvalidError(`There is no local branch named ${branch}`);
        if ((await ctx.currentBranch(c)) === branch) return;
        refuseFilters(await ctx.treeFilters(c, tip));
        await said(
          () =>
            ctx.git(c, ['switch', '--no-guess', '--no-recurse-submodules', '--', branch], {
              config: NO_NESTED_STATUS,
            }),
          `Git could not switch to ${branch}`,
        );
      });
    },

    async pullFastForward(repo, net, beforeWrite) {
      const first = await ctx.pinned(repo);
      const branch = await ctx.currentBranch(first);
      if (branch === null) throw new InvalidError('Your folder is on no branch (a detached HEAD)');
      const remote = await ctx.configValue(first, `branch.${branch}.remote`);
      const merge = await ctx.configValue(first, `branch.${branch}.merge`);
      if (remote !== 'origin' || !merge?.startsWith('refs/heads/'))
        throw new InvalidError(`${branch} has no upstream on origin to pull from`);
      const upstream = merge.slice('refs/heads/'.length);
      await ctx.fetch(repo, upstream, net);
      // The branch moves by compare-and-swap on `from` under the repo lock, so what is read here may go stale.
      const c = await ctx.pinned(repo);
      noOperation(c);
      if ((await ctx.currentBranch(c)) !== branch)
        throw new InvalidError('Your folder moved to another branch while the pull fetched');
      const from = await ctx.revParse(c, `refs/heads/${branch}^{commit}`);
      const to = await ctx.revParse(c, `refs/remotes/origin/${upstream}^{commit}`);
      if (from === null || to === null)
        throw new InvalidError(`${upstream} could not be read after the fetch`);
      if (from === to) return { kind: 'up_to_date' };
      if (await ctx.isAncestor(c, to, from)) return { kind: 'ahead' };
      if (!(await ctx.isAncestor(c, from, to))) return { kind: 'diverged' };
      refuseFilters(await ctx.treeFilters(c, to));
      const moved = await ctx.moveCheckedOutBranch({
        repo,
        branch,
        from,
        to,
        ...(beforeWrite === undefined ? {} : { beforeWrite }),
      });
      return moved.kind === 'switched' ? { kind: 'pulled', from, to } : moved;
    },
  };
}
