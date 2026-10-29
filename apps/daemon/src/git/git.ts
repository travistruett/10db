import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { realPathOf, resolveInRepo } from '../guard';
import { memoryPinStore, type CheckoutPin, type PinStore } from './checkout-pin';
import {
  checkoutIdentity,
  refusedCheckoutKeys,
  trustedValues,
  type ConfigRoots,
} from './checkout-trust';
import { parseScopedConfig, type ConfigEntry } from './config-trust';
import { equalOrUnder, insideAny, isPlainDirectory, samePath, surelyInside } from './lane-writable';
import { branchOfRef, firstLine, parseBranches, type RepoFacts, type RepoRefusal } from './inspect';
import { comparablePath, entryAt, existsAsEntry, foldedName, sameEntry } from './path-entries';
import { gitNetwork, type NetworkCall, type NetworkRun } from './network';
import { localRemotePath, parseRemoteUrl } from './remote-url';
import { GitError, runGit, runGitCapped, type RunOptions } from './run';
import { GitTrustError, GitTrustFailure, type GitTrustDetail } from './trust-error';
import { embeddedRepository, GitMode, isGitComponent } from './worktree-files';
import { lockedBatchId, parseWorktreeList, type WorktreeEntry } from './worktree-list';

const OP_TRAILER = '10db-Op';
const OP_SEARCH_DEPTH = 200;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/**
 * Config on every daemon git call beside `DAEMON_GIT_CONFIG`: no attributes file, git's own checks on
 * paths that would be `.git` on HFS+ or NTFS, and no submodule recursion.
 */
const NO_ATTRIBUTES: readonly string[] = [
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.protectHFS=true',
  '-c',
  'core.protectNTFS=true',
  '-c',
  'submodule.recurse=false',
];

/** `removeWorktree` was asked to remove a path that is not a worktree 10db made. */
export class WorktreeNotOursError extends Error {
  override readonly name = 'WorktreeNotOursError';
  readonly path: string;
  /** Why it is not one, as the builder reads it. */
  readonly why: string;
  /**
   * True when git lists the worktree as 10db's but its git dir is one 10db won't read through, so
   * `removeWorktree` would still remove what it holds.
   */
  readonly unreadable: boolean;
  constructor(path: string, why: string, unreadable = false) {
    super(`10db won't remove ${path}: ${why}`);
    this.path = path;
    this.why = why;
    this.unreadable = unreadable;
  }
}

export interface AddWorktreeInput {
  readonly repo: string;
  readonly path: string;
  readonly branch: string;
  /** Create `branch` here (CAS from nothing); null when it already exists (a Retry). */
  readonly startPoint: string | null;
  readonly lockReason: string;
}

/** What changed between a commit and HEAD: the diff text, cut at a byte cap, and every file's counts. */
export interface DiffSince {
  readonly diff: string;
  /** True when the diff was longer than the cap and was cut. */
  readonly truncated: boolean;
  /** Lines added and removed per file; both null for a binary file. */
  readonly files: readonly {
    readonly path: string;
    readonly added: number | null;
    readonly removed: number | null;
  }[];
}

/** What `fileAt` found at a path of a commit. */
export type FileAt =
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'missing' }
  /** A link, a submodule, a directory: anything but a regular file's blob. */
  | { readonly kind: 'not_regular'; readonly mode: string }
  | { readonly kind: 'too_large'; readonly bytes: number };

/** What `mergeIntoBranch` did; `from` is the commit it was asked to bring in. */
export type BranchMerge =
  /** The branch already holds `from`; nothing moved. */
  | { readonly kind: 'up_to_date'; readonly from: string }
  /** The branch and its files moved to `head`; `paths` are the files that changed. */
  | {
      readonly kind: 'merged';
      readonly from: string;
      readonly head: string;
      /** True when the branch had nothing of its own and now names `from` itself. */
      readonly fastForward: boolean;
      readonly paths: readonly string[];
    }
  /** Both sides changed these files in ways git can't combine; nothing was written. */
  | { readonly kind: 'conflict'; readonly from: string; readonly paths: readonly string[] }
  /**
   * Files lie where the merge would write, so nothing was written: `changed` are uncommitted changes
   * and untracked files git reports at paths it writes; `kept` are files git doesn't track (ignored
   * ones, or a whole directory, shown with its `/`) at a path the merge adds, or where it needs a
   * directory. read-tree treats an ignored file as disposable; a hand-made `.env` is not.
   */
  | {
      readonly kind: 'blocked';
      readonly from: string;
      readonly changed: readonly string[];
      readonly kept: readonly string[];
    };

/** Where `mergedCommit` keeps the commits it makes reachable. */
const KEPT_REF_PREFIX = 'refs/10db/';

export interface MergedCommitInput {
  readonly repo: string;
  readonly ours: string;
  readonly theirs: string;
  /** A ref under `refs/10db/` that keeps the commit reachable; it is set, whatever it held. */
  readonly ref: string;
  readonly message: string;
}

export interface MergeIntoBranchInput {
  /** The checkout that has `branch` checked out. */
  readonly repo: string;
  readonly branch: string;
  /** The commit to bring in, such as `refs/remotes/origin/main`. */
  readonly from: string;
  /** The merge commit's message. */
  readonly message: string;
}

/** The modes git stores a regular file with. */
const REGULAR_FILE_MODES: readonly string[] = ['100644', '100755'];

/** One `ls-tree --long -z` entry: mode, type, object, size (`-` for a tree), then the path. */
const LS_TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/;

/** Where a checkout's HEAD was: on `branch` at `sha`, or detached at `sha` when `branch` is null. */
export interface CheckoutPlace {
  readonly branch: string | null;
  readonly sha: string;
}

/** What `switchBack` did. Every answer but `switched` left the checkout exactly as it found it. */
export type SwitchBack =
  | { readonly kind: 'switched' }
  /** HEAD is no longer on the branch the switch back expected; `found` is where it is (null: detached). */
  | { readonly kind: 'moved'; readonly found: string | null }
  /** Uncommitted changes, or untracked files git doesn't ignore. */
  | { readonly kind: 'dirty'; readonly paths: readonly string[] }
  /** The branch, or the detached commit, to go back to no longer exists. */
  | { readonly kind: 'gone' }
  /** The branch is checked out in the worktree at `path`, so git won't check it out here too. */
  | { readonly kind: 'checked_out'; readonly path: string }
  /** Ignored files or directories (ending in `/`) where the switch would write. */
  | { readonly kind: 'ignored'; readonly paths: readonly string[] };

export interface Git {
  /** The branch HEAD names; null when HEAD is detached. */
  currentBranch(repo: string): Promise<string | null>;
  /** The URL of remote `name`; null when the repository has no such remote. */
  remoteUrl(repo: string, name: string): Promise<string | null>;
  /**
   * origin's push URL as pinned with the checkout, in its parsed form, after checking origin's push
   * URL is still that one. One added or changed since is refused with a card offering it for trust.
   */
  pinnedPushUrl(repo: string): Promise<string>;
  /** Updates `origin/<branch>` from origin's recorded fetch URL; the checkout is untouched. */
  fetch(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun>;
  /**
   * Creates `name` at `startPoint` and checks it out, with no upstream. Resolves with where HEAD was
   * just before, read under the same lock, or null when HEAD named no commit.
   */
  switchNewBranch(repo: string, name: string, startPoint: string): Promise<CheckoutPlace | null>;
  /**
   * Moves the checkout from branch `from` back to `to`, only while HEAD is still on `from` and
   * nothing in the checkout is uncommitted; otherwise it is left as it is and the answer says why.
   * A branch is checked out at its current tip; a detached place at its commit.
   */
  switchBack(repo: string, from: string, to: CheckoutPlace): Promise<SwitchBack>;
  /**
   * Pushes `branch` to the same name at origin's recorded push URL, never forced, and records it as
   * the branch's upstream. Resolves with how long the push ran and what it printed.
   */
  push(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun>;
  head(repo: string): Promise<string>;
  /**
   * The repository's own git dir and its common dir, both absolute and real. They are the same
   * directory except in a linked worktree, whose common dir is the main repository's.
   */
  gitDirs(repo: string): Promise<{ gitDir: string; commonDir: string }>;
  /**
   * Paths whose worktree content differs from HEAD, and untracked paths git doesn't ignore, sorted.
   * With `only`, just those of `only`. Read without running git's status: no filter, fsmonitor or
   * submodule runs.
   */
  changedPaths(repo: string, only?: readonly string[]): Promise<string[]>;
  /** Committed and uncommitted changes since `base`, sorted and unique. */
  changedFilesSince(repo: string, base: string): Promise<string[]>;
  /** Files whose committed content differs between `base` and `tip`, sorted; nothing uncommitted. */
  filesChangedBetween(repo: string, base: string, tip: string): Promise<string[]>;
  /**
   * Commits on `tip` (HEAD unless named) since `base`, oldest first, following first parents: a merge
   * that brought another branch in is listed, the commits it brought are not.
   */
  commitsSince(repo: string, base: string, tip?: string): Promise<string[]>;
  /** Filters the tree at `rev`, or the checkout's own attributes, ask for; empty when none. */
  filtersIn(repo: string, rev: string): Promise<{ path: string; filter: string }[]>;
  /**
   * Commits `paths` on `branch` without touching HEAD: the tree is the branch's tip with those
   * paths as the worktree has them, and the branch moves only if nothing moved it meanwhile.
   */
  commit(input: {
    repo: string;
    paths: readonly string[];
    message: string;
    opId: string;
    branch: string;
  }): Promise<{ sha: string; alreadyCommitted: boolean }>;
  /**
   * Brings commit `from` into `branch`, which `repo` must have checked out, running nothing from the
   * repository: up to date when the branch holds it, a fast-forward when the branch has nothing of
   * its own, else a merge commit with the branch as first parent, made from `merge-tree`'s tree with
   * no attributes, so no merge driver runs. The files follow through `read-tree -m -u`, which keeps
   * uncommitted changes elsewhere. A conflict, or a change in the way, writes nothing. A base whose
   * tree asks for a filter is refused, as a push of it would be.
   */
  mergeIntoBranch(input: MergeIntoBranchInput): Promise<BranchMerge>;
  /**
   * The commit that merges `theirs` into `ours`, as `mergeIntoBranch` would make it but unsigned and
   * kept reachable at `ref` alone: no file, index, HEAD or branch is touched. `ours` when it already
   * holds `theirs`, `theirs` when `ours` is in its history (both recording nothing), and null on a
   * conflict.
   */
  mergedCommit(input: MergedCommitInput): Promise<string | null>;
  /** The refs under `prefix`, itself under `refs/10db/`, by full name and sorted. */
  keptRefs(repo: string, prefix: string): Promise<string[]>;
  /** Deletes `ref`, under `refs/10db/`, whatever it names; one already gone is no error. */
  deleteKeptRef(repo: string, ref: string): Promise<void>;
  /** True when commit `ancestor` is in the history of `tip`, `tip` itself included. */
  isAncestor(repo: string, ancestor: string, tip: string): Promise<boolean>;
  /** The blob `path` holds in commit `rev`, read from the object store; null for anything else. */
  blobAt(repo: string, rev: string, path: string): Promise<string | null>;
  /**
   * Pins `candidate`, the state a refusal card showed the builder, if the checkout still matches it;
   * otherwise refuses again with what it found. The builder's choice only.
   */
  retrust(repo: string, candidate: CheckoutPin): Promise<void>;
  /**
   * Makes a locked worktree of `repo` at `input.path` (under the worktree root) on `input.branch`,
   * pins it, and fills it from the branch with no hook or filter. Resolves with the worktree's HEAD.
   * The main checkout's HEAD, index and files are not touched. On failure nothing is left behind.
   */
  addWorktree(input: AddWorktreeInput): Promise<string>;
  /**
   * Removes a 10db worktree of `repo` at `path` and its pin; 'absent' when git lists none and
   * nothing is there. Anything else at `path`, or a path outside the worktree root, is refused.
   */
  removeWorktree(repo: string, path: string): Promise<'removed' | 'absent'>;
  listWorktrees(repo: string): Promise<WorktreeEntry[]>;
  /**
   * Uncommitted changes in the 10db worktree of `repo` at `path`, read through `repo`'s pin, so a
   * worktree no batch names (and so with no pin of its own) can be read. The worktree must be a
   * directory under the worktree root, listed by git, locked by 10db, with its git dir inside
   * `repo`'s worktrees; anything else is refused with `WorktreeNotOursError`.
   */
  worktreeChanges(repo: string, path: string): Promise<string[]>;
  /**
   * The git-ignored files of the 10db worktree of `repo` at `path`, checked as `worktreeChanges`
   * checks it: each file outside a directory the ignore rules match, such as a hand-made `.env`, and
   * none inside one, such as `node_modules/` or `dist/`.
   */
  worktreeIgnoredFiles(repo: string, path: string): Promise<string[]>;
  /** Drops the entries of worktrees whose directory is gone, but not a locked one. */
  pruneWorktrees(repo: string): Promise<void>;
  /** `update-ref -d refs/heads/<branch> <sha>`: true when deleted, false when missing or moved. */
  deleteBranchIfAt(repo: string, branch: string, sha: string): Promise<boolean>;
  /** Ignored directories of the checkout, top-level and nested, without the trailing `/`. */
  ignoredDirectories(repo: string): Promise<string[]>;
  /**
   * The unified diff from `base` to `head`, read with no external diff program and no textconv
   * filter, cut to at most `maxBytes` of UTF-8 on a character boundary, plus the per-file counts
   * of the whole change. Renames are shown as a delete and an add.
   */
  diffSince(repo: string, base: string, head: string, maxBytes: number): Promise<DiffSince>;
  /**
   * The text of `path` in commit `rev`, read from the object store, never from the worktree, so no
   * link is followed: a path that is a link, or lies under one, is `not_regular` or `missing`. A
   * blob over `maxBytes` is not read.
   */
  fileAt(repo: string, rev: string, path: string, maxBytes: number): Promise<FileAt>;
  /**
   * What the repository at or above `path` holds, read as git finds it with no pin: nothing is
   * written, nothing is pinned and no refusal reaches `onRefused`, so a folder the builder only
   * looks at raises no card. A repository git won't read is answered, not thrown.
   */
  inspect(path: string): Promise<RepoFacts | RepoRefusal>;
}

export interface GitOptions {
  /** Called with every refusal, so the builder hears of it whoever called. */
  onRefused?(error: GitTrustError): void;
  /** Where pins persist; the default lasts as long as this `Git`. */
  pins?: PinStore;
  /** The git to run for every call, as `resolveGit` found it; `git` on PATH otherwise. */
  bin?: string;
  /** Every registered project's checkout, read when it is needed: a lane in any of them can write it. */
  checkouts?: () => readonly string[];
  /** Directories a lane can write besides the checkouts, such as the lane temp root. */
  laneRoots?: readonly string[];
  /**
   * Where 10db makes worktrees. Git refuses a path at or under it that holds no worktree 10db made,
   * and only paths under it are added or removed as worktrees.
   */
  worktreeRoot?: string;
}

/** Where a git call works: the checkout's real path and the variables that point git at its git dir. */
interface Site {
  readonly real: string;
  readonly env: Readonly<Record<string, string>>;
}

/** A checkout after its pin check, held for one operation: git runs in the pinned git dir. */
interface Pinned extends Site {
  readonly dirs: { readonly gitDir: string; readonly commonDir: string };
  readonly pin: CheckoutPin;
}

/** A checkout as git finds it on its own, for reading what it is now, before or beside its pin. */
const observed = (real: string): Site => ({ real, env: {} });

/** `entries` as `GIT_CONFIG_COUNT` and its pairs, which keep a key holding `=` whole, unlike `-c`. */
function configEnv(entries: readonly (readonly [string, string])[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${String(i)}`] = key;
    env[`GIT_CONFIG_VALUE_${String(i)}`] = value;
  });
  return env;
}

/** Lexical checks first, then the guard's symlink-aware check, so `link/x` can't commit outside the repo. */
function checkPaths(repo: string, paths: readonly string[]): string[] {
  return paths.map((p) => {
    const clean = normalize(p);
    const lexicallyBad =
      p === '' || isAbsolute(p) || clean === '.' || clean === '..' || clean.startsWith(`..${sep}`);
    if (lexicallyBad || !resolveInRepo(repo, clean).inside) {
      throw new InvalidError(
        `Path ${JSON.stringify(p)} must be relative and inside the repository`,
      );
    }
    return clean;
  });
}

/** `message` with the op trailer, joined to a trailer block the message already ends with. */
export function withOpTrailer(message: string, opId: string): string {
  const body = message.replace(/\s+$/, '');
  const paragraphs = body.split(/\n[ \t]*\n/);
  const last = paragraphs.at(-1) ?? '';
  const endsInTrailers =
    paragraphs.length > 1 && last.split('\n').every((line) => /^[A-Za-z0-9-]+: \S/.test(line));
  return `${body}${endsInTrailers ? '\n' : '\n\n'}${OP_TRAILER}: ${opId}\n`;
}

function isTrue(value: string | null | undefined): boolean {
  return value === null || ['true', 'yes', 'on', '1'].includes((value ?? '').toLowerCase());
}

/**
 * The options of a diff the builder reads: `diff-tree`, which is plumbing and so ignores the UI
 * settings (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`, `diff.context`, `diff.orderFile`,
 * `diff.submodule`), and every option those would set spelled out anyway. A submodule is shown as its
 * gitlink bump, so no diff is run inside one; no external diff program and no textconv filter runs.
 */
const DIFF_FLAGS: readonly string[] = [
  '-r',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--no-color',
  '--src-prefix=a/',
  '--dst-prefix=b/',
  '--submodule=short',
  '--ignore-submodules=none',
];

/** Config a diff reads whatever plumbing is: how a path with unusual bytes is quoted. */
const DIFF_CONFIG: readonly string[] = ['-c', 'core.quotePath=true'];

/** The most bytes one UTF-8 character takes. */
const UTF8_MAX_BYTES = 4;

/** `bytes` cut to at most `maxBytes` of UTF-8, never inside a multi-byte character. */
function cutDiff(bytes: Buffer, maxBytes: number): { diff: string; truncated: boolean } {
  if (bytes.length <= maxBytes) return { diff: bytes.toString('utf8'), truncated: false };
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at the cut belongs to a character that starts before it.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return { diff: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** `diff --numstat -z --no-renames` output: `added TAB removed TAB path NUL` per file, `-` for binary. */
function parseNumstat(out: string): DiffSince['files'][number][] {
  return out
    .split('\0')
    .filter(Boolean)
    .flatMap((record) => {
      const match = /^(\d+|-)\t(\d+|-)\t([^]*)$/.exec(record);
      if (!match) return [];
      const [, added = '-', removed = '-', path = ''] = match;
      return [
        {
          path,
          added: added === '-' ? null : Number(added),
          removed: removed === '-' ? null : Number(removed),
        },
      ];
    });
}

/** `ls-tree -r -z` output as entries. */
function parseTree(out: string): { mode: string; oid: string; path: string }[] {
  return out
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode = '', , oid = ''] = record.slice(0, tab).split(' ');
      return { mode, oid, path: record.slice(tab + 1) };
    });
}

/** `filter=<name>` settings in one attributes file's text. */
function filtersInAttributes(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    for (const token of trimmed.split(/\s+/).slice(1)) {
      const match = /^filter=(.+)$/.exec(token);
      if (match?.[1]) names.push(match[1]);
    }
  }
  return names;
}

/** True when the `commondir` file in a linked worktree's git dir resolves to `commonDir`. */
function namesCommonDir(gitDir: string, commonDir: string): boolean {
  const named = readIfPresent(join(gitDir, 'commondir')).trim();
  if (named === '') return false;
  try {
    return samePath(realpathSync(resolve(gitDir, named)), commonDir);
  } catch {
    return false;
  }
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The daemon's git (lane sandbox spec D13). It never runs a filter, an attribute-selected driver,
 * fsmonitor, a hook or a submodule's git in the working tree: commits are plumbing over a private
 * index, changes are found by hashing files the daemon reads itself, every call passes
 * `DAEMON_GIT_CONFIG` and a cleaned environment, and the one checkout it makes (a batch's new
 * branch) reads no attributes from the tree. Every call first checks that the checkout's git dirs
 * are the ones pinned for it and that it borrows no objects. Fetch and push go only to the URLs
 * pinned with it, with the builder's own transport config.
 */
export function createGit(opts: GitOptions = {}): Git {
  const locks = new Map<string, Promise<unknown>>();
  // Fetches of one checkout run one at a time, apart from its commits: two at once would race for
  // the same remote-tracking ref ("cannot lock ref"), and a fetch must not hold up a lane's commit.
  const fetches = new Map<string, Promise<unknown>>();
  const pins = opts.pins ?? memoryPinStore();
  const bin = opts.bin ?? 'git';

  function refusal(repo: string, detail: GitTrustDetail): GitTrustError {
    const error = new GitTrustError(repo, detail);
    opts.onRefused?.(error);
    return error;
  }

  /** Runs `fn` after every earlier call under `key` in `held` has settled. */
  function serialized<T>(
    held: Map<string, Promise<unknown>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = held.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    held.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Runs `fn` after every earlier locked call for the same checkout has settled. */
  function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    return serialized(locks, repo, fn);
  }

  /** Each checkout's empty tree, as an attribute source that gives git no attributes at all. */
  const emptyTrees = new Map<string, string>();
  async function emptyTree(site: Site): Promise<string> {
    const known = emptyTrees.get(site.real);
    if (known) return known;
    const oid = (
      await runGit(site.real, ['hash-object', '-t', 'tree', '--stdin'], { env: site.env, bin })
    ).trim();
    emptyTrees.set(site.real, oid);
    return oid;
  }

  /**
   * Every daemon git call reads no attributes, from the tree, the worktree or an attributes file, so
   * no filter, driver or line-ending conversion is selected whatever config names. Paths are checked
   * as git does on HFS+ and NTFS, and no submodule is recursed into. Once a checkout is pinned, git
   * runs in the pinned git dir with the checkout as its work tree, so it never reads the `.git`
   * gitfile again, which a lane could swap between two calls.
   */
  async function git(site: Site, args: readonly string[], run: Omit<RunOptions, 'bin'> = {}) {
    return runGit(site.real, args, {
      ...run,
      bin,
      env: { ...site.env, GIT_ATTR_SOURCE: await emptyTree(site), ...run.env },
      config: [...NO_ATTRIBUTES, ...(run.config ?? [])],
    });
  }

  /** `git`, but stdout is cut at `capBytes` and the call killed once it has printed them. */
  async function gitCapped(
    site: Site,
    args: readonly string[],
    capBytes: number,
    run: Omit<RunOptions, 'bin'> = {},
  ): Promise<Buffer> {
    return runGitCapped(
      site.real,
      args,
      {
        ...run,
        bin,
        env: { ...site.env, GIT_ATTR_SOURCE: await emptyTree(site), ...run.env },
        config: [...NO_ATTRIBUTES, ...(run.config ?? [])],
      },
      capBytes,
    );
  }

  async function readGitDirs(real: string): Promise<{ gitDir: string; commonDir: string }> {
    // Without --path-format a common dir is printed relative to the working directory.
    const out = await git(observed(real), [
      'rev-parse',
      '--absolute-git-dir',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const [gitDir = '', commonDir = ''] = out.split('\n');
    if (!isAbsolute(gitDir) || !isAbsolute(commonDir)) {
      throw new GitError(['rev-parse'], 'git named no absolute git dirs', null);
    }
    return { gitDir: realpathSync(gitDir), commonDir: realpathSync(commonDir) };
  }

  /** origin's URL as git would use it, credentials and all; null when there is no origin. */
  async function originUrl(site: Site, push: boolean): Promise<string | null> {
    try {
      const out = await git(site, ['remote', 'get-url', ...(push ? ['--push'] : []), 'origin']);
      return out.trim();
    } catch (error) {
      if (error instanceof GitError && /no such remote/i.test(error.stderr)) return null;
      throw error;
    }
  }

  /**
   * origin's URL as pins hold it: the parsed form, or null when there is no origin or its URL is
   * one the daemon refuses (credentials in it, or anything that doesn't parse cleanly).
   */
  async function pinnableUrl(site: Site, push: boolean): Promise<string | null> {
    const url = await originUrl(site, push);
    if (url === null) return null;
    const parsed = parseRemoteUrl(url);
    return parsed.ok ? parsed.url : null;
  }

  /** The checkout as it is now, in the shape of a pin. */
  async function observe(real: string): Promise<CheckoutPin> {
    const dirs = await readGitDirs(real);
    return {
      ...dirs,
      id: checkoutIdentity(dirs),
      fetchUrl: await pinnableUrl(observed(real), false),
      pushUrl: await pinnableUrl(observed(real), true),
    };
  }

  /** A refusal for a checkout that differs from `pin` in its git dirs or origin. */
  function mismatch(real: string, pin: CheckoutPin, now: CheckoutPin): GitTrustError {
    if (now.id !== pin.id || now.gitDir !== pin.gitDir || now.commonDir !== pin.commonDir)
      return refusal(real, {
        kind: GitTrustFailure.Moved,
        pinned: pin.gitDir,
        found: now.gitDir,
        candidate: now,
      });
    const direction = now.fetchUrl === pin.fetchUrl ? 'push' : 'fetch';
    return refusal(real, {
      kind: GitTrustFailure.Origin,
      direction,
      pinned: direction === 'fetch' ? pin.fetchUrl : pin.pushUrl,
      found: direction === 'fetch' ? now.fetchUrl : now.pushUrl,
      candidate: now,
    });
  }

  /**
   * The checkout's real path, git dirs and pin, after checking they match the pin (recorded now when
   * there is none), that the object store borrows from no other repository, and that no attributes
   * file sits in the git dirs, where the attribute source can't switch it off.
   */
  async function pinned(repo: string): Promise<Pinned> {
    const real = realpathSync(repo);
    const dirs = await readGitDirs(real);
    const id = checkoutIdentity(dirs);
    // Read once per operation: every later call in it runs against this pin.
    let pin = pins.get(real);
    if (!pin && opts.worktreeRoot && surelyInside(real, opts.worktreeRoot)) {
      throw refusal(real, { kind: GitTrustFailure.Unpinned });
    }
    if (!pin) {
      const writable = writableGitDir(real, dirs);
      if (writable !== null)
        throw refusal(real, { kind: GitTrustFailure.Writable, gitDir: writable });
      pin = {
        ...dirs,
        id,
        fetchUrl: await pinnableUrl(observed(real), false),
        pushUrl: await pinnableUrl(observed(real), true),
      };
      pins.set(real, pin);
    } else if (pin.id !== id || pin.gitDir !== dirs.gitDir || pin.commonDir !== dirs.commonDir) {
      throw mismatch(real, pin, await observe(real));
    }
    for (const name of ['alternates', 'http-alternates']) {
      const file = join(dirs.commonDir, 'objects', 'info', name);
      if (readIfPresent(file).trim() !== '')
        throw refusal(real, { kind: GitTrustFailure.Alternates, file });
    }
    for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
      const file = join(dir, 'info', 'attributes');
      if (readIfPresent(file).trim() !== '')
        throw refusal(real, { kind: GitTrustFailure.Attributes, file });
    }
    return { real, dirs, pin, env: { GIT_DIR: pin.gitDir, GIT_WORK_TREE: real } };
  }

  /** The checkout's config as git reads it; with `login`, as a fetch or push in that environment would. */
  async function configEntries(
    c: Pinned,
    login?: Readonly<Record<string, string>>,
  ): Promise<ConfigEntry[]> {
    return parseScopedConfig(
      await git(c, ['config', '--list', '--show-scope', '--show-origin', '-z'], {
        ...(login ? { login } : {}),
      }),
    );
  }

  async function currentBranch(c: Pinned): Promise<string | null> {
    try {
      const ref = (await git(c, ['symbolic-ref', '-q', 'HEAD'])).trim();
      return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return null;
      throw error;
    }
  }

  async function revParse(c: Pinned, rev: string): Promise<string | null> {
    try {
      const oid = (await git(c, ['rev-parse', '--verify', '-q', rev])).trim();
      return OBJECT_ID.test(oid) ? oid : null;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return null;
      throw error;
    }
  }

  /** Runs `fn` with a private index file seeded from `tip` (empty when null), removed afterwards. */
  async function withPrivateIndex<T>(
    c: Pinned,
    tip: string | null,
    fn: (env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string }) => Promise<T>,
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), '10db-index-'));
    const env = { GIT_INDEX_FILE: join(dir, 'index'), GIT_LITERAL_PATHSPECS: '1' };
    try {
      await git(c, tip === null ? ['read-tree', '--empty'] : ['read-tree', tip], { env });
      return await fn(env);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function changes(c: Pinned, only?: readonly string[]): Promise<string[]> {
    if (only?.length === 0) return [];
    const tip = await revParse(c, 'HEAD^{commit}');
    // Against a private index seeded from HEAD, so the checkout's own index is never refreshed, and
    // with no attributes, so git compares bytes as they are.
    const out = await withPrivateIndex(c, tip, (env) =>
      git(
        c,
        [
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
          '--ignore-submodules=all',
          '--no-renames',
          '--',
          ...(only ?? []),
        ],
        { env },
      ),
    );
    const paths = out
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3));
    return [...new Set(paths)].sort();
  }

  async function findCommitByOp(c: Pinned, tip: string, opId: string): Promise<string | null> {
    const out = await git(c, [
      'log',
      '--no-show-signature',
      // The branch's own line: a base merged in can carry the trailers of the lane commits a
      // squash-merged pull request folded in.
      '--first-parent',
      '-n',
      String(OP_SEARCH_DEPTH),
      `--format=%H%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`,
      tip,
    ]);
    for (const record of out.split('\x1e')) {
      const [sha, ops] = record.trim().split('\x1f');
      if (
        sha &&
        OBJECT_ID.test(sha) &&
        ops
          ?.split(',')
          .map((o) => o.trim())
          .includes(opId)
      ) {
        return sha;
      }
    }
    return null;
  }

  /** `-c` pins and flags that sign a commit only as the builder's own config says. */
  function signing(
    c: Pinned,
    entries: readonly ConfigEntry[],
  ): { config: string[]; flags: string[] } {
    const last = (key: string): string | null | undefined =>
      trustedValues(configRoots(c), entries, key).at(-1);
    if (!isTrue(last('commit.gpgsign') ?? 'false')) return { config: [], flags: [] };
    // Every program signing could run comes from the builder's config or git's default, never
    // from a file a lane could have written.
    const pinnedKeys: [string, string][] = [
      ['gpg.format', last('gpg.format') ?? 'openpgp'],
      ['gpg.program', last('gpg.program') ?? 'gpg'],
      ['gpg.openpgp.program', last('gpg.openpgp.program') ?? last('gpg.program') ?? 'gpg'],
      ['gpg.x509.program', last('gpg.x509.program') ?? 'gpgsm'],
      ['gpg.ssh.program', last('gpg.ssh.program') ?? 'ssh-keygen'],
      ['gpg.ssh.defaultKeyCommand', last('gpg.ssh.defaultkeycommand') ?? 'false'],
    ];
    const key = last('user.signingkey');
    return {
      config: pinnedKeys.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
      flags: [key ? `-S${key}` : '-S'],
    };
  }

  /**
   * Paths whose worktree attributes ask for a filter. The commit stores bytes as they are, which for
   * such a path (a Git LFS file, say) is not what the repository expects, so it is refused. Reading
   * attributes runs no program; this is the one call that reads them, so it leaves `GIT_ATTR_SOURCE`
   * unset. It still runs the resolved git in the pinned git dir, against the commit's private index.
   */
  async function filteredPaths(
    c: Pinned,
    index: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    paths: readonly string[],
  ): Promise<{ path: string; filter: string }[]> {
    if (paths.length === 0) return [];
    const out = await runGit(c.real, ['check-attr', '-z', '--stdin', 'filter'], {
      bin,
      input: `${paths.join('\0')}\0`,
      env: { ...c.env, ...index },
      config: [...NO_ATTRIBUTES],
    });
    const fields = out.split('\0');
    const found: { path: string; filter: string }[] = [];
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const value = fields[i + 2] ?? '';
      if (!['unspecified', 'unset'].includes(value))
        found.push({ path: fields[i] ?? '', filter: value });
    }
    return found;
  }

  async function filters(c: Pinned, rev: string): Promise<{ path: string; filter: string }[]> {
    const found: { path: string; filter: string }[] = [];
    const tip = await revParse(c, `${rev}^{commit}`);
    if (tip) {
      for (const entry of parseTree(await git(c, ['ls-tree', '-r', '-z', '--full-tree', tip]))) {
        if (posix.basename(entry.path) !== '.gitattributes' || entry.mode === GitMode.Gitlink)
          continue;
        const text = await git(c, ['cat-file', 'blob', entry.oid]);
        for (const filter of filtersInAttributes(text)) found.push({ path: entry.path, filter });
      }
    }
    return found;
  }

  /**
   * The config a fetch or push runs with, read as git in the login environment reads it: the
   * allowlist checked, transport programs pinned as `-c` arguments, and credential helpers in `env`.
   */
  async function networkConfig(
    c: Pinned,
    net: NetworkCall,
  ): Promise<{ config: string[]; env: Record<string, string> }> {
    const entries = await configEntries(c, net.env);
    const keys = refusedCheckoutKeys(configRoots(c), entries);
    if (keys.length > 0) throw refusal(c.real, { kind: GitTrustFailure.Config, keys });
    const trusted = (key: string) => trustedValues(configRoots(c), entries, key);
    // Every helper the builder's own config names, the login environment's included, URL-scoped
    // ones (`gh auth setup-git`'s) too, in git's order, each under its own key.
    const helpers = entries.flatMap((entry): [string, string][] =>
      /^credential\.(.+\.)?helper$/i.test(entry.name) &&
      entry.value !== null &&
      trustedValues(configRoots(c), [entry], entry.name).length > 0
        ? [[entry.name, entry.value]]
        : [],
    );
    return {
      config: [
        ...NO_ATTRIBUTES,
        '-c',
        `core.sshCommand=${trusted('core.sshcommand').at(-1) ?? 'ssh'}`,
        '-c',
        `core.askPass=${trusted('core.askpass').at(-1) ?? ''}`,
        '-c',
        'protocol.ext.allow=never',
      ],
      // Through the environment, which git reads before any `-c`: an empty helper first resets the
      // list, URL-scoped helpers included, then only the builder's own helpers follow. A key there
      // stays whole even when a URL in it holds `=`.
      env: configEnv([['credential.helper', ''], ...helpers]),
    };
  }

  /** Where a lane can write: every registered checkout, this one included, and the lane temp roots. */
  function laneWritableRoots(real: string): string[] {
    return [real, ...(opts.checkouts?.() ?? []), ...(opts.laneRoots ?? [])];
  }

  /** Where a config file a lane could have written lies: every lane-writable root and the git dirs. */
  function configRoots(c: Pinned): ConfigRoots {
    return { repo: c.real, dirs: c.dirs, laneRoots: laneWritableRoots(c.real) };
  }

  /**
   * The pinned URL the network call uses, after checking origin's URL now parses cleanly, carries no
   * credentials and is the one pinned. The raw config string never reaches the network call.
   */
  async function pinnedUrl(c: Pinned, direction: 'fetch' | 'push'): Promise<string> {
    const { real, pin } = c;
    const pinnedValue = direction === 'fetch' ? pin.fetchUrl : pin.pushUrl;
    const current = await originUrl(c, direction === 'push');
    const parsed = current === null ? null : parseRemoteUrl(current);
    if (parsed?.ok === false)
      throw refusal(real, { kind: GitTrustFailure.Remote, direction, why: parsed.why });
    const found = parsed?.url ?? null;
    if (pinnedValue === null || found !== pinnedValue)
      throw refusal(real, {
        kind: GitTrustFailure.Origin,
        direction,
        pinned: pinnedValue,
        found,
        candidate: await observe(real),
      });
    const local = localRemotePath(pinnedValue);
    if (local !== null && insideAny(local, laneWritableRoots(real)))
      throw refusal(real, {
        kind: GitTrustFailure.Remote,
        direction,
        why: "is inside a checkout or a lane's temp dir, where a lane could write its hooks",
      });
    return pinnedValue;
  }

  /**
   * Creates `name` at `startPoint` and checks it out: `update-ref` makes the branch only if it is
   * new, and `read-tree -m -u` moves the clean checkout to it. Git checks every path it writes and
   * writes nothing beyond a link; with no attributes, no filter runs, and `read-tree` runs no hook.
   */
  async function switchCheckout(
    c: Pinned,
    name: string,
    startPoint: string,
  ): Promise<CheckoutPlace | null> {
    const target = await revParse(c, `${startPoint}^{commit}`);
    if (target === null) throw new InvalidError(`${startPoint} names no commit`);
    if ((await changes(c)).length > 0)
      throw new InvalidError(
        `${c.real} has uncommitted changes; 10db switches only a clean checkout`,
      );
    const from = await revParse(c, 'HEAD^{commit}');
    const fromBranch = await currentBranch(c);
    const ref = `refs/heads/${name}`;
    try {
      // The zero old value creates the branch only if it doesn't exist yet.
      await git(c, ['update-ref', '--no-deref', ref, target, '0'.repeat(target.length)]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new InvalidError(`A branch named ${name} already exists, or the name is not valid`);
    }
    try {
      await git(c, ['read-tree', '-m', '-u', ...(from ? [from] : []), target]);
    } catch (error) {
      await git(c, ['update-ref', '-d', ref, target]).catch(() => undefined);
      if (!(error instanceof GitError)) throw error;
      throw new InvalidError(`10db could not check out ${startPoint}: ${error.message}`);
    }
    await git(c, ['symbolic-ref', 'HEAD', ref]);
    return from === null ? null : { branch: fromBranch, sha: from };
  }

  /** `switchCheckout`'s way back: the same `read-tree -m -u`, then HEAD names the place again. */
  async function switchBackCheckout(
    c: Pinned,
    from: string,
    to: CheckoutPlace,
  ): Promise<SwitchBack> {
    const found = await currentBranch(c);
    if (found !== from) return { kind: 'moved', found };
    // What the files hold beyond HEAD, and what the checkout's own index holds beyond it: staged
    // work the files no longer show, or entries a commit made while another git held index.lock
    // left behind. Either way the merge below would lose or keep the wrong thing, so 10db leaves it.
    const paths = [...new Set([...(await changes(c)), ...(await stagedPaths(c))])].sort();
    if (paths.length > 0) return { kind: 'dirty', paths };
    const ref = to.branch === null ? null : `refs/heads/${to.branch}`;
    const target = await revParse(c, `${ref ?? to.sha}^{commit}`);
    if (target === null) return { kind: 'gone' };
    if (to.branch !== null) {
      const other = await branchInUseElsewhere(c, to.branch);
      if (other !== null) return { kind: 'checked_out', path: other };
    }
    const head = await revParse(c, 'HEAD^{commit}');
    if (head === null) return { kind: 'gone' };
    // Fresh stat data, so read-tree doesn't take an unchanged file for an edited one and refuse.
    await git(c, ['update-index', '-q', '--ignore-submodules', '--refresh']).catch(() => undefined);
    // Read after the refresh, against the files as they are now: `read-tree -m -u` takes what git
    // doesn't track as disposable where it writes.
    const written = new Set(
      (await git(c, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', head, target]))
        .split('\0')
        .filter(Boolean),
    );
    const inTheWay = await untrackedInTheWay(c, head, target, written);
    if (inTheWay.length > 0) return { kind: 'ignored', paths: inTheWay };
    try {
      await git(c, ['read-tree', '-m', '-u', head, target]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      throw new InvalidError(`10db could not check out ${to.branch ?? to.sha}: ${error.message}`);
    }
    try {
      if (ref === null) await git(c, ['update-ref', '--no-deref', 'HEAD', target]);
      else await git(c, ['symbolic-ref', 'HEAD', ref]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      const why = `10db could not point HEAD at ${to.branch ?? to.sha}: ${error.message}`;
      // HEAD still names the batch's branch: put its files back so the two agree.
      try {
        await git(c, ['read-tree', '-m', '-u', target, head]);
      } catch (rollback) {
        throw new InvalidError(
          `${why}. Putting the batch's files back failed too (${rollback instanceof Error ? rollback.message : String(rollback)}), so the checkout may be half switched: HEAD names ${from} while its files may be ${to.branch ?? to.sha}'s`,
        );
      }
      throw new InvalidError(why);
    }
    return { kind: 'switched' };
  }

  /** The paths whose entry in the checkout's own index differs from HEAD's, read without a lock. */
  async function stagedPaths(c: Pinned): Promise<string[]> {
    return (
      await git(c, [
        'diff-index',
        '--cached',
        '--name-only',
        '--no-renames',
        '--ignore-submodules=all',
        '-z',
        'HEAD',
      ])
    )
      .split('\0')
      .filter(Boolean);
  }

  /**
   * Where `branch` is in use in another worktree of the repository, or null: checked out there, which
   * `worktree list` shows, or being rebased or bisected there, which leaves that worktree detached
   * and shows only in its git dir. `symbolic-ref` skips the check `git switch` makes, so this is it.
   */
  async function branchInUseElsewhere(c: Pinned, branch: string): Promise<string | null> {
    const entries = await listWorktrees(c);
    const self = (path: string): boolean => samePath(comparablePath(path), c.real);
    const out = entries.find((e) => e.branch === branch && !self(e.path));
    if (out) return comparablePath(out.path);
    const ref = `refs/heads/${branch}`;
    const busy = (gitDir: string): boolean =>
      ['rebase-merge', 'rebase-apply'].some(
        (dir) => readIfPresent(join(gitDir, dir, 'head-name')).trim() === ref,
      ) || readIfPresent(join(gitDir, 'BISECT_START')).trim() === branch;
    const { commonDir, gitDir } = c.dirs;
    const linked = join(commonDir, 'worktrees');
    const names = existsAsEntry(linked) ? readdirSync(linked) : [];
    for (const name of names) {
      const dir = join(linked, name);
      if (samePath(dir, gitDir) || !busy(dir)) continue;
      // `gitdir` names the worktree's `.git` file.
      const path = dirname(readIfPresent(join(dir, 'gitdir')).trim());
      if (!self(path)) return comparablePath(path);
    }
    if (!samePath(commonDir, gitDir) && busy(commonDir)) {
      const main = entries.find((e) => !e.bare);
      if (main && !self(main.path)) return comparablePath(main.path);
    }
    return null;
  }

  /** The index entries a commit covers, from a private index after `git add`; refused if unsafe. */
  async function stage(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    named: readonly string[],
    tip: string,
  ): Promise<string[]> {
    const { real } = c;
    for (const name of named) {
      const embedded = embeddedRepository(real, name);
      if (embedded !== null)
        throw refusal(real, { kind: GitTrustFailure.Embedded, path: embedded });
    }
    try {
      await git(c, ['add', '-A', '--', ...named], { env });
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      if (/pathspec .* did not match/i.test(error.stderr))
        throw new InvalidError(
          `No file or change at ${named.join(', ')}: a path must exist or have been deleted since the last commit`,
        );
      throw new InvalidError(`10db could not stage ${named.join(', ')}: ${error.message}`);
    }
    const changed = (
      await git(c, ['diff-index', '--cached', '--name-only', '-z', '--no-renames', tip], { env })
    )
      .split('\0')
      .filter(Boolean);
    // Nothing staged: `ls-files` with no path would list the whole index, submodules and all.
    if (changed.length === 0) return [];
    // What this commit changes may not be a submodule or name a git dir; submodules already in the
    // tree stay as they are.
    for (const record of (await git(c, ['ls-files', '-s', '-z', '--', ...changed], { env }))
      .split('\0')
      .filter(Boolean)) {
      const [mode = ''] = record.split(' ');
      const path = record.slice(record.indexOf('\t') + 1);
      if (mode === GitMode.Gitlink || path.split('/').some(isGitComponent))
        throw refusal(real, { kind: GitTrustFailure.Embedded, path });
    }
    return changed;
  }

  /** True when `ref` points at another ref: a write through it would land on the branch it names. */
  async function isSymbolic(c: Pinned, ref: string): Promise<boolean> {
    try {
      return (await git(c, ['symbolic-ref', '-q', ref])).trim() !== '';
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /** True when commit `ancestor` is reachable from `tip`, `tip` itself included. */
  async function isAncestor(c: Pinned, ancestor: string, tip: string): Promise<boolean> {
    try {
      await git(c, ['merge-base', '--is-ancestor', ancestor, tip]);
      return true;
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 1) return false;
      throw error;
    }
  }

  /**
   * The tree that merges `theirs` into `ours`, and the files that conflict (none when it merged
   * cleanly). merge-tree writes objects only: no file, index, ref or hook, and with no attributes no
   * merge driver. It exits 1 on a conflict, listing the conflicted files after the tree.
   */
  async function mergeTree(
    c: Pinned,
    ours: string,
    theirs: string,
  ): Promise<{ tree: string; conflicted: string[] }> {
    const [tree = '', ...conflicted] = (
      await git(
        c,
        ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', ours, theirs],
        { answerExitCodes: [1] },
      )
    )
      .split('\0')
      .filter(Boolean);
    if (!OBJECT_ID.test(tree)) throw new GitError(['merge-tree'], 'merge-tree named no tree', null);
    return { tree, conflicted: [...new Set(conflicted)].sort() };
  }

  /**
   * What lies where the merge from `tip` to `head` would put a new file, though git tracks nothing
   * there: an entry at an added path (a directory with its `/`, when it holds anything git doesn't
   * track), and a non-directory where an added path needs one. Paths the merge itself deletes or
   * changes are git's to replace, and so is what an added path finds of one of them on a file system
   * that folds case or normalization (a rename of `Guide.md` to `GUIDE.md` finds `Guide.md`). An
   * ignored file under a directory the merge only adds to is no concern.
   */
  async function untrackedInTheWay(
    c: Pinned,
    tip: string,
    head: string,
    written: ReadonlySet<string>,
  ): Promise<string[]> {
    const added = (
      await git(c, [
        'diff-tree',
        '-r',
        '--name-only',
        '--no-renames',
        '--diff-filter=A',
        '-z',
        tip,
        head,
      ])
    )
      .split('\0')
      .filter(Boolean);
    const fresh = new Set(added);
    const replaced = new Map<string, string[]>();
    for (const path of written)
      if (!fresh.has(path))
        replaced.set(foldedName(path), [...(replaced.get(foldedName(path)) ?? []), path]);
    /** True when what is at `rel` is a path the merge replaces itself, by that name or a folded one. */
    const isReplaced = (rel: string): boolean =>
      (replaced.get(foldedName(rel)) ?? []).some((other) =>
        sameEntry(join(c.real, rel), join(c.real, other)),
      );
    const found = new Set<string>();
    for (const path of added) {
      const entry = entryAt(c.real, path);
      if (entry !== 'missing' && isReplaced(path)) continue;
      if (entry === 'directory') {
        // A tracked directory the merge empties is git's; anything else in it is not.
        const held = await git(c, ['ls-files', '-z', '--others', '--directory', '--', path], {
          env: { GIT_LITERAL_PATHSPECS: '1' },
        });
        if (held !== '') found.add(`${path}/`);
      } else if (entry === 'other') {
        found.add(path);
      }
      for (let parent = posix.dirname(path); parent !== '.'; parent = posix.dirname(parent))
        if (entryAt(c.real, parent) === 'other' && !isReplaced(parent)) found.add(parent);
    }
    return [...found].sort();
  }

  async function mergedCommit(input: MergedCommitInput): Promise<string | null> {
    if (!input.ref.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${input.ref} is not under ${KEPT_REF_PREFIX}`);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ours = await revParse(c, `${input.ours}^{commit}`);
      const theirs = await revParse(c, `${input.theirs}^{commit}`);
      if (ours === null || theirs === null)
        throw new InvalidError(`${ours === null ? input.ours : input.theirs} names no commit`);
      if (await isAncestor(c, theirs, ours)) return ours;
      if (await isAncestor(c, ours, theirs)) return theirs;
      const { tree, conflicted } = await mergeTree(c, ours, theirs);
      if (conflicted.length > 0) return null;
      // Never pushed, so never signed.
      const sha = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', ours, '-p', theirs], {
          input: `${input.message}\n`,
        })
      ).trim();
      await git(c, ['update-ref', '--no-deref', '-m', '10db: kept merge', input.ref, sha]);
      return sha;
    });
  }

  /** One fetch of `branch` into `origin/<branch>`, from origin's pinned fetch URL. */
  async function fetchOnce(repo: string, branch: string, net: NetworkCall): Promise<NetworkRun> {
    const c = await pinned(repo);
    const network = await networkConfig(c, net);
    const url = await pinnedUrl(c, 'fetch');
    return gitNetwork(
      c.real,
      network.config,
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--',
        url,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      net,
      { bin, env: { ...c.env, ...network.env } },
    );
  }

  async function mergeIntoBranch(input: MergeIntoBranchInput): Promise<BranchMerge> {
    // Inside the checkout's lock, so no commit of the daemon's moves the branch meanwhile.
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      if (await isSymbolic(c, ref))
        throw new InvalidError(`${ref} points at another branch, so 10db merges nothing into it`);
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      const current = await currentBranch(c);
      if (current !== input.branch)
        throw new InvalidError(
          `${c.real} is on ${current ?? 'a detached HEAD'}, not ${input.branch}, so 10db merges nothing into it`,
        );
      const from = await revParse(c, `${input.from}^{commit}`);
      if (from === null) throw new InvalidError(`${input.from} names no commit`);
      if (await isAncestor(c, from, tip)) return { kind: 'up_to_date', from };
      const needed = await filters(c, from);
      if (needed.length > 0) throw refusal(c.real, { kind: GitTrustFailure.Filter, paths: needed });
      const fastForward = await isAncestor(c, tip, from);
      let head = from;
      if (!fastForward) {
        const { tree, conflicted } = await mergeTree(c, tip, from);
        if (conflicted.length > 0) return { kind: 'conflict', from, paths: conflicted };
        const sign = signing(c, await configEntries(c));
        head = (
          await git(c, ['commit-tree', ...sign.flags, tree, '-p', tip, '-p', from], {
            input: `${input.message}\n`,
            config: sign.config,
          })
        ).trim();
      }
      const paths = (
        await git(c, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', tip, head])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      const written = new Set(paths);
      const changed = (await changes(c)).filter((path) => written.has(path));
      const reported = new Set(changed);
      const kept = (await untrackedInTheWay(c, tip, head, written)).filter(
        (path) => !reported.has(path),
      );
      if (changed.length > 0 || kept.length > 0) return { kind: 'blocked', from, changed, kept };
      // Fresh stat data, so read-tree doesn't take an unchanged file for an edited one and refuse.
      await git(c, ['update-index', '-q', '--ignore-submodules', '--refresh']).catch(
        () => undefined,
      );
      try {
        // Files first, then the branch: a crash between the two leaves the base's changes as
        // uncommitted edits, never the branch claiming files the checkout doesn't hold.
        await git(c, ['read-tree', '-m', '-u', tip, head]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(
          `10db could not write ${input.from} into ${c.real}: ${error.message}`,
        );
      }
      try {
        // Compare and swap on the branch itself, never through HEAD or a symbolic ref.
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          `10db: merge ${input.from}`,
          ref,
          head,
          tip,
        ]);
      } catch (error) {
        await git(c, ['read-tree', '-m', '-u', head, tip]).catch(() => undefined);
        if (!(error instanceof GitError)) throw error;
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
      }
      return { kind: 'merged', from, head, fastForward, paths };
    });
  }

  async function commit(input: {
    repo: string;
    paths: readonly string[];
    message: string;
    opId: string;
    branch: string;
  }): Promise<{ sha: string; alreadyCommitted: boolean }> {
    const named = checkPaths(input.repo, input.paths);
    // The pin is read inside the lock: a re-trust or a swapped .git while it waited counts.
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const { real } = c;
      const ref = `refs/heads/${input.branch}`;
      if (await isSymbolic(c, ref))
        throw refusal(real, { kind: GitTrustFailure.Ref, ref, reason: 'symbolic' });
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      const head = await currentBranch(c);
      if (head !== input.branch)
        throw refusal(real, {
          kind: GitTrustFailure.Branch,
          expected: input.branch,
          found: head,
          committed: false,
        });
      const existing = await findCommitByOp(c, tip, input.opId);
      if (existing) return { sha: existing, alreadyCommitted: true };
      const tree = await withPrivateIndex(c, tip, async (env) => {
        const changed = await stage(c, env, named, tip);
        const filtered = await filteredPaths(c, env, changed);
        if (filtered.length > 0)
          throw refusal(real, { kind: GitTrustFailure.Filter, paths: filtered });
        return (await git(c, ['write-tree'], { env })).trim();
      });
      if (tree === (await revParse(c, `${tip}^{tree}`)))
        throw new InvalidError(`Nothing to commit in ${named.join(', ')}`);
      const sign = signing(c, await configEntries(c));
      const sha = (
        await git(c, ['commit-tree', ...sign.flags, tree, '-p', tip], {
          input: withOpTrailer(input.message, input.opId),
          config: sign.config,
        })
      ).trim();
      try {
        // Compare and swap on the branch itself, never through HEAD or a symbolic ref.
        await git(c, ['update-ref', '--no-deref', '-m', `10db: ${input.opId}`, ref, sha, tip]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw refusal(real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
      }
      if ((await currentBranch(c)) === input.branch) {
        // The checkout's own index follows the commit, so the builder's git status shows the
        // committed paths as committed. Another git holding index.lock just leaves it stale.
        await git(c, ['reset', '-q', sha, '--', ...named], {
          env: { GIT_LITERAL_PATHSPECS: '1' },
        }).catch(() => undefined);
      } else {
        refusal(real, {
          kind: GitTrustFailure.Branch,
          expected: input.branch,
          found: await currentBranch(c),
          committed: true,
        });
      }
      return { sha, alreadyCommitted: false };
    });
  }

  /**
   * A git dir about to be pinned that lies where a lane can write, or null when there is none: one in
   * any registered checkout or a lane temp root. A dir at or under a registered checkout's own `.git`
   * directory is exempt: every lane profile denies every registered checkout's `.git` (the lane
   * sandbox gets the same list), a nested project's included, and a linked worktree's common dir is
   * often there. So is a dir `kept` names: the one already pinned.
   */
  function writableGitDir(
    real: string,
    dirs: { readonly gitDir: string; readonly commonDir: string },
    kept: readonly string[] = [],
  ): string | null {
    const dotGits = [real, ...(opts.checkouts?.() ?? [])].map((checkout) => join(checkout, '.git'));
    for (const dir of new Set([dirs.gitDir, dirs.commonDir])) {
      if (kept.includes(dir)) continue;
      if (samePath(dir, join(real, '.git'))) continue;
      if (dotGits.some((dotGit) => isPlainDirectory(dotGit) && surelyInside(dir, dotGit))) continue;
      if (insideAny(dir, laneWritableRoots(real))) return dir;
    }
    return null;
  }

  /** The git dir a worktree's `.git` file names, real; the file must be a regular file. */
  function readGitfile(worktree: string): string {
    const file = join(worktree, '.git');
    const text = lstatSync(file).isFile() ? readFileSync(file, 'utf8') : '';
    const match = /^gitdir: (\/[^\n]+)\n?$/.exec(text);
    if (!match?.[1]) throw new InvalidError(`${file} is not a gitfile`);
    return realpathSync(match[1]);
  }

  /** `path` with its parent read through links and its last component kept as written. */
  function withRealParent(path: string): string {
    const abs = resolve(path);
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }

  /** `path` with its nearest existing ancestor read through links, so a missing tail still compares. */
  function realisticPath(path: string): string {
    let head = resolve(path);
    const tail: string[] = [];
    for (;;) {
      try {
        return join(realpathSync(head), ...tail);
      } catch {
        const parent = dirname(head);
        if (parent === head) return resolve(path);
        tail.unshift(basename(head));
        head = parent;
      }
    }
  }

  async function addWorktree(input: AddWorktreeInput): Promise<string> {
    const root = opts.worktreeRoot;
    if (!root) throw new InvalidError('No worktree root is configured');
    return withRepoLock(realpathSync(input.repo), async () => {
      const main = await pinned(input.repo);
      if (existsAsEntry(input.path)) throw new InvalidError(`${input.path} already exists`);
      // Checked before anything is created, so a parent outside the root is never made.
      if (!equalOrUnder(realisticPath(dirname(input.path)), realisticPath(root)))
        throw new InvalidError(`${input.path} is not under 10db's worktree root`);
      mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
      const target = join(realpathSync(dirname(input.path)), basename(input.path));
      if (!surelyInside(dirname(target), root))
        throw new InvalidError(`${target} is not under 10db's worktree root`);
      const ref = `refs/heads/${input.branch}`;
      let made: string | null = null;
      if (input.startPoint !== null) {
        const sha = await revParse(main, `${input.startPoint}^{commit}`);
        if (sha === null) throw new InvalidError(`${input.startPoint} names no commit`);
        try {
          // The zero old value creates the branch only if it doesn't exist yet.
          await git(main, ['update-ref', '--no-deref', ref, sha, '0'.repeat(sha.length)]);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new InvalidError(
            `A branch named ${input.branch} already exists, or the name is not valid`,
          );
        }
        made = sha;
      } else if ((await revParse(main, `${ref}^{commit}`)) === null) {
        throw new InvalidError(`Branch ${input.branch} does not exist`);
      }
      let added = false;
      try {
        // No checkout: no file is written and no post-checkout hook runs; read-tree fills it. The
        // gitfile must be absolute, which a builder's `worktree.useRelativePaths=true` would undo.
        await git(
          main,
          [
            'worktree',
            'add',
            '--no-checkout',
            '--lock',
            '--reason',
            input.lockReason,
            '--',
            target,
            input.branch,
          ],
          { config: ['-c', 'worktree.useRelativePaths=false'] },
        );
        added = true;
        const gitDir = readGitfile(target);
        if (!surelyInside(gitDir, join(main.dirs.commonDir, 'worktrees')))
          throw new InvalidError(
            `git put ${target}'s git dir at ${gitDir}, outside the repository's worktrees`,
          );
        // The one call made before the worktree is pinned: it names the git dir it just read.
        const commonDir = realpathSync(
          (
            await runGit(target, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
              bin,
              env: {
                GIT_DIR: gitDir,
                GIT_WORK_TREE: target,
                GIT_ATTR_SOURCE: await emptyTree(main),
              },
              config: [...NO_ATTRIBUTES],
            })
          ).trim(),
        );
        const dirs = { gitDir, commonDir };
        const mainDirs = { gitDir: main.dirs.commonDir, commonDir: main.dirs.commonDir };
        if (checkoutIdentity({ gitDir: commonDir, commonDir }) !== checkoutIdentity(mainDirs))
          throw new InvalidError(`${target} does not share ${input.repo}'s repository`);
        const pin: CheckoutPin = {
          ...dirs,
          id: checkoutIdentity(dirs),
          fetchUrl: main.pin.fetchUrl,
          pushUrl: main.pin.pushUrl,
        };
        pins.set(target, pin);
        const wt: Pinned = {
          real: target,
          dirs,
          pin,
          env: { GIT_DIR: gitDir, GIT_WORK_TREE: target },
        };
        await git(wt, ['read-tree', '-m', '-u', 'HEAD']);
        const head = await revParse(wt, 'HEAD^{commit}');
        if (head === null) throw new InvalidError(`${target} has no HEAD commit`);
        return head;
      } catch (error) {
        // Leave nothing behind: the entry, its directory, its pin and a branch this call made.
        if (added) {
          await git(main, ['worktree', 'remove', '--force', '--force', '--', target]).catch(
            () => undefined,
          );
          rmSync(target, { recursive: true, force: true });
        }
        pins.delete(target);
        if (made !== null) await git(main, ['update-ref', '-d', ref, made]).catch(() => undefined);
        throw error;
      }
    });
  }

  async function listWorktrees(main: Pinned): Promise<WorktreeEntry[]> {
    return parseWorktreeList(await git(main, ['worktree', 'list', '--porcelain', '-z']));
  }

  async function removeWorktree(repo: string, path: string): Promise<'removed' | 'absent'> {
    const target = withRealParent(path);
    const root = opts.worktreeRoot;
    if (!root) throw new WorktreeNotOursError(path, 'no worktree root is configured');
    let present: ReturnType<typeof lstatSync> | null = null;
    try {
      present = lstatSync(target);
    } catch {
      present = null;
    }
    let inside: boolean;
    if (present) {
      inside = surelyInside(target, root);
    } else {
      try {
        inside = equalOrUnder(target, realPathOf(root));
      } catch {
        inside = false;
      }
    }
    if (!inside || samePath(target, realisticPath(root)))
      throw new WorktreeNotOursError(path, "it is not under 10db's worktree root");
    if (present && !present.isDirectory())
      throw new WorktreeNotOursError(path, 'it is a link or a file, not a worktree directory');
    return withRepoLock(realpathSync(repo), async () => {
      const main = await pinned(repo);
      const entry = (await listWorktrees(main)).find((e) =>
        samePath(comparablePath(e.path), target),
      );
      if (!entry) {
        if (present) throw new WorktreeNotOursError(path, 'git lists no worktree there');
        pins.delete(target);
        return 'absent';
      }
      if (lockedBatchId(entry) === null)
        throw new WorktreeNotOursError(path, 'the worktree is not locked by 10db');
      await git(main, ['worktree', 'remove', '--force', '--force', '--', target]);
      pins.delete(target);
      return 'removed';
    });
  }

  /**
   * The 10db worktree of `repo` at `path`, read through `repo`'s pin, once it has passed every check
   * `worktreeChanges` names.
   */
  async function lockedWorktree(repo: string, path: string): Promise<Pinned> {
    const root = opts.worktreeRoot;
    if (!root) throw new WorktreeNotOursError(path, 'no worktree root is configured');
    const target = withRealParent(path);
    if (!isPlainDirectory(target))
      throw new WorktreeNotOursError(path, 'it is not a worktree directory');
    if (!surelyInside(target, root) || samePath(target, realisticPath(root)))
      throw new WorktreeNotOursError(path, "it is not under 10db's worktree root");
    const main = await pinned(repo);
    const entry = (await listWorktrees(main)).find((e) => samePath(comparablePath(e.path), target));
    if (!entry) throw new WorktreeNotOursError(path, 'git lists no worktree there');
    if (lockedBatchId(entry) === null)
      throw new WorktreeNotOursError(path, 'the worktree is not locked by 10db');
    let gitDir: string;
    try {
      gitDir = readGitfile(target);
    } catch {
      throw new WorktreeNotOursError(path, 'its .git is not a gitfile', true);
    }
    // A linked worktree's git dir is a direct child of the repository's `worktrees` directory.
    if (!samePath(dirname(gitDir), join(main.dirs.commonDir, 'worktrees')))
      throw new WorktreeNotOursError(
        path,
        "its git dir is not one of the repository's worktrees",
        true,
      );
    // Git reads refs through the git dir's `commondir` file even when GIT_COMMON_DIR is set, so the
    // file must name the repository the main checkout's pin vouches for.
    if (!namesCommonDir(gitDir, main.dirs.commonDir))
      throw new WorktreeNotOursError(
        path,
        "its git dir names another repository's common dir",
        true,
      );
    if (readIfPresent(join(gitDir, 'info', 'attributes')).trim() !== '')
      throw new WorktreeNotOursError(path, 'its git dir holds an attributes file', true);
    return {
      real: target,
      dirs: { gitDir, commonDir: main.dirs.commonDir },
      pin: main.pin,
      env: { GIT_DIR: gitDir, GIT_COMMON_DIR: main.dirs.commonDir, GIT_WORK_TREE: target },
    };
  }

  async function worktreeChanges(repo: string, path: string): Promise<string[]> {
    return changes(await lockedWorktree(repo, path));
  }

  async function worktreeIgnoredFiles(repo: string, path: string): Promise<string[]> {
    const out = await git(await lockedWorktree(repo, path), [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--directory',
    ]);
    // With --directory a directory the ignore rules match is listed once, ending in `/`.
    return out
      .split('\0')
      .filter((entry) => entry !== '' && !entry.endsWith('/'))
      .sort();
  }

  return {
    async currentBranch(repo) {
      return currentBranch(await pinned(repo));
    },
    async remoteUrl(repo, name) {
      const c = await pinned(repo);
      try {
        return (await git(c, ['remote', 'get-url', name])).trim();
      } catch (error) {
        if (error instanceof GitError && /no such remote/i.test(error.stderr)) return null;
        throw error;
      }
    },
    async pinnedPushUrl(repo) {
      return pinnedUrl(await pinned(repo), 'push');
    },
    async fetch(repo, branch, net) {
      return serialized(fetches, realpathSync(repo), () => fetchOnce(repo, branch, net));
    },
    async switchNewBranch(repo, name, startPoint) {
      return withRepoLock(realpathSync(repo), async () =>
        switchCheckout(await pinned(repo), name, startPoint),
      );
    },
    async switchBack(repo, from, to) {
      return withRepoLock(realpathSync(repo), async () =>
        switchBackCheckout(await pinned(repo), from, to),
      );
    },
    async push(repo, branch, net) {
      const c = await pinned(repo);
      const needed = await filters(c, `refs/heads/${branch}`);
      if (needed.length > 0) throw refusal(c.real, { kind: GitTrustFailure.Filter, paths: needed });
      const network = await networkConfig(c, net);
      const url = await pinnedUrl(c, 'push');
      const sha = await revParse(c, `refs/heads/${branch}^{commit}`);
      if (sha === null) throw new InvalidError(`Branch ${branch} does not exist`);
      const run = await gitNetwork(
        c.real,
        network.config,
        ['push', '--recurse-submodules=no', '--', url, `refs/heads/${branch}:refs/heads/${branch}`],
        net,
        { bin, env: { ...c.env, ...network.env } },
      );
      // What `push -u origin` records, written by the daemon since the push named a URL.
      await git(c, ['update-ref', `refs/remotes/origin/${branch}`, sha]);
      await git(c, ['config', `branch.${branch}.remote`, 'origin']);
      await git(c, ['config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
      return run;
    },
    async head(repo) {
      const sha = await revParse(await pinned(repo), 'HEAD^{commit}');
      if (sha === null) throw new GitError(['rev-parse', 'HEAD'], 'HEAD names no commit', null);
      return sha;
    },
    async gitDirs(repo) {
      return (await pinned(repo)).dirs;
    },
    async changedPaths(repo, only) {
      return changes(await pinned(repo), only);
    },
    async changedFilesSince(repo, base) {
      const c = await pinned(repo);
      const working = await changes(c);
      const committed = (
        await git(c, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', base, 'HEAD'])
      )
        .split('\0')
        .filter(Boolean);
      return [...new Set([...committed, ...working])].sort();
    },
    async filesChangedBetween(repo, base, tip) {
      return (
        await git(await pinned(repo), [
          'diff-tree',
          '-r',
          '--name-only',
          '--no-renames',
          '-z',
          base,
          tip,
        ])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
    },
    async commitsSince(repo, base, tip = 'HEAD') {
      return (
        await git(await pinned(repo), [
          'rev-list',
          '--reverse',
          '--first-parent',
          `${base}..${tip}`,
        ])
      )
        .split('\n')
        .filter(Boolean);
    },
    async diffSince(repo, base, head, maxBytes) {
      const c = await pinned(repo);
      const numstat = await git(
        c,
        ['diff-tree', ...DIFF_FLAGS, '--numstat', '-z', base, head, '--'],
        {
          config: DIFF_CONFIG,
        },
      );
      // A few bytes past the cap are read so a character split by the cap is seen whole.
      const text = await gitCapped(
        c,
        ['diff-tree', ...DIFF_FLAGS, '-p', '--unified=3', base, head, '--'],
        maxBytes + UTF8_MAX_BYTES,
        { config: DIFF_CONFIG },
      );
      return { ...cutDiff(text, maxBytes), files: parseNumstat(numstat) };
    },
    async filtersIn(repo, rev) {
      return filters(await pinned(repo), rev);
    },
    commit,
    mergeIntoBranch,
    mergedCommit,
    async keptRefs(repo, prefix) {
      if (!prefix.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${prefix} is not under ${KEPT_REF_PREFIX}`);
      return (await git(await pinned(repo), ['for-each-ref', '--format=%(refname)', prefix]))
        .split('\n')
        .filter(Boolean)
        .sort();
    },
    async deleteKeptRef(repo, ref) {
      if (!ref.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
      const c = await pinned(repo);
      if ((await revParse(c, ref)) === null) return;
      await git(c, ['update-ref', '--no-deref', '-d', ref]);
    },
    async isAncestor(repo, ancestor, tip) {
      return isAncestor(await pinned(repo), ancestor, tip);
    },
    async blobAt(repo, rev, path) {
      const c = await pinned(repo);
      const out = await git(c, ['ls-tree', '-z', '--long', '--full-tree', rev, '--', path], {
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      const entry = out
        .split('\0')
        .map((line) => LS_TREE_ENTRY.exec(line))
        .find((match) => match?.[5] === path);
      if (!entry) return null;
      const [, mode = '', type, oid = ''] = entry;
      return type === 'blob' && REGULAR_FILE_MODES.includes(mode) ? oid : null;
    },
    addWorktree,
    removeWorktree,
    worktreeChanges,
    worktreeIgnoredFiles,
    async listWorktrees(repo) {
      return listWorktrees(await pinned(repo));
    },
    async pruneWorktrees(repo) {
      await git(await pinned(repo), ['worktree', 'prune']);
    },
    async deleteBranchIfAt(repo, branch, sha) {
      const c = await pinned(repo);
      try {
        await git(c, ['update-ref', '-d', `refs/heads/${branch}`, sha]);
        return true;
      } catch (error) {
        if (error instanceof GitError) return false;
        throw error;
      }
    },
    async fileAt(repo, rev, path, maxBytes) {
      const c = await pinned(repo);
      const out = await git(c, ['ls-tree', '-z', '--long', '--full-tree', rev, '--', path], {
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      const entry = out
        .split('\0')
        .map((line) => LS_TREE_ENTRY.exec(line))
        .find((match) => match?.[5] === path);
      if (!entry) return { kind: 'missing' };
      const [, mode = '', type, oid = '', size = ''] = entry;
      if (type !== 'blob' || !REGULAR_FILE_MODES.includes(mode))
        return { kind: 'not_regular', mode };
      const bytes = Number(size);
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) return { kind: 'too_large', bytes };
      return { kind: 'file', text: await git(c, ['cat-file', 'blob', oid]) };
    },
    async inspect(path) {
      const site = observed(path);
      /** Output of a call whose exit 1 means "nothing there". */
      const optional = async (args: readonly string[]): Promise<string | null> => {
        try {
          return await git(site, args);
        } catch (error) {
          if (error instanceof GitError && error.exitCode === 1) return null;
          throw error;
        }
      };
      try {
        const bare = (await git(site, ['rev-parse', '--is-bare-repository'])).trim() === 'true';
        if (bare) return { refused: 'bare_repository', message: 'This is a bare repository.' };
        const root = realpathSync((await git(site, ['rev-parse', '--show-toplevel'])).trim());
        const at = observed(root);
        const branches = parseBranches(
          await git(at, [
            'for-each-ref',
            '--format=%(refname)',
            'refs/heads',
            'refs/remotes/origin',
          ]),
        );
        const originHead = await optional(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']);
        const head = await optional(['symbolic-ref', '-q', 'HEAD']);
        const fromOrigin = originHead === null ? null : branchOfRef(originHead, 'origin');
        const current = head === null ? null : branchOfRef(head, 'heads');
        const hasCommits = (name: string | null) =>
          name !== null && branches.some((b) => b.name === name);
        const url = await optional(['config', '--get', 'remote.origin.url']);
        return {
          root,
          branches,
          defaultBranch: hasCommits(fromOrigin) ? fromOrigin : hasCommits(current) ? current : null,
          originFetchUrl: url === null || url.trim() === '' ? null : url.trim(),
        };
      } catch (error) {
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
    },
    async ignoredDirectories(repo) {
      const out = await git(await pinned(repo), [
        'ls-files',
        '-z',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
      ]);
      return out
        .split('\0')
        .filter((entry) => entry.endsWith('/'))
        .map((entry) => entry.slice(0, -1));
    },
    async retrust(repo, candidate) {
      const real = realpathSync(repo);
      const current = pins.get(real);
      const writable = writableGitDir(
        real,
        candidate,
        current ? [current.gitDir, current.commonDir] : [],
      );
      if (writable !== null)
        throw refusal(real, { kind: GitTrustFailure.Writable, gitDir: writable });
      const now = await observe(real);
      const same =
        now.id === candidate.id &&
        now.gitDir === candidate.gitDir &&
        now.commonDir === candidate.commonDir &&
        now.fetchUrl === candidate.fetchUrl &&
        now.pushUrl === candidate.pushUrl;
      if (!same) throw mismatch(real, candidate, now);
      pins.set(real, candidate);
    },
  };
}
