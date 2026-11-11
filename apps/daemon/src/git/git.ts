import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, posix, resolve, sep } from 'node:path';
import { BRANCH_PREFIX, InvalidError } from '@10db/contracts';
import { z } from 'zod';
import { realPathOf, resolveInRepo } from '../guard';
import { bookkeepingEntryAt, leftOutOfCommits } from './claude-code-bookkeeping';
import {
  memoryPinStore,
  sameCheckoutIdentity,
  type CheckoutPin,
  type PinStore,
} from './checkout-pin';
import {
  checkoutIdentity,
  refusedCheckoutKeys,
  trustedValues,
  type ConfigRoots,
} from './checkout-trust';
import { parseScopedConfig, type ConfigEntry } from './config-trust';
import { BOTH_CHANGED, hasConflictMarkers, resolveAddedLines } from './conflict-text';
import { equalOrUnder, insideAny, isPlainDirectory, samePath, surelyInside } from './lane-writable';
import {
  branchOfRef,
  parseBranches,
  parseSurveyLog,
  refusalOf,
  SURVEY_COMMIT_MARK,
  type RepoFacts,
  type RepoRefusal,
  type RepoSurvey,
} from './inspect';
import { comparablePath, entryAt, existsAsEntry, foldedName, sameEntry } from './path-entries';
import { gitNetwork, type NetworkCall, type NetworkRun } from './network';
import { localRemotePath, parseRemoteUrl } from './remote-url';
import { GitError, runGit, runGitCapped, type RunOptions } from './run';
import { GitTrustError, GitTrustFailure, type GitTrustDetail } from './trust-error';
import { embeddedRepository, GitMode, isGitComponent } from './worktree-files';
import { lockedBatchId, parseWorktreeList, type WorktreeEntry } from './worktree-list';

const OP_TRAILER = '10db-Op';
const OP_TRAILER_LINE = new RegExp(`^${OP_TRAILER}:`, 'm');
const OP_SEARCH_DEPTH = 200;
const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** One record of `diff-index --raw`, as git printed it. */
const IndexChange = z.object({
  path: z.string().min(1),
  mode: z.string().regex(/^[0-7]{6}$/),
  blob: z.string().regex(OBJECT_ID),
  status: z.string().min(1),
});

/** What a pass's dirt commit records, as `log` printed its parent and trailers. */
const PassDirtTrailers = z.object({
  startSha: z.string().regex(OBJECT_ID),
  branch: z
    .string()
    .startsWith(BRANCH_PREFIX)
    .regex(/^[^,\s]+$/),
  returnBranch: z.string().regex(/^[^,\s]+$/),
});

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

/** Which files a diff covers: only these, or every file but these. */
interface DiffPaths {
  readonly only?: readonly string[];
  readonly except?: readonly string[];
}

/** Whether a file of the whole change is one `paths` keeps. */
function keptBy(paths: DiffPaths): (path: string) => boolean {
  const only = paths.only === undefined ? null : new Set(paths.only);
  const except = new Set(paths.except ?? []);
  return (path) => (only === null || only.has(path)) && !except.has(path);
}

/** How many files, and how many bytes of their names, one `diff-tree` command names at most. */
const PATHS_PER_COMMAND = 200;
const PATH_BYTES_PER_COMMAND = 32 * 1024;

/**
 * `paths` in turns small enough for one command line, in the order given; each name is a literal
 * pathspec, so a name with `*` or `:` is never read as a pattern.
 */
function pathspecTurns(paths: readonly string[]): string[][] {
  const turns: string[][] = [];
  let turn: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const spec = `:(literal)${path}`;
    const size = Buffer.byteLength(spec) + 1;
    if (
      turn.length > 0 &&
      (turn.length >= PATHS_PER_COMMAND || bytes + size > PATH_BYTES_PER_COMMAND)
    ) {
      turns.push(turn);
      turn = [];
      bytes = 0;
    }
    turn.push(spec);
    bytes += size;
  }
  if (turn.length > 0) turns.push(turn);
  return turns;
}

/** What `fileAt` found at a path of a commit. */
export type FileAt =
  | { readonly kind: 'file'; readonly text: string }
  | { readonly kind: 'missing' }
  /** A link, a submodule, a directory: anything but a regular file's blob. */
  | { readonly kind: 'not_regular'; readonly mode: string }
  | { readonly kind: 'too_large'; readonly bytes: number };

/** A conflicted file `mergeIntoBranch` could not settle, and why. */
export interface UnresolvedConflict {
  readonly path: string;
  readonly reason: string;
}

/**
 * A conflict `mergeIntoBranch` settled: `kept_both` where each side only added lines at the same place,
 * `regenerated` where `path` is a generated directory (ending in `/`) that now holds the base's files.
 */
export interface ResolvedConflict {
  readonly path: string;
  readonly how: 'kept_both' | 'regenerated';
}

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
      /** The conflicts `resolve` settled, only when there were any. */
      readonly resolved?: readonly ResolvedConflict[];
      /**
       * The generated directories whose conflicts were settled by taking the base's version of the
       * whole directory: the files the branch had there that the base lacks (`dropped`) are gone from
       * the merge, and the caller regenerates the directory from its sources.
       */
      readonly regenerate?: readonly {
        readonly dir: string;
        readonly dropped: readonly string[];
      }[];
      /**
       * Text files where both sides changed the same lines, committed with git's conflict markers in
       * them because the caller asked for that (`resolve.leaveMarkers`): the merge commit stands, but
       * these files are not resolved, and neither the generated directories nor a gate can be trusted
       * until someone has resolved them.
       */
      readonly marked?: readonly string[];
    }
  /** Both sides changed these files in ways git can't combine; nothing was written. */
  | {
      readonly kind: 'conflict';
      readonly from: string;
      readonly paths: readonly string[];
      /** Why each of `paths` was left; only when the caller asked for conflicts to be resolved. */
      readonly unresolved?: readonly UnresolvedConflict[];
      /**
       * Every path git found conflicted, those `resolve` would have settled included (`paths` holds
       * only what it could not); only when the caller asked for conflicts to be resolved.
       */
      readonly conflicted?: readonly string[];
    }
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

/** What `revertCommits` did. */
type CommitsReverted =
  /** One commit on the branch, `head`, undoes the commits; `paths` are the files it changed. */
  | { readonly kind: 'reverted'; readonly head: string; readonly paths: readonly string[] }
  /** Undoing the commits changes nothing the branch still has; nothing moved. */
  | { readonly kind: 'nothing' }
  /** Later commits changed these files in ways that can't be undone cleanly; nothing was written. */
  | { readonly kind: 'conflict'; readonly paths: readonly string[] }
  /** Undoing the commits would put conflict markers back in these files; nothing was written. */
  | { readonly kind: 'markers'; readonly paths: readonly string[] }
  /** Uncommitted changes are in these files, which the revert writes; nothing was written. */
  | { readonly kind: 'blocked'; readonly changed: readonly string[] };

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

export interface PassBranchInput {
  readonly repo: string;
  /** The pass's branch to make at HEAD's commit; it must not exist yet. */
  readonly branch: string;
  /** Where the commit holding the folder's dirt is kept: a new ref under `refs/10db/`. */
  readonly dirtRef: string;
  readonly message: string;
}

/** What a pass's dirt commit says of where the pass opened, read back from its ref. */
export interface PassDirtRecord {
  /** The ref that keeps the commit, `refs/10db/passes/<pass id>/dirt`. */
  readonly ref: string;
  /** The pass's branch, under `10db/`. */
  readonly branch: string;
  /** The branch HEAD named when the pass opened. */
  readonly returnBranch: string;
  /** The commit the pass opened at: the dirt commit's parent. */
  readonly startSha: string;
}

/** The trailers a dirt commit carries, so a pass a stop left with no row can be taken back. */
const PASS_BRANCH_TRAILER = '10db-Pass-Branch';
const RETURN_BRANCH_TRAILER = '10db-Return-Branch';

/** What git leaves in a worktree's git dir while an operation waits for the builder to finish it. */
const OPERATIONS_IN_PROGRESS = [
  { entry: 'MERGE_HEAD', what: 'a merge', end: 'git merge --continue or git merge --abort' },
  {
    entry: 'CHERRY_PICK_HEAD',
    what: 'a cherry-pick',
    end: 'git cherry-pick --continue or git cherry-pick --abort',
  },
  { entry: 'REVERT_HEAD', what: 'a revert', end: 'git revert --continue or git revert --abort' },
  { entry: 'rebase-merge', what: 'a rebase', end: 'git rebase --continue or git rebase --abort' },
  {
    entry: 'rebase-apply',
    what: 'a rebase or git am',
    end: 'git rebase --continue, git am --continue, or their --abort',
  },
] as const;

/** An operation git left waiting for the builder: what it is, and how to finish or stop it. */
export interface OperationInProgress {
  readonly what: string;
  readonly end: string;
}

/** Where `openPassBranch` found the folder, and what in it differed from that commit. */
export interface PassBranch {
  /** The branch HEAD named. */
  readonly returnBranch: string;
  /** The commit it was at, where the pass's branch now is. */
  readonly startSha: string;
  /**
   * Every path whose content on disk differs from `startSha`, untracked ones git doesn't ignore
   * included, sorted, with the blob of its content on disk; null for a file deleted from the folder.
   */
  readonly dirt: readonly { readonly path: string; readonly blob: string | null }[];
  /** The unsigned commit on `startSha` whose tree holds that dirt, kept at `dirtRef`. */
  readonly dirtCommit: string;
}

/** HEAD does not name the pass's branch, so the folder's files are not the pass's to keep. */
export class PassFolderOffBranchError extends Error {
  override readonly name = 'PassFolderOffBranchError';
  readonly branch: string;
  /** The branch HEAD names instead; null when it is detached. */
  readonly found: string | null;
  constructor(repo: string, branch: string, found: string | null) {
    super(`${repo} is on ${found ?? 'a detached HEAD'}, not on the pass's branch ${branch}`);
    this.branch = branch;
    this.found = found;
  }
}

/** A kept ref no longer held what its writer read, so nothing was kept over the other write. */
export class KeptRefMovedError extends Error {
  override readonly name = 'KeptRefMovedError';
  readonly ref: string;
  constructor(ref: string, expected: string | null, found: string | null) {
    super(`${ref} moved from ${expected ?? 'nothing'} to ${found ?? 'nothing'} meanwhile`);
    this.ref = ref;
  }
}

export interface KeepWorkInput {
  readonly repo: string;
  /** The pass's branch: HEAD must name it, and the work is laid on its tip. */
  readonly branch: string;
  /** Where the work is kept, under `refs/10db/`. */
  readonly ref: string;
  /** The files to keep as the folder has them: changed, added (untracked ones too) or deleted. */
  readonly paths: readonly string[];
  /**
   * What `ref` holds now, or null when it does not exist: the new commit's parent (the tip, for
   * null), and the only value the ref moves from.
   */
  readonly parent: string | null;
  readonly message: string;
  /** Names the work (`10db-turn: <turn id>`), so a rerun finds the commit it made. */
  readonly trailer: { readonly key: string; readonly value: string };
}

/** A path as a commit or the folder holds it: the blob of its content, or null where it is not there. */
export interface PathBlob {
  readonly path: string;
  readonly blob: string | null;
}

/**
 * A path as a commit or the folder holds it, with the mode git gives it (`100644`, `100755`, `120000`
 * for a link): a link or an executable bit holding the same bytes is another entry. Null where it is
 * not there.
 */
export interface PathEntry extends PathBlob {
  readonly mode: string | null;
}

/** What `recordPaths` made: the unsigned commit on `base`, and what each path held in the folder. */
export interface PathRecord {
  readonly sha: string;
  /** Each path recorded, sorted, as the commit holds it. */
  readonly record: readonly PathBlob[];
}

/** What `landPaths` landed. */
export interface LandedPaths {
  /** The commit on the branch that holds the paths; null when the tip held them already. */
  readonly sha: string | null;
  /** A commit carrying the operation id was on the branch already: a rerun's own. */
  readonly alreadyLanded: boolean;
  /** Another git held the folder's index, so it still reads the landed paths as they were. */
  readonly indexStale: boolean;
}

export interface ChainCommitInput {
  readonly repo: string;
  /** The chain's ref, under `refs/10db/`. */
  readonly ref: string;
  /** What `ref` holds now, or null when it does not exist: the only value it moves from. */
  readonly expect: string | null;
  /** The commit the first change is laid on while `ref` does not exist: the pass's start. */
  readonly base: string;
  /** The paths the change sets: as the folder has them, or, with `from`, as that commit has them. */
  readonly paths: readonly string[];
  readonly from?: string;
  /** More paths the change sets, as commit `from` has them (gone where it lacks them). */
  readonly restore?: { readonly from: string; readonly paths: readonly string[] };
  readonly message: string;
  /** Names the change (`10db-hold: <claim id>`), so a rerun finds the commit it made. */
  readonly trailer: { readonly key: string; readonly value: string };
}

/** What `chainCommit` left on the chain. */
export interface ChainCommit {
  /** The change's commit: made now, or one the chain already holds; null when the paths changed nothing. */
  readonly sha: string | null;
  /** True when `sha` was made by this call. */
  readonly made: boolean;
  /** Each of `paths`, sorted, as the change's tree holds it. */
  readonly files: readonly PathBlob[];
}

/** Work still kept at a ref that a move must not write over (`moveKeptRef`). */
export interface KeptRefEarlier {
  /** The commit the ref holds. */
  readonly sha: string;
  /** The commit it was made on. */
  readonly base: string;
  /** The commit the moved work was made on. */
  readonly workBase: string;
}

/** What `keepWork` left at the ref. */
export interface KeptCommit {
  /** The kept commit now: made here, found by its trailer, or the parent; null when there is none. */
  readonly sha: string | null;
  /** The branch tip the work was laid on. */
  readonly base: string;
  /** True when `sha` is this work's own commit: made now, or by an earlier run with the trailer. */
  readonly made: boolean;
}

/** One file's lines added and removed; both 0 for a binary file. */
export interface LineChange {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
}

export interface MergeIntoBranchInput {
  /** The checkout that has `branch` checked out. */
  readonly repo: string;
  readonly branch: string;
  /** The commit to bring in, such as `refs/remotes/origin/main`. */
  readonly from: string;
  /** The merge commit's message. */
  readonly message: string;
  /**
   * Settle conflicts instead of stopping at them. Text files where each side only added lines at the
   * same place keep both; a conflict in a directory of `generated` (paths ending in `/`) takes the
   * base's version of the directory. Anything else, such as two edits of one line, a deletion, a
   * binary file or a lockfile, still stops the merge. Without it every conflict does.
   * `generatedHeld`, for a caller that can't regenerate now, leaves every conflict in a directory of
   * `generated` a conflict for that reason instead: a generated file is never merged by line.
   */
  readonly resolve?: {
    readonly generated: readonly string[];
    readonly generatedHeld?: string;
    /**
     * A text file where both sides changed the same lines is committed with git's conflict markers
     * in it (`marked` in the result), when that is every conflict left; the merge commit then has
     * the base as its second parent and someone resolves the markers in a commit of their own.
     * Anything else that stays a conflict, a lockfile or a deleted file, still stops the merge.
     */
    readonly leaveMarkers?: boolean;
  };
}

/** One line of `merge-tree`'s conflicted file info: a side's version of a conflicted path. */
interface ConflictEntry {
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
  readonly path: string;
}

const CONFLICT_ENTRY = /^(\d{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([123])\t([\s\S]+)$/;

/** The largest conflicted file whose lines 10db will merge itself. */
const RESOLVABLE_BYTES = 1_000_000;

/** The modes git stores a regular file with. */
const REGULAR_FILE_MODES: readonly string[] = ['100644', '100755'];
/** Config for a read that must reach no remote: no transport, ssh command, credential helper or askpass. */
const NO_TRANSPORT: readonly string[] = [
  '-c',
  'protocol.allow=never',
  '-c',
  'core.sshCommand=false',
  '-c',
  'credential.helper=',
  '-c',
  'core.askPass=',
];
/** How many blob bytes one `cat-file --batch` call of `surveyTexts` is asked for, about. */
const SURVEY_TEXT_BATCH_BYTES = 16 * 1024 * 1024;

/** One `ls-tree --long -z` entry: mode, type, object, size (`-` for a tree), then the path. */
const LS_TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/;

/** What one folder of a commit holds directly: its regular files with their sizes, and its folders. */
export interface FolderAt {
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  readonly folders: readonly string[];
}

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
  /**
   * Runs `fn` as one operation: the calls it makes (through this `Git`, however deep) ask git for
   * each checkout's git dirs once, at the first call, and read origin's URL once per direction,
   * instead of once per call. Every call still checks that those directories are the same ones, by
   * device and inode, and that nothing in them borrows objects or sets attributes; a `.git` replaced
   * meanwhile is refused as it is outside an operation. In a linked worktree, whose `.git` is a file
   * naming a git dir under the main repository, a swapped `.git` file is only found by the next
   * operation: the calls in this one keep running in the pinned git dir, which is still there.
   * A pin the store no longer holds (a `retrust` since) or a refused checkout is checked in full.
   * Nested operations join the outer one while it runs. The operation ends when `fn` settles: a
   * callback, timer or job `fn` started that runs later shares nothing with it.
   */
  operation<T>(fn: () => Promise<T>): Promise<T>;
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
   * Whether origin, at its recorded fetch URL, has a branch named `branch`. Asks only: nothing is
   * fetched and the checkout is untouched. Throws a GitNetworkError when origin can't be asked, so
   * an unreachable origin is never taken for a missing branch.
   */
  branchOnOrigin(repo: string, branch: string, net: NetworkCall): Promise<boolean>;
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
  switchBack(
    repo: string,
    from: string,
    to: CheckoutPlace,
    opts?: {
      /**
       * Keep uncommitted changes the switch does not write, as `git switch` does: only one in a file
       * that differs between the two refuses it (`dirty`, naming those files).
       */
      readonly keepChanges?: boolean;
    },
  ): Promise<SwitchBack>;
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
  /**
   * Puts the files under `dirs` back as HEAD has them: each changed one is rewritten and each one
   * HEAD lacks is removed; ignored files stay. Runs nothing from the repository, and leaves the
   * checkout's own index as it was. Resolves with the paths it put back, sorted.
   */
  restoreDirs(repo: string, dirs: readonly string[]): Promise<string[]>;
  /** Committed and uncommitted changes since `base`, sorted and unique. */
  changedFilesSince(repo: string, base: string): Promise<string[]>;
  /** Files whose committed content differs between `base` and `tip`, sorted; nothing uncommitted. */
  filesChangedBetween(repo: string, base: string, tip: string): Promise<string[]>;
  /**
   * Commits on `tip` (HEAD unless named) since `base`, oldest first, following first parents: a merge
   * that brought another branch in is listed, the commits it brought are not.
   */
  commitsSince(repo: string, base: string, tip?: string): Promise<string[]>;
  /** How many commits `tip` has that `base` lacks, every parent followed (`rev-list --count`). */
  countCommits(repo: string, base: string, tip: string): Promise<number>;
  /** The paths commit `rev` tracks, read from the object store (`ls-tree -r`), sorted by git. */
  filesAt(repo: string, rev: string): Promise<string[]>;
  /**
   * When HEAD's history last committed a change to a file one of the globs matches (git's `glob`
   * pathspec), as an ISO time in UTC; null with no glob, no commit or none that touched one.
   */
  lastChangedAt(repo: string, globs: readonly string[]): Promise<string | null>;
  /** The merge, cherry-pick, revert, rebase or `git am` waiting in the worktree, or null. */
  operationInProgress(repo: string): Promise<OperationInProgress | null>;
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
   * Undoes `shas`, commits on `branch`, in one commit on it with `message`: each is reverted with a
   * three-way merge of its parent, newest first, so a later commit that built on one conflicts instead
   * of being overwritten. `repo` must have `branch` checked out. The files follow through
   * `read-tree -m -u`, which keeps uncommitted changes elsewhere. A conflict, a file that would hold
   * conflict markers it doesn't hold now (a merge session's commit resolved them), or an uncommitted
   * change in a file the revert writes, writes nothing. A commit not on the branch, or a merge, is
   * refused.
   */
  revertCommits(input: {
    readonly repo: string;
    readonly branch: string;
    readonly shas: readonly string[];
    readonly message: string;
  }): Promise<CommitsReverted>;
  /**
   * The commit that merges `theirs` into `ours`, as `mergeIntoBranch` would make it but unsigned and
   * kept reachable at `ref` alone: no file, index, HEAD or branch is touched. `ours` when it already
   * holds `theirs`, `theirs` when `ours` is in its history (both recording nothing), and null on a
   * conflict.
   */
  mergedCommit(input: MergedCommitInput): Promise<string | null>;
  /**
   * The files among `paths` whose committed content at `rev` (HEAD unless named) holds conflict
   * markers (a line opening with seven `<` and one with seven `>`): those a merge left with
   * `resolve.leaveMarkers` that nobody had resolved by then. A path `rev` lacks, or that isn't small
   * text, holds none.
   */
  conflictMarkers(repo: string, paths: readonly string[], rev?: string): Promise<string[]>;
  /**
   * Opens a Workbench pass in the checkout: records every path that differs from HEAD's commit, its
   * content written as git objects held by an unsigned commit at `dirtRef`, then makes `branch` at
   * that commit and points HEAD at it. No file and no index entry is written, so uncommitted work stays
   * as it is. Refused on a detached HEAD, a HEAD with no commit, a branch or ref that already exists,
   * and when HEAD moved meanwhile, which leaves nothing behind.
   */
  openPassBranch(input: PassBranchInput): Promise<PassBranch>;
  /**
   * Takes back an `openPassBranch` nothing was built on: while HEAD names `branch` and both it and
   * `returnBranch` are still at `startSha`, HEAD names `returnBranch` again and `branch` and `dirtRef`
   * go; when `branch` was never made, only `dirtRef` goes. No file is written. Anything else is left
   * as it is, and the answer says whether it was undone.
   */
  undoPassBranch(input: {
    readonly repo: string;
    readonly branch: string;
    readonly returnBranch: string;
    readonly startSha: string;
    readonly dirtRef: string;
  }): Promise<boolean>;
  /**
   * Every pass dirt commit kept under `refs/10db/passes/`, with the branches its trailers name; one
   * whose trailers or parent don't read as `openPassBranch` writes them is left out.
   */
  passDirtRecords(repo: string): Promise<PassDirtRecord[]>;
  /**
   * Keeps a pass task's work (spec §9.1), under the repo lock: an unsigned commit whose tree is the
   * branch's tip with `paths` as the folder has them (ignored files never), on `parent`, at `ref` by
   * compare-and-swap. No file, index, HEAD or branch is touched. A commit the ref already holds with
   * the same trailer is answered as it is; a tree equal to the parent's (the tip's, with no parent)
   * makes no commit. Refused with `PassFolderOffBranchError` while HEAD is not `branch`, and with
   * `KeptRefMovedError` when `ref` no longer holds `parent`.
   */
  keepWork(input: KeepWorkInput): Promise<KeptCommit>;
  /**
   * Lines added and removed in each of `pages` between commit `tip` and the folder, sorted by path;
   * a file the same in both is left out. Read through a private index: nothing is written.
   */
  pageChanges(repo: string, tip: string, pages: readonly string[]): Promise<LineChange[]>;
  /**
   * The blob and mode each of `paths` holds in the folder now, sorted by path; null for one that is
   * not there. Read through a private index: nothing is written.
   */
  hashOnDisk(repo: string, paths: readonly string[]): Promise<PathEntry[]>;
  /**
   * Puts each `entries` path back as commit `from` has it, under the repo lock: written through a
   * private index (its mode and content; never through a link), or removed when `from` lacks it. Each
   * file is hashed again just before it is written: one whose blob on disk is not the one `expect`
   * names for it (null: not there) changed since it was checked, and is left as it is, as is one
   * where a directory now stands or beyond a link or a file. HEAD and the folder's own index are
   * untouched.
   */
  restoreFiles(
    repo: string,
    entries: readonly { readonly path: string; readonly from: string }[],
    expect: readonly { readonly path: string; readonly blob: string | null }[],
  ): Promise<{ readonly written: string[]; readonly left: string[] }>;
  /**
   * Moves the commit kept at `from` to `to`, both under `refs/10db/`: `to` is set to it, then `from`
   * goes. Resolves with the commit, or with what `to` holds when `from` is gone (a rerun), or null.
   * With `earlier`, work still kept at `to` that is not in the folder: while `to` holds it, `to` gets
   * a new commit on both, so neither is lost, whose tree is `from`'s with each file `earlier` changed
   * since its base as `earlier` has it, where `from` left that file as `workBase` has it.
   */
  moveKeptRef(
    repo: string,
    from: string,
    to: string,
    earlier?: KeptRefEarlier,
  ): Promise<string | null>;
  /**
   * Narrows the work kept at `ref` (commit `kept.sha`, made on `kept.base`) to `paths`, under the repo
   * lock: a new commit on it whose tree is `kept.base`'s with only those files as it has them, set at
   * `ref` by compare-and-swap. A rerun finds the commit it made. Resolves with it.
   */
  narrowKeptRef(
    repo: string,
    ref: string,
    kept: { readonly sha: string; readonly base: string },
    paths: readonly string[],
  ): Promise<string>;
  /**
   * Brings `path` as commit `theirs` has it into the file on disk, by a three-way merge from its
   * version in `base` (`merge-file`, which runs no driver), under the repo lock. `merged` when the file
   * now holds both sides, or already did; `conflict` when they don't merge cleanly, a side is not a
   * regular file, or the file changed while it merged, and then it is left as it is.
   */
  mergeFileBack(input: {
    readonly repo: string;
    readonly path: string;
    readonly base: string;
    readonly theirs: string;
  }): Promise<'merged' | 'conflict'>;
  /**
   * Points HEAD from branch `from` at branch `to`, writing no file, only while HEAD names `from`, both
   * branches are at `sha` and no other worktree has `to`; true when it did.
   */
  pointHeadAt(input: {
    readonly repo: string;
    readonly from: string;
    readonly to: string;
    readonly sha: string;
  }): Promise<boolean>;
  /**
   * Refreshes the stat data of the folder's own index for `paths` alone, after 10db wrote them, so the
   * builder's git reads an unchanged file as unchanged; staged content and every other entry are not
   * touched, and a path the index lacks is passed over. False when another git held the index.
   */
  refreshIndex(repo: string, paths: readonly string[]): Promise<boolean>;
  /** Keeps `text` at `ref`, under `refs/10db/`, as a blob nothing else names; it is set, whatever it held. */
  keepNote(repo: string, ref: string, text: string): Promise<void>;
  /** The text `keepNote` kept at `ref`; null when the ref is gone or names no blob. */
  keptNote(repo: string, ref: string): Promise<string | null>;
  /** The refs under `prefix`, itself under `refs/10db/`, by full name and sorted. */
  keptRefs(repo: string, prefix: string): Promise<string[]>;
  /** Deletes `ref`, under `refs/10db/`, whatever it names; one already gone is no error. */
  deleteKeptRef(repo: string, ref: string): Promise<void>;
  /**
   * A pass's shared hold (spec §7.2): an unsigned commit on `base` whose tree is `base`'s with each of
   * `paths` as the folder has it (git's ignore rules aside; gone where nothing is there), under the
   * repo lock, naming no ref. No file, index, HEAD or branch is touched.
   */
  recordPaths(input: {
    readonly repo: string;
    readonly base: string;
    readonly paths: readonly string[];
  }): Promise<PathRecord>;
  /**
   * One change of a pass's shared chain (spec §7.2), under the repo lock: an unsigned commit whose tree
   * is the chain tip's (`expect`, else `base`) with `paths` set (and `restore`'s), on that tip, at `ref` by
   * compare-and-swap. A tree equal to the tip's makes no commit: it answers the newest commit on the
   * chain carrying the same trailer, a rerun's own, else null. Refused with `KeptRefMovedError` when
   * `ref` no longer holds `expect`. No file, index, HEAD or branch is touched.
   */
  chainCommit(input: ChainCommitInput): Promise<ChainCommit>;
  /**
   * Lands paths on a branch the folder has checked out, under the repo lock: a signed commit on its
   * tip whose tree is the tip's with each of `paths` as commit `from` has it (gone where it lacks
   * it), named by `opId`, by compare-and-swap, while HEAD names the branch. No file is written; the
   * folder's own index follows for those paths, so the builder's git reads them as committed;
   * `indexStale` says another git held the index, which then still reads them as before (Workbench
   * spec §18). A commit on the branch carrying the opId is answered as it is, the index following the
   * branch's tip for the paths again; a tree equal to the tip's makes none and answers null. Refused
   * with `PassFolderOffBranchError` while HEAD names another branch. A compare-and-swap that loses
   * a race is refused; with `willRetry` (the caller lands once more from the new tip) the refusal is
   * thrown without reaching `onRefused`, so a race the caller recovers from raises no card.
   */
  landPaths(input: {
    readonly repo: string;
    readonly branch: string;
    readonly from: string;
    readonly paths: readonly string[];
    readonly message: string;
    readonly opId: string;
    readonly willRetry?: boolean;
  }): Promise<LandedPaths>;
  /** Sets `ref`, under `refs/10db/`, to commit `sha`, whatever it held. */
  keepRef(repo: string, ref: string, sha: string): Promise<void>;
  /** The blob and mode each of `paths` holds in commit `rev`, sorted by path; null for one it lacks there. */
  blobsAt(repo: string, rev: string, paths: readonly string[]): Promise<PathEntry[]>;
  /** True when commit `ancestor` is in the history of `tip`, `tip` itself included. */
  isAncestor(repo: string, ancestor: string, tip: string): Promise<boolean>;
  /** Whether the object store of `repo` holds commit `sha`. */
  hasCommit(repo: string, sha: string): Promise<boolean>;
  /**
   * The commits in the history of `branch` (the most recent 200 that mention `prefix`) whose message
   * opens with it, oldest first, each with its whole message. How a caller finds what 10db's own
   * commits say: a commit a session made through the commit tool is never one, whatever its message,
   * because `commit` stamps each with the op trailer, and a message is the session's to write.
   */
  ownCommitsWithSubject(
    repo: string,
    branch: string,
    prefix: string,
  ): Promise<{ readonly sha: string; readonly message: string }[]>;
  /**
   * Fetches commit `sha` from origin's recorded fetch URL into the object store, naming no ref and
   * touching no branch or checkout: what GitHub made on a pull request (a branch update) and nobody
   * pulled. Throws a GitNetworkError when origin can't be asked or does not give it.
   */
  fetchCommit(repo: string, sha: string, net: NetworkCall): Promise<NetworkRun>;
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
   * Makes local branch `branch` point at commit `to`, which the object store must hold: made when
   * there is none, moved when `to` descends from the tip, 'unchanged' when it is there already. Never
   * a reset: a branch with commits `to` lacks, one checked out anywhere (main checkout, worktree,
   * rebase, bisect) or one that moved meanwhile is refused with an InvalidError, and nothing changes.
   */
  fastForwardBranch(
    repo: string,
    branch: string,
    to: string,
  ): Promise<'unchanged' | 'created' | 'moved'>;
  /**
   * Takes back a merge: moves `branch` from `from`, where it must be, to `to`, an ancestor of it,
   * which is where it was before the merge. Never more than that: any other tip, or a `to` the tip
   * does not descend from, is refused with an InvalidError and nothing changes. A branch `repo` has
   * checked out has its files follow through `read-tree -m -u`, which keeps uncommitted changes
   * elsewhere and refuses one in the way; one checked out anywhere else is refused.
   */
  rewindBranch(repo: string, branch: string, from: string, to: string): Promise<void>;
  // Branch moves of a closed Workbench pass (spec §5.3, §5.4: D8, D22, D24).
  /**
   * Moves local branch `branch` to commit `to` by compare-and-swap, under the repo lock: `moved` when
   * it was at `expect`, `already` when it is at `to` (a rerun), `raced` when it is anywhere else or
   * gone, and then nothing changes. A branch checked out in any worktree moves only to a commit whose
   * tree is its tip's, so no file and no index entry goes stale; any other such move is refused.
   */
  moveBranchCas(input: {
    readonly repo: string;
    readonly branch: string;
    readonly to: string;
    readonly expect: string;
  }): Promise<'moved' | 'already' | 'raced'>;
  /**
   * D22's Move: moves `branch`, which HEAD names at `from`, to commit `to`, its files following
   * through `read-tree -m -u` as the built switch writes them, under the repo lock. Uncommitted changes
   * the move does not write stay; one where it writes (`dirty`), or a file git does not track in the
   * way (`ignored`), refuses it and nothing changes, as does a HEAD on another branch or a branch no
   * longer at `from` (`moved`).
   */
  moveCheckedOutBranch(input: {
    readonly repo: string;
    readonly branch: string;
    readonly from: string;
    readonly to: string;
  }): Promise<SwitchBack>;
  /**
   * D24: brings commit `theirs` into `branch` by one merge commit whose tree is the branch tip's own
   * (parents the tip, then `theirs`), signed as the builder's config asks, set by compare-and-swap,
   * under the repo lock; no file or index entry changes. `already` when the branch holds `theirs`.
   */
  mergeKeepingTree(input: {
    readonly repo: string;
    readonly branch: string;
    readonly theirs: string;
    readonly message: string;
  }): Promise<{ readonly kind: 'merged' | 'already'; readonly sha: string }>;
  /**
   * Where `branch` is in use in a worktree of `repo` other than `repo` itself: checked out there, or
   * being rebased or bisected there. Null when none is.
   */
  branchInUseElsewhere(repo: string, branch: string): Promise<string | null>;
  /**
   * The commits `tip` has since `base` that are its own: first parents only, merges left out,
   * newest first. A merge of the base into the branch adds none, and neither do the commits it brought in.
   */
  ownCommitsSince(repo: string, base: string, tip: string): Promise<string[]>;
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
  /**
   * Deletes local branch `branch` while it is at `sha` and, in the same ref transaction, its
   * remote-tracking ref `refs/remotes/origin/<branch>` while it is at `tracking` (when given), then
   * drops the branch's `branch.<branch>` config section, as `git branch -D` does. True when deleted;
   * false when either ref is missing or moved, and then nothing changes.
   */
  deleteBranchIfAt(
    repo: string,
    branch: string,
    sha: string,
    tracking?: string | null,
  ): Promise<boolean>;
  /** The commit `refs/remotes/origin/<branch>` is at; null when there is no such ref. */
  trackingTip(repo: string, branch: string): Promise<string | null>;
  /**
   * Where local branch `branch` is in use: the main checkout or a worktree that has it checked out,
   * or is rebasing or bisecting it (which leaves it detached). Null when none is.
   */
  branchInUse(repo: string, branch: string): Promise<string | null>;
  /** The local branches whose names start with `prefix`, by name and sorted, each with its tip. */
  localBranches(repo: string, prefix: string): Promise<{ name: string; sha: string }[]>;
  /** The commit local branch `branch` is at; null when there is no such branch. */
  branchTip(repo: string, branch: string): Promise<string | null>;
  /** Ignored directories of the checkout, top-level and nested, without the trailing `/`. */
  ignoredDirectories(repo: string): Promise<string[]>;
  /**
   * The unified diff from `base` to `head`, read with no external diff program and no textconv
   * filter, cut to at most `maxBytes` of UTF-8 on a character boundary, plus the per-file counts
   * of the whole change. Renames are shown as a delete and an add. With `paths`, only the files it
   * names, or every file but those, each path matched as spelled.
   */
  diffSince(
    repo: string,
    base: string,
    head: string,
    maxBytes: number,
    paths?: DiffPaths,
  ): Promise<DiffSince>;
  /**
   * The commit `rev` names now, as a full object id. A caller that reads many folders and files of one
   * `rev` resolves it once and reads each from the id, so the reads cannot span a branch that moves.
   * A `rev` that names no commit is a `GitError`.
   */
  commitAt(repo: string, rev: string): Promise<string>;
  /**
   * The text of `path` in commit `rev`, read from the object store, never from the worktree, so no
   * link is followed: a path that is a link, or lies under one, is `not_regular` or `missing`. A
   * blob over `maxBytes` is not read.
   */
  fileAt(repo: string, rev: string, path: string, maxBytes: number): Promise<FileAt>;
  /**
   * The exact bytes of `path` in commit `rev`, read as `fileAt` reads: null for anything but a regular
   * file's blob of at most `maxBytes`.
   */
  bytesAt(repo: string, rev: string, path: string, maxBytes: number): Promise<Buffer | null>;
  /** The best common ancestor of two commits; null when they have none. */
  mergeBase(repo: string, one: string, other: string): Promise<string | null>;
  /**
   * What one folder of commit `rev` holds directly (`folder` a path from the root, `''` for the root):
   * its regular files, with each one's size in bytes, and its folders (never a link or a submodule),
   * each sorted by name. Read from the object store as `fileAt` reads, one folder and nothing below it,
   * so a caller walking a big tree pays only for the folders it visits. A folder that is not there
   * holds nothing; a `rev` git can't resolve is a `GitError`.
   */
  folderAt(repo: string, rev: string, folder: string): Promise<FolderAt>;
  /**
   * What the repository at or above `path` holds, read as git finds it with no pin: nothing is
   * written, nothing is pinned and no refusal reaches `onRefused`, so a folder the builder only
   * looks at raises no card. A repository git won't read is answered, not thrown.
   */
  inspect(path: string): Promise<RepoFacts | RepoRefusal>;
  /**
   * The tracked files of HEAD and the files of its latest `maxCommits` commits, read from the object
   * store as `inspect` reads: unpinned, nothing written, no refusal reaches `onRefused`. Git runs no
   * program the repository configures: only plumbing and `log` with no external diff, no textconv
   * and no signature check.
   */
  survey(path: string, maxCommits: number): Promise<RepoSurvey | RepoRefusal>;
  /**
   * The text of each of `paths` at HEAD of the repository at or above `path`, read as `survey` reads:
   * the object store only, unpinned, nothing written, no program the repository configures run. Only
   * a regular file of at most `options.maxBytes` that holds no NUL byte is answered; any other path is
   * left out, as is every path when git won't read the repository. A partial clone is not read at all
   * (a missing blob would be fetched, running its remote's programs), nor are files that together
   * hold more than `options.maxTotalBytes`; `refused` says which. `options.signal` stops between
   * batches.
   */
  surveyTexts(
    path: string,
    paths: readonly string[],
    options: SurveyTextsOptions,
  ): Promise<SurveyTexts>;
}

export interface SurveyTextsOptions {
  readonly maxBytes: number;
  readonly maxTotalBytes: number;
  readonly signal?: AbortSignal;
}

/** What `surveyTexts` read: each text by path, the bytes read, and why it read nothing, if it refused. */
export interface SurveyTexts {
  readonly texts: ReadonlyMap<string, string>;
  readonly bytes: number;
  readonly refused: string | null;
}

/** Said when `surveyTexts` meets a partial clone. */
const PARTIAL_CLONE_REFUSAL = 'a partial clone: page code is not read';
/** Said when the files `surveyTexts` is asked for hold more than it may read. */
export const OVER_BUDGET_REFUSAL =
  'the source is over what one read may take: page code is not read';
/** Said when `surveyTexts` can't read the repository's config to tell. */
const UNREAD_CONFIG_REFUSAL = "the repository's config could not be read: page code is not read";

export interface GitOptions {
  /** Called with every refusal, so the builder hears of it whoever called. */
  onRefused?(error: GitTrustError): void;
  /**
   * Called with the real path of a checkout refused for a moved git dir or a changed origin once it
   * is trusted again, so the cards that refused it can go: the builder's Trust answer pinned it, or
   * a later call found it exactly as pinned (the move or the origin was put back). Once per refusal.
   */
  onTrusted?(repo: string): void;
  /**
   * Called with the paths a commit left out because they are Claude Code's own bookkeeping (a staging
   * directory or lock in any `.claude/` folder), each with the behaviour that writes it, so the log can
   * show what was dropped.
   */
  onBookkeepingDropped?(repo: string, dropped: readonly { rel: string; writtenBy: string }[]): void;
  /**
   * Real paths of checkouts refused before this `Git` was made whose cards are still open, so a
   * call that finds one as pinned again tells `onTrusted` too.
   */
  refusedCheckouts?: Iterable<string>;
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

/** What the calls of one `Git.operation` share, by the checkout's real path. */
interface Operation {
  /**
   * Set once its function settles. A callback, timer or job started inside it (a bus listener, the
   * PR watch's next round) still sees it as the async context, but no longer shares anything.
   */
  finished: boolean;
  readonly pinned: Map<string, Pinned>;
  /** origin's URL by checkout and direction, with the config text it was read against. */
  readonly origin: Map<string, { readonly config: string; readonly url: string | null }>;
}

/** A checkout as git finds it on its own, for reading what it is now, before or beside its pin. */
/**
 * Marks the worktree root so macOS Spotlight skips everything under it: a worktree is temporary,
 * nobody searches it, and its node_modules and build output cost `mds_stores` a core. The marker
 * lies in the root, never in a worktree, so it is no change in any worktree's git status, and it is
 * there before the first worktree is. An existing entry is left as it is (`wx` also never follows
 * a link). The builder's own checkouts are never marked. Best effort: a root that can't hold the
 * marker costs indexing time, not a worktree.
 */
function keepSpotlightOut(root: string): void {
  try {
    writeFileSync(join(root, '.metadata_never_index'), '', { flag: 'wx', mode: 0o600 });
  } catch {
    // Already marked, or the marker can't be written.
  }
}

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
    const clean = checkPathName(p);
    if (!resolveInRepo(repo, clean).inside) {
      throw new InvalidError(
        `Path ${JSON.stringify(p)} must be relative and inside the repository`,
      );
    }
    return clean;
  });
}

/** The path, normalized, when it is relative and names no place above the repository. */
function checkPathName(p: string): string {
  const clean = normalize(p);
  if (p === '' || isAbsolute(p) || clean === '.' || clean === '..' || clean.startsWith(`..${sep}`))
    throw new InvalidError(`Path ${JSON.stringify(p)} must be relative and inside the repository`);
  return clean;
}

/**
 * Whether a part of the folder on the way to `rel` is a link or not a directory. Git keeps no file
 * beyond either, so the path is not there, and nothing is read or written through it. A path itself
 * may be a link: git keeps the link, never what it points at.
 */
function blockedOnTheWay(real: string, rel: string): boolean {
  let at = real;
  for (const part of rel.split(sep).slice(0, -1)) {
    at = join(at, part);
    const entry = lstatSync(at, { throwIfNoEntry: false });
    if (entry === undefined) return false;
    if (!entry.isDirectory()) return true;
  }
  return false;
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
  // Checkouts refused for a state the builder can trust (a moved git dir, a changed origin) and not
  // trusted since: a call that finds one exactly as pinned again tells `onTrusted`. Kept in memory,
  // so the check costs a lookup on every other call.
  const refused = new Set(opts.refusedCheckouts);
  // What the calls of one `operation` share: each checkout's pin check and origin's URLs, read once.
  const operations = new AsyncLocalStorage<Operation>();
  /** The operation running now, or undefined outside one or in a context an ended one left. */
  function currentOperation(): Operation | undefined {
    const op = operations.getStore();
    return op && !op.finished ? op : undefined;
  }

  function refusal(repo: string, detail: GitTrustDetail): GitTrustError {
    const error = new GitTrustError(repo, detail);
    if (detail.kind === GitTrustFailure.Moved || detail.kind === GitTrustFailure.Origin)
      refused.add(repo);
    opts.onRefused?.(error);
    return error;
  }

  /** Tells `onTrusted` once that `real` is trusted again; later calls for it do nothing. */
  function trustedAgain(real: string): void {
    if (refused.delete(real)) opts.onTrusted?.(real);
  }

  /**
   * After a call passed the pin check for a refused checkout: whether its origin is the pinned one
   * too, as `retrust` compares it. A read that fails leaves it refused, and the call goes on.
   */
  async function settleRefused(real: string, pin: CheckoutPin): Promise<void> {
    try {
      const fetchUrl = await pinnableUrl(observed(real), false);
      const pushUrl = await pinnableUrl(observed(real), true);
      if (fetchUrl === pin.fetchUrl && pushUrl === pin.pushUrl) trustedAgain(real);
    } catch {
      // Still refused: the next call looks again.
    }
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
    if (
      !sameCheckoutIdentity(now.id, pin.id) ||
      now.gitDir !== pin.gitDir ||
      now.commonDir !== pin.commonDir
    )
      return refusal(real, {
        kind: GitTrustFailure.Moved,
        pinned: pin.gitDir,
        found: now.gitDir,
        pin,
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
    const op = currentOperation();
    const held = op?.pinned.get(real);
    if (held && !refused.has(real) && samePin(pins.get(real), held.pin) && stillThere(held)) {
      // Found as pinned by the operation's first call, and the pin store still holds that pin (a
      // `retrust` since replaces it). The git dirs' identity and the files in them are read again,
      // as they cost no spawn; only `rev-parse` is skipped. A refused checkout always takes the full
      // path, so a call that finds it as pinned again closes its card.
      checkGitDirFiles(real, held.dirs);
      return held;
    }
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
    } else if (
      !sameCheckoutIdentity(pin.id, id) ||
      pin.gitDir !== dirs.gitDir ||
      pin.commonDir !== dirs.commonDir
    ) {
      throw mismatch(real, pin, await observe(real));
    }
    checkGitDirFiles(real, dirs);
    if (refused.has(real)) await settleRefused(real, pin);
    const checked = { real, dirs, pin, env: { GIT_DIR: pin.gitDir, GIT_WORK_TREE: real } };
    op?.pinned.set(real, checked);
    return checked;
  }

  /** Whether the pin store's pin is the one held, field by field (a database store parses anew). */
  function samePin(stored: CheckoutPin | undefined, held: CheckoutPin): boolean {
    return (
      stored?.id === held.id &&
      stored.gitDir === held.gitDir &&
      stored.commonDir === held.commonDir &&
      stored.fetchUrl === held.fetchUrl &&
      stored.pushUrl === held.pushUrl
    );
  }

  /**
   * Whether the git dirs a checkout was found with are still those directories, by device and inode.
   * A `.git` moved aside and replaced, or gone, is not: the full check then runs and refuses it.
   */
  function stillThere(held: Pinned): boolean {
    try {
      return sameCheckoutIdentity(held.pin.id, checkoutIdentity(held.dirs));
    } catch {
      return false;
    }
  }

  /** Refuses a checkout whose object store borrows from another, or whose git dirs hold attributes. */
  function checkGitDirFiles(real: string, dirs: Pinned['dirs']): void {
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
  }

  /**
   * origin's URL as `originUrl` reads it, once per operation while the repository's config files
   * read the same: a gate or a lane that rewrites origin between two calls is seen by the second.
   * A config that includes another file is never reused, as the included file is not watched.
   * Outside an operation every call reads.
   */
  async function originUrlOnce(c: Pinned, push: boolean): Promise<string | null> {
    const op = currentOperation();
    if (!op) return originUrl(c, push);
    const config = ['config', 'config.worktree']
      .map((name) =>
        readIfPresent(join(name === 'config' ? c.dirs.commonDir : c.dirs.gitDir, name)),
      )
      .join('\0');
    const reusable = !/^\s*\[\s*include/im.test(config);
    const key = `${c.real}\0${push ? 'push' : 'fetch'}`;
    const held = op.origin.get(key);
    if (reusable && held?.config === config) return held.url;
    const url = await originUrl(c, push);
    if (reusable) op.origin.set(key, { config, url });
    return url;
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
    return findCommitByTrailer(c, tip, OP_TRAILER, opId);
  }

  /** The newest commit on `tip`'s first-parent line whose `key` trailer names `value`, or null. */
  async function findCommitByTrailer(
    c: Pinned,
    tip: string,
    key: string,
    value: string,
  ): Promise<string | null> {
    const out = await git(c, [
      'log',
      '--no-show-signature',
      // The branch's own line: a base merged in can carry the trailers of the lane commits a
      // squash-merged pull request folded in.
      '--first-parent',
      '-n',
      String(OP_SEARCH_DEPTH),
      `--format=%H%x1f%(trailers:key=${key},valueonly,separator=%x2c)%x1e`,
      tip,
    ]);
    for (const record of out.split('\x1e')) {
      const [sha, values] = record.trim().split('\x1f');
      if (
        sha &&
        OBJECT_ID.test(sha) &&
        values
          ?.split(',')
          .map((v) => v.trim())
          .includes(value)
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
    const current = await originUrlOnce(c, direction === 'push');
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
    keepChanges = false,
  ): Promise<SwitchBack> {
    const found = await currentBranch(c);
    if (found !== from) return { kind: 'moved', found };
    // What the files hold beyond HEAD, and what the checkout's own index holds beyond it: staged
    // work the files no longer show, or entries a commit made while another git held index.lock
    // left behind. Either way the merge below would lose or keep the wrong thing, so 10db leaves it,
    // or, keeping changes, leaves it where the switch writes.
    const paths = [...new Set([...(await changes(c)), ...(await stagedPaths(c))])].sort();
    if (paths.length > 0 && !keepChanges) return { kind: 'dirty', paths };
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
    const overlapping = paths.filter((path) => written.has(path));
    if (overlapping.length > 0) return { kind: 'dirty', paths: overlapping };
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
    return branchInUse(c, branch, (path) => samePath(comparablePath(path), c.real));
  }

  /**
   * Where `branch` is in use in a worktree of the repository other than one `skip` names, or null:
   * checked out there, which `worktree list` shows, or being rebased or bisected there, which leaves
   * that worktree detached and shows only in its git dir.
   */
  async function branchInUse(
    c: Pinned,
    branch: string,
    skip: (path: string) => boolean = () => false,
  ): Promise<string | null> {
    const entries = await listWorktrees(c);
    const out = entries.find((e) => e.branch === branch && !skip(e.path));
    if (out) return comparablePath(out.path);
    const ref = `refs/heads/${branch}`;
    const busy = (gitDir: string): boolean =>
      ['rebase-merge', 'rebase-apply'].some(
        (dir) => readIfPresent(join(gitDir, dir, 'head-name')).trim() === ref,
      ) || readIfPresent(join(gitDir, 'BISECT_START')).trim() === branch;
    const { commonDir, gitDir } = c.dirs;
    // The git dir that is `c`'s own is skipped with `c`.
    const own = (dir: string): boolean => samePath(dir, gitDir) && skip(c.real);
    const linked = join(commonDir, 'worktrees');
    const names = existsAsEntry(linked) ? readdirSync(linked) : [];
    for (const name of names) {
      const dir = join(linked, name);
      if (own(dir) || !busy(dir)) continue;
      // `gitdir` names the worktree's `.git` file.
      const path = dirname(readIfPresent(join(dir, 'gitdir')).trim());
      if (!skip(path)) return comparablePath(path);
    }
    if (!own(commonDir) && busy(commonDir)) {
      const main = entries.find((e) => !e.bare);
      if (main && !skip(main.path)) return comparablePath(main.path);
    }
    return null;
  }

  /** The index entries a commit covers, from a private index after `git add`; refused if unsafe. */
  async function stage(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    allNamed: readonly string[],
    tip: string,
  ): Promise<string[]> {
    const { real } = c;
    // Claude Code's bookkeeping is never named to `git add`: git refuses a named path an ignore rule covers
    // (a .gitignore, or the user's default excludes file), so an ignore rule would decide whether the commit
    // works. What is left out here is logged with what is put back below.
    const left: { rel: string; writtenBy: string }[] = [];
    const named = allNamed.filter((rel) => {
      const entries = bookkeepingEntryAt(real, rel);
      if (entries.length === 0) return true;
      left.push({ rel, writtenBy: entries.map((e) => e.writtenBy).join(' ') });
      return false;
    });
    for (const name of named) {
      const embedded = embeddedRepository(real, name);
      if (embedded !== null)
        throw refusal(real, { kind: GitTrustFailure.Embedded, path: embedded });
    }
    // With nothing left to name, `git add -A --` would stage the whole tree.
    if (named.length > 0) {
      try {
        await git(c, ['add', '-A', '--', ...named], { env });
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        if (/pathspec .* did not match/i.test(error.stderr))
          throw new InvalidError(
            `No file or change at ${allNamed.join(', ')}: a path must exist or have been deleted since the last commit`,
          );
        throw new InvalidError(`10db could not stage ${allNamed.join(', ')}: ${error.message}`);
      }
    }
    let changed = (
      await git(c, ['diff-index', '--cached', '--name-only', '-z', '--no-renames', tip], { env })
    )
      .split('\0')
      .filter(Boolean);
    // Bookkeeping that a named folder held, in any `.claude/` folder, never goes into a commit either: it is
    // put back as the tip has it.
    const bookkeeping = changed.flatMap((rel) => {
      const entries = leftOutOfCommits(real, rel);
      return entries.length > 0
        ? [{ rel, writtenBy: entries.map((e) => e.writtenBy).join(' ') }]
        : [];
    });
    if (bookkeeping.length > 0) {
      const putBack = new Set(bookkeeping.map((b) => b.rel));
      await git(c, ['reset', '-q', tip, '--', ...putBack], { env });
      changed = changed.filter((rel) => !putBack.has(rel));
      left.push(...bookkeeping);
    }
    // The daemon log says what was left out.
    if (left.length > 0) opts.onBookkeepingDropped?.(real, left);
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
    /** The common ancestor to merge from instead of the merge base: a revert merges from the reverted commit. */
    base?: string,
  ): Promise<{ tree: string; conflicted: string[]; entries: ConflictEntry[] }> {
    // diff3 style shows the common ancestor's lines in each conflict, which is how a conflict of two
    // insertions is told from two edits of the same line.
    const [tree = '', ...rest] = (
      await git(
        c,
        [
          'merge-tree',
          '--write-tree',
          '--no-messages',
          '-z',
          ...(base === undefined ? [] : [`--merge-base=${base}`]),
          ours,
          theirs,
        ],
        {
          answerExitCodes: [1],
          config: ['-c', 'merge.conflictStyle=diff3'],
        },
      )
    ).split('\0');
    if (!OBJECT_ID.test(tree)) throw new GitError(['merge-tree'], 'merge-tree named no tree', null);
    const entries: ConflictEntry[] = [];
    for (const chunk of rest) {
      const match = CONFLICT_ENTRY.exec(chunk);
      if (match)
        entries.push({
          mode: match[1] ?? '',
          oid: match[2] ?? '',
          stage: Number(match[3]),
          path: match[4] ?? '',
        });
    }
    return { tree, conflicted: [...new Set(entries.map((e) => e.path))].sort(), entries };
  }

  /** The text of the blob at `path` in `tree`, null when it isn't text 10db can merge by line. */
  async function mergeableText(c: Pinned, tree: string, path: string): Promise<string | null> {
    const size = Number((await git(c, ['cat-file', '-s', `${tree}:${path}`])).trim());
    if (!Number.isFinite(size) || size > RESOLVABLE_BYTES) return null;
    const text = await git(c, ['cat-file', 'blob', `${tree}:${path}`]);
    return text.includes('\0') || text.includes('�') ? null : text;
  }

  /** What one conflicted text file comes to: its merged blob, or why it stays a conflict. */
  async function resolveFile(
    c: Pinned,
    tree: string,
    path: string,
    sides: ReadonlyMap<number, ConflictEntry>,
  ): Promise<{ oid: string; mode: string } | { reason: string; markers?: true }> {
    if (path === 'pnpm-lock.yaml' || path.endsWith('/pnpm-lock.yaml'))
      return { reason: "pnpm's lockfile is made by pnpm, not merged by line" };
    // Both sides appending a migration only adds lines, so a line merge would number two alike.
    if (path === 'meta/_journal.json' || path.endsWith('/meta/_journal.json'))
      return {
        reason: "drizzle numbers its migrations in order, so its journal isn't merged by line",
      };
    const base = sides.get(1);
    const ours = sides.get(2);
    const theirs = sides.get(3);
    if (!base) return { reason: 'both sides added this file' };
    if (!ours || !theirs) return { reason: 'one side deleted this file and the other changed it' };
    if (
      ours.mode !== theirs.mode ||
      !REGULAR_FILE_MODES.includes(ours.mode) ||
      !REGULAR_FILE_MODES.includes(base.mode)
    )
      return { reason: "the sides differ in the file's type or mode, or it isn't a regular file" };
    const text = await mergeableText(c, tree, path);
    if (text === null) return { reason: "it isn't a text file small enough to merge by line" };
    const resolution = resolveAddedLines(text);
    if (resolution.kind === 'unresolved')
      return resolution.reason === BOTH_CHANGED
        ? { reason: resolution.reason, markers: true }
        : { reason: resolution.reason };
    if (path.endsWith('.json')) {
      try {
        JSON.parse(resolution.text);
      } catch {
        return { reason: 'the merged file is not valid JSON' };
      }
    }
    const oid = (await git(c, ['hash-object', '-w', '--stdin'], { input: resolution.text })).trim();
    return { oid, mode: ours.mode };
  }

  /** The files of `dir` in commit `rev`. */
  async function filesUnder(c: Pinned, rev: string, dir: string): Promise<string[]> {
    return (await git(c, ['ls-tree', '-r', '--name-only', '-z', rev, '--', dir]))
      .split('\0')
      .filter(Boolean);
  }

  /**
   * Settles `entries`, the conflicts of the merge of `from` into `tip` whose tree is `tree`: the
   * tree with them settled, or why some stay conflicts. Objects only; nothing is written to the
   * checkout.
   */
  async function resolveConflicts(
    c: Pinned,
    tip: string,
    from: string,
    tree: string,
    entries: readonly ConflictEntry[],
    { generated, generatedHeld, leaveMarkers }: NonNullable<MergeIntoBranchInput['resolve']>,
  ): Promise<
    | {
        kind: 'resolved';
        tree: string;
        resolved: ResolvedConflict[];
        regenerate: { dir: string; dropped: string[] }[];
        /** Conflicted text files left as git's markers wrote them (`leaveMarkers`). */
        marked: string[];
      }
    | { kind: 'unresolved'; unresolved: UnresolvedConflict[] }
  > {
    const sides = new Map<string, Map<number, ConflictEntry>>();
    for (const entry of entries) {
      const found = sides.get(entry.path) ?? new Map<number, ConflictEntry>();
      found.set(entry.stage, entry);
      sides.set(entry.path, found);
    }
    const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    const unresolved: UnresolvedConflict[] = [];
    const markable = new Set<string>();
    const merged: { path: string; oid: string; mode: string }[] = [];
    const dirs = new Set<string>();
    for (const [path, found] of [...sides].sort(([a], [b]) => byPath(a, b))) {
      const dir = generated.find((prefix) => path.startsWith(prefix));
      if (dir !== undefined && generatedHeld !== undefined) {
        unresolved.push({ path, reason: generatedHeld });
        continue;
      }
      if (dir !== undefined) {
        dirs.add(dir);
        continue;
      }
      const file = await resolveFile(c, tree, path, found);
      if ('reason' in file) {
        unresolved.push({ path, reason: file.reason });
        if (file.markers) markable.add(path);
      } else merged.push({ path, ...file });
    }
    // Markers are left only when every conflict that stays is one they show: otherwise some of the
    // merge is a choice no session can see in the files, and it stays the builder's.
    const marking = leaveMarkers === true && unresolved.every((u) => markable.has(u.path));
    if (unresolved.length > 0 && !marking) return { kind: 'unresolved', unresolved };
    const regenerate: { dir: string; dropped: string[] }[] = [];
    for (const dir of [...dirs].sort()) {
      const theirs = new Set(await filesUnder(c, from, dir));
      const dropped = (await filesUnder(c, tip, dir)).filter((file) => !theirs.has(file)).sort();
      regenerate.push({ dir, dropped });
    }
    const resolved: ResolvedConflict[] = [
      ...merged.map((m): ResolvedConflict => ({ path: m.path, how: 'kept_both' })),
      ...regenerate.map((r): ResolvedConflict => ({ path: r.dir, how: 'regenerated' })),
    ].sort((a, b) => byPath(a.path, b.path));
    const settled = await withPrivateIndex(c, tree, async (env) => {
      for (const m of merged)
        await git(c, ['update-index', '--add', '--cacheinfo', `${m.mode},${m.oid},${m.path}`], {
          env,
        });
      for (const { dir } of regenerate) {
        const bare = dir.replace(/\/+$/, '');
        await git(c, ['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', bare], { env });
        if ((await revParse(c, `${from}:${bare}`)) !== null)
          await git(c, ['read-tree', `--prefix=${bare}/`, `${from}:${bare}`], { env });
      }
      return (await git(c, ['write-tree'], { env })).trim();
    });
    return {
      kind: 'resolved',
      tree: settled,
      resolved,
      regenerate,
      marked: unresolved.map((u) => u.path),
    };
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

  /**
   * The paths a private index differs from `tip` by, each with its blob; null for one it lacks.
   * Refused for a path the index now holds as a nested repository, whose content the record can't
   * hold.
   */
  async function indexChanges(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    tip: string,
  ): Promise<{ path: string; blob: string | null }[]> {
    const fields = (
      await git(c, ['diff-index', '--cached', '--raw', '--no-renames', '-z', tip], { env })
    ).split('\0');
    const found: { path: string; blob: string | null }[] = [];
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const [, , mode, , blob, status] = (fields[at] ?? '').split(/[: ]/);
      const parsed = IndexChange.safeParse({ path: fields[at + 1], mode, blob, status });
      if (!parsed.success)
        throw new GitError(['diff-index'], 'diff-index printed a record 10db cannot read', null);
      const change = parsed.data;
      if (change.mode === GitMode.Gitlink)
        throw new InvalidError(
          `${change.path} became a nested repository while the pass was opening; open it again`,
        );
      found.push({ path: change.path, blob: change.status === 'D' ? null : change.blob });
    }
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The operation git left waiting in the worktree, or null when none is. */
  function operationIn(c: Pinned): OperationInProgress | null {
    const busy = OPERATIONS_IN_PROGRESS.find(({ entry }) =>
      existsAsEntry(join(c.dirs.gitDir, entry)),
    );
    return busy === undefined ? null : { what: busy.what, end: busy.end };
  }

  async function openPassBranch(input: PassBranchInput): Promise<PassBranch> {
    if (!input.dirtRef.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${input.dirtRef} is not under ${KEPT_REF_PREFIX}`);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      // Checked first: a rebase leaves HEAD detached, and saying so would hide why.
      const busy = operationIn(c);
      if (busy)
        throw new InvalidError(
          `${c.real} is in the middle of ${busy.what}; finish it or stop it (${busy.end}) before opening a pass`,
        );
      const startSha = await revParse(c, 'HEAD^{commit}');
      if (startSha === null) throw new InvalidError(`${c.real} has no commit yet`);
      const returnBranch = await currentBranch(c);
      if (returnBranch === null)
        throw new InvalidError(
          `${c.real} is on a detached HEAD; a pass needs a branch to return the folder to`,
        );
      const ref = `refs/heads/${input.branch}`;
      if ((await revParse(c, ref)) !== null)
        throw new InvalidError(`A branch named ${input.branch} already exists`);
      // A nested repository is no file of the folder's: its content is its own. git refuses to add
      // one with no commit and keeps one with a commit as a submodule entry, so neither is named, and
      // the dirt and its commit's tree leave it out alike.
      const paths = (await changes(c)).filter(
        (path) => !path.endsWith('/') && embeddedRepository(c.real, path) === null,
      );
      const { tree, dirt } = await withPrivateIndex(c, startSha, async (env) => {
        // On stdin, so no number of paths runs into the limit on a command's arguments.
        if (paths.length > 0)
          await git(c, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
            env,
            input: `${paths.join('\0')}\0`,
          });
        return {
          tree: (await git(c, ['write-tree'], { env })).trim(),
          dirt: await indexChanges(c, env, startSha),
        };
      });
      // Never pushed, so never signed. The trailers say where the pass opened, for start-up to take
      // back a pass the daemon stopped opening before its row was written.
      const dirtCommit = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', startSha], {
          input: `${input.message}\n\n${PASS_BRANCH_TRAILER}: ${input.branch}\n${RETURN_BRANCH_TRAILER}: ${returnBranch}\n`,
        })
      ).trim();
      const zero = '0'.repeat(startSha.length);
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          '10db: pass dirt',
          input.dirtRef,
          dirtCommit,
          zero,
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(`${input.dirtRef} already exists`);
      }
      const undo = async (): Promise<void> => {
        await git(c, ['update-ref', '-d', input.dirtRef, dirtCommit]).catch(() => undefined);
        await git(c, ['update-ref', '-d', ref, startSha]).catch(() => undefined);
      };
      try {
        await git(c, ['update-ref', '--no-deref', '-m', '10db: pass', ref, startSha, zero]);
      } catch (error) {
        await undo();
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(
          `A branch named ${input.branch} already exists, or the name is not valid`,
        );
      }
      // A commit or a switch the builder made while the dirt was read: the pass would start elsewhere.
      if (
        (await currentBranch(c)) !== returnBranch ||
        (await revParse(c, 'HEAD^{commit}')) !== startSha
      ) {
        await undo();
        throw new InvalidError(`${c.real} moved while the pass was opening; open it again`);
      }
      // The branch is at HEAD's own commit, so naming it moves no file and no index entry.
      await git(c, ['symbolic-ref', '-m', '10db: pass', 'HEAD', ref]);
      return { returnBranch, startSha, dirt, dirtCommit };
    });
  }

  async function undoPassBranch(input: {
    readonly repo: string;
    readonly branch: string;
    readonly returnBranch: string;
    readonly startSha: string;
    readonly dirtRef: string;
  }): Promise<boolean> {
    if (!input.dirtRef.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${input.dirtRef} is not under ${KEPT_REF_PREFIX}`);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      // Stopped before the branch was made: HEAD never moved, and the dirt's record is all there is.
      if ((await revParse(c, ref)) === null) {
        await git(c, ['update-ref', '--no-deref', '-d', input.dirtRef]).catch(() => undefined);
        return true;
      }
      if ((await currentBranch(c)) !== input.branch) return false;
      if ((await revParse(c, `${ref}^{commit}`)) !== input.startSha) return false;
      if ((await revParse(c, `refs/heads/${input.returnBranch}^{commit}`)) !== input.startSha)
        return false;
      await git(c, [
        'symbolic-ref',
        '-m',
        '10db: pass undone',
        'HEAD',
        `refs/heads/${input.returnBranch}`,
      ]);
      await git(c, ['update-ref', '-d', ref, input.startSha]).catch(() => undefined);
      await git(c, ['update-ref', '--no-deref', '-d', input.dirtRef]).catch(() => undefined);
      return true;
    });
  }

  async function passDirtRecords(repo: string): Promise<PassDirtRecord[]> {
    const c = await pinned(repo);
    const refs = await git(c, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
      `${KEPT_REF_PREFIX}passes/`,
    ]);
    const found: PassDirtRecord[] = [];
    for (const line of refs.split('\n').filter(Boolean)) {
      const [ref = '', sha = ''] = line.split('\0');
      if (!ref.endsWith('/dirt') || !OBJECT_ID.test(sha)) continue;
      const trailer = (key: string): string => `%(trailers:key=${key},valueonly,separator=%x2c)`;
      const [startSha, branch, returnBranch] = (
        await git(c, [
          'log',
          '-1',
          '--no-show-signature',
          `--format=%P%x1f${trailer(PASS_BRANCH_TRAILER)}%x1f${trailer(RETURN_BRANCH_TRAILER)}`,
          sha,
        ])
      )
        .trim()
        .split('\x1f')
        .map((field) => field.trim());
      const record = PassDirtTrailers.safeParse({ startSha, branch, returnBranch });
      if (record.success) found.push({ ref, ...record.data });
    }
    return found;
  }

  async function keepWork(input: KeepWorkInput): Promise<KeptCommit> {
    if (!input.ref.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${input.ref} is not under ${KEPT_REF_PREFIX}`);
    const named = input.paths.map(checkPathName);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const head = await currentBranch(c);
      if (head !== input.branch) throw new PassFolderOffBranchError(c.real, input.branch, head);
      const tip = await revParse(c, `refs/heads/${input.branch}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      const held = await revParse(c, `${input.ref}^{commit}`);
      if (held !== null) {
        const { key, value } = input.trailer;
        // Only the ref's own commit: an older one of the chain is not a rerun's answer, since the
        // work kept after it would read as undone.
        const found = await findCommitByTrailer(c, held, key, value);
        if (found === held) return { sha: found, base: tip, made: true };
      }
      if (held !== input.parent) throw new KeptRefMovedError(input.ref, input.parent, held);
      // HEAD names the branch, so what differs from HEAD is what differs from the tip; an ignored
      // file git doesn't track is never among it.
      // A path beyond a link or a file is not there for git: kept as gone.
      const blocked = named.filter((path) => blockedOnTheWay(c.real, path));
      const open = named.filter((path) => !blocked.includes(path));
      const changed = open.length === 0 ? [] : await changes(c, open);
      const tree = await withPrivateIndex(c, tip, async (env) => {
        await stage(c, env, changed, tip);
        if (blocked.length > 0)
          await git(c, ['update-index', '--force-remove', '-z', '--stdin'], {
            env,
            input: `${blocked.join('\0')}\0`,
          });
        return (await git(c, ['write-tree'], { env })).trim();
      });
      const parent = input.parent ?? tip;
      if (tree === (await revParse(c, `${parent}^{tree}`)))
        return { sha: input.parent, base: tip, made: false };
      // Never pushed, so never signed.
      const sha = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', parent], {
          input: `${input.message.trimEnd()}\n\n${input.trailer.key}: ${input.trailer.value}\n`,
        })
      ).trim();
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          '10db: kept work',
          input.ref,
          sha,
          held ?? '0'.repeat(sha.length),
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new KeptRefMovedError(input.ref, held, await revParse(c, `${input.ref}^{commit}`));
      }
      return { sha, base: tip, made: true };
    });
  }

  /**
   * Puts each of `paths` into a private index as the folder holds it, git's ignore rules aside: a
   * regular file or a link is hashed, anything else, or nothing, leaves no entry, as does a path
   * beyond a link or a file.
   */
  async function indexAsOnDisk(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    paths: readonly string[],
  ): Promise<void> {
    const present: string[] = [];
    const absent: string[] = [];
    for (const path of paths) {
      const entry = blockedOnTheWay(c.real, path)
        ? undefined
        : lstatSync(join(c.real, path), { throwIfNoEntry: false });
      (entry?.isFile() === true || entry?.isSymbolicLink() === true ? present : absent).push(path);
    }
    if (present.length > 0)
      await git(c, ['update-index', '--add', '-z', '--stdin'], {
        env,
        input: `${present.join('\0')}\0`,
      });
    if (absent.length > 0)
      await git(c, ['update-index', '--force-remove', '-z', '--stdin'], {
        env,
        input: `${absent.join('\0')}\0`,
      });
  }

  async function pageChanges(
    repo: string,
    tip: string,
    pages: readonly string[],
  ): Promise<LineChange[]> {
    const named = pages.map(checkPathName);
    if (named.length === 0) return [];
    const c = await pinned(repo);
    const out = await withPrivateIndex(c, tip, async (env) => {
      await indexAsOnDisk(c, env, named);
      return git(c, ['diff-index', '--cached', '--numstat', '-z', '--no-renames', tip], { env });
    });
    const asked = new Set(named);
    return parseNumstat(out)
      .filter((file) => asked.has(file.path))
      .map((file) => ({ path: file.path, added: file.added ?? 0, removed: file.removed ?? 0 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  async function hashOnDisk(repo: string, paths: readonly string[]): Promise<PathEntry[]> {
    const named = [...new Set(paths.map(checkPathName))].sort();
    if (named.length === 0) return [];
    const c = await pinned(repo);
    const listed = await withPrivateIndex(c, null, async (env) => {
      await indexAsOnDisk(c, env, named);
      return git(c, ['ls-files', '-s', '-z'], { env });
    });
    const entries = new Map(
      listed
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf('\t');
          const [mode = '', oid = ''] = record.slice(0, tab).split(' ');
          return [record.slice(tab + 1), { mode, oid }] as const;
        }),
    );
    return named.map((path) => ({
      path,
      blob: entries.get(path)?.oid ?? null,
      mode: entries.get(path)?.mode ?? null,
    }));
  }

  /** What each of `paths` holds in a private index, by path; null for one it has no entry for. */
  async function indexBlobs(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    paths: readonly string[],
  ): Promise<PathBlob[]> {
    if (paths.length === 0) return [];
    const listed = await git(c, ['ls-files', '-s', '-z', '--', ...paths], { env });
    const blobs = new Map(
      listed
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf('\t');
          const [, oid = ''] = record.slice(0, tab).split(' ');
          return [record.slice(tab + 1), oid] as const;
        }),
    );
    return paths.map((path) => ({ path, blob: blobs.get(path) ?? null }));
  }

  /** The tree of commit `base` with each of `paths` as the folder has it, and what each then holds. */
  async function treeWithDisk(
    c: Pinned,
    base: string,
    paths: readonly string[],
  ): Promise<{ readonly tree: string; readonly files: PathBlob[] }> {
    return withPrivateIndex(c, base, async (env) => {
      await indexAsOnDisk(c, env, paths);
      return {
        tree: (await git(c, ['write-tree'], { env })).trim(),
        files: await indexBlobs(c, env, paths),
      };
    });
  }

  /** Sets each of `paths` in a private index as commit `from` has it, or removes it where it lacks it. */
  async function takeInto(
    c: Pinned,
    env: { GIT_INDEX_FILE: string; GIT_LITERAL_PATHSPECS: string },
    from: string,
    paths: readonly string[],
  ): Promise<void> {
    for (const path of paths) {
      const entry = await treeEntry(c, from, path);
      await git(
        c,
        entry === null
          ? ['update-index', '--force-remove', '--', path]
          : ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`],
        { env },
      );
    }
  }

  async function recordPaths(input: {
    readonly repo: string;
    readonly base: string;
    readonly paths: readonly string[];
  }): Promise<PathRecord> {
    const named = [...new Set(input.paths.map(checkPathName))].sort();
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const base = await revParse(c, `${input.base}^{commit}`);
      if (base === null) throw new InvalidError(`${input.base} names no commit`);
      const { tree, files } = await treeWithDisk(c, base, named);
      // Never pushed, so never signed.
      const sha = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', base], {
          input: '10db: shared hold record\n',
        })
      ).trim();
      return { sha, record: files };
    });
  }

  async function chainCommit(input: ChainCommitInput): Promise<ChainCommit> {
    if (!input.ref.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${input.ref} is not under ${KEPT_REF_PREFIX}`);
    const named = [...new Set(input.paths.map(checkPathName))].sort();
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const held = await revParse(c, `${input.ref}^{commit}`);
      if (held !== input.expect) throw new KeptRefMovedError(input.ref, input.expect, held);
      const tip = held ?? (await revParse(c, `${input.base}^{commit}`));
      if (tip === null) throw new InvalidError(`${input.base} names no commit`);
      const from = input.from;
      const restore = input.restore;
      const { tree, files } =
        restore !== undefined
          ? await withPrivateIndex(c, tip, async (env) => {
              if (from === undefined) await indexAsOnDisk(c, env, named);
              else await takeInto(c, env, from, named);
              const restored = [...new Set(restore.paths.map(checkPathName))].sort();
              await takeInto(c, env, restore.from, restored);
              return {
                tree: (await git(c, ['write-tree'], { env })).trim(),
                files: await indexBlobs(c, env, [...new Set([...named, ...restored])].sort()),
              };
            })
          : from === undefined
            ? await treeWithDisk(c, tip, named)
            : {
                tree: await treeTaking(c, tip, from, named),
                files: await Promise.all(
                  named.map(async (path) => ({
                    path,
                    blob: (await treeEntry(c, from, path))?.oid ?? null,
                  })),
                ),
              };
      const { key, value } = input.trailer;
      if (tree === (await revParse(c, `${tip}^{tree}`))) {
        // Nothing to add: the chain holds this change already when a commit of its own is on it.
        const own = held === null ? null : await findCommitByTrailer(c, held, key, value);
        return { sha: own, made: false, files };
      }
      // Never pushed, so never signed.
      const sha = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', tip], {
          input: `${input.message.trimEnd()}\n\n${key}: ${value}\n`,
        })
      ).trim();
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          '10db: shared change',
          input.ref,
          sha,
          held ?? '0'.repeat(sha.length),
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new KeptRefMovedError(input.ref, held, await revParse(c, `${input.ref}^{commit}`));
      }
      return { sha, made: true, files };
    });
  }

  async function landPaths(input: {
    readonly repo: string;
    readonly branch: string;
    readonly from: string;
    readonly paths: readonly string[];
    readonly message: string;
    readonly opId: string;
    readonly willRetry?: boolean;
  }): Promise<LandedPaths> {
    const named = [...new Set(input.paths.map(checkPathName))].sort();
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      if (await isSymbolic(c, ref))
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'symbolic' });
      const head = await currentBranch(c);
      if (head !== input.branch) throw new PassFolderOffBranchError(c.real, input.branch, head);
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      // Another git holding index.lock leaves the index stale, which the caller says.
      const followIndex = (sha: string): Promise<boolean> =>
        git(c, ['reset', '-q', sha, '--', ...named], {
          env: { GIT_LITERAL_PATHSPECS: '1' },
        }).then(
          () => false,
          () => true,
        );
      const existing = await findCommitByOp(c, tip, input.opId);
      // A rerun's index follows the branch too: the run it repeats may have stopped before it did.
      if (existing)
        return { sha: existing, alreadyLanded: true, indexStale: await followIndex(tip) };
      const from = await revParse(c, `${input.from}^{commit}`);
      if (from === null) throw new InvalidError(`${input.from} names no commit`);
      const tree = await treeTaking(c, tip, from, named);
      if (tree === (await revParse(c, `${tip}^{tree}`)))
        return { sha: null, alreadyLanded: false, indexStale: false };
      const sign = signing(c, await configEntries(c));
      const sha = (
        await git(c, ['commit-tree', ...sign.flags, tree, '-p', tip], {
          input: withOpTrailer(input.message, input.opId),
          config: sign.config,
        })
      ).trim();
      try {
        await git(c, ['update-ref', '--no-deref', '-m', `10db: ${input.opId}`, ref, sha, tip]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        const raced = { kind: GitTrustFailure.Ref, ref, reason: 'raced' } as const;
        throw input.willRetry === true ? new GitTrustError(c.real, raced) : refusal(c.real, raced);
      }
      return { sha, alreadyLanded: false, indexStale: await followIndex(sha) };
    });
  }

  /** The blob each of `paths` holds on disk; null for one that is not a file or a link. */
  async function blobsOnDisk(c: Pinned, paths: readonly string[]): Promise<Map<string, string>> {
    const listed = await withPrivateIndex(c, null, async (env) => {
      await indexAsOnDisk(c, env, paths);
      return git(c, ['ls-files', '-s', '-z'], { env });
    });
    return new Map(
      listed
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf('\t');
          const [, oid = ''] = record.slice(0, tab).split(' ');
          return [record.slice(tab + 1), oid] as const;
        }),
    );
  }

  /** The mode and blob `path` has in commit `rev`; null when it has none there. */
  async function treeEntry(
    c: Pinned,
    rev: string,
    path: string,
  ): Promise<{ readonly mode: string; readonly oid: string } | null> {
    const out = await git(c, ['ls-tree', '-z', '--full-tree', rev, '--', path], {
      env: { GIT_LITERAL_PATHSPECS: '1' },
    });
    const found = parseTree(out).find((entry) => entry.path === path);
    return found ? { mode: found.mode, oid: found.oid } : null;
  }

  async function restoreFiles(
    repo: string,
    entries: readonly { readonly path: string; readonly from: string }[],
    expect: readonly { readonly path: string; readonly blob: string | null }[],
  ): Promise<{ readonly written: string[]; readonly left: string[] }> {
    const named = entries.map((entry) => ({ path: checkPathName(entry.path), from: entry.from }));
    const expected = new Map(expect.map((e) => [e.path, e.blob]));
    return withRepoLock(realpathSync(repo), async () => {
      const c = await pinned(repo);
      const written: string[] = [];
      const left: string[] = [];
      for (const { path, from } of [...named].sort((a, b) => (a.path < b.path ? -1 : 1))) {
        const now = (await blobsOnDisk(c, [path])).get(path) ?? null;
        const target = await treeEntry(c, from, path);
        // Already as asked: a rerun after a restart writes nothing twice.
        if (now === (target?.oid ?? null)) {
          written.push(path);
          continue;
        }
        // Nothing is written beyond a link or a file: git would refuse, and a link may lead out.
        if (!expected.has(path) || expected.get(path) !== now || blockedOnTheWay(c.real, path)) {
          left.push(path);
          continue;
        }
        const file = join(c.real, path);
        const entry = lstatSync(file, { throwIfNoEntry: false });
        // A directory in the way may hold files git ignores: writing the path would remove them all.
        if (entry?.isDirectory() === true) {
          left.push(path);
          continue;
        }
        if (target === null) {
          if (entry) rmSync(file, { force: true });
          written.push(path);
          continue;
        }
        try {
          await withPrivateIndex(c, null, async (env) => {
            await git(
              c,
              ['update-index', '--add', '--cacheinfo', `${target.mode},${target.oid},${path}`],
              {
                env,
              },
            );
            // Git checks every directory on the way and writes nothing through a link.
            await git(c, ['checkout-index', '-f', '-q', '--', path], { env });
          });
          written.push(path);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          left.push(path);
        }
      }
      return { written, left };
    });
  }

  async function mergeFileBack(input: {
    readonly repo: string;
    readonly path: string;
    readonly base: string;
    readonly theirs: string;
  }): Promise<'merged' | 'conflict'> {
    const path = checkPathName(input.path);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      if (blockedOnTheWay(c.real, path)) return 'conflict';
      const base = await treeEntry(c, input.base, path);
      const theirs = await treeEntry(c, input.theirs, path);
      if (base?.oid === theirs?.oid && base?.mode === theirs?.mode) return 'merged';
      const file = join(c.real, path);
      const entry = lstatSync(file, { throwIfNoEntry: false });
      const regular = (e: { readonly mode: string } | null) =>
        e !== null && REGULAR_FILE_MODES.includes(e.mode);
      if (entry?.isFile() !== true || !regular(base) || !regular(theirs) || !base || !theirs)
        return 'conflict';
      const ours = readFileSync(file);
      const bytes = async (oid: string): Promise<Buffer> =>
        gitCapped(c, ['cat-file', 'blob', oid], RESOLVABLE_BYTES + 1);
      const sides = [ours, await bytes(base.oid), await bytes(theirs.oid)];
      // A file too big to merge by line is left, and named.
      if (sides.some((side) => side.length > RESOLVABLE_BYTES)) return 'conflict';
      const dir = mkdtempSync(join(tmpdir(), '10db-merge-'));
      try {
        const [oursAt, baseAt, theirsAt] = ['ours', 'base', 'theirs'].map((name, at) => {
          const where = join(dir, name);
          writeFileSync(where, sides[at] ?? Buffer.alloc(0));
          return where;
        });
        if (oursAt === undefined || baseAt === undefined || theirsAt === undefined)
          return 'conflict';
        try {
          await git(c, ['merge-file', '-q', oursAt, baseAt, theirsAt]);
        } catch (error) {
          if (error instanceof GitError) return 'conflict';
          throw error;
        }
        // The builder's editor is not under the lock: a file written while it merged is left.
        if (!readFileSync(file).equals(ours)) return 'conflict';
        writeFileSync(file, readFileSync(oursAt));
        return 'merged';
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  /** The tree of commit `base` with each of `paths` as commit `from` has it, or gone where it lacks it. */
  async function treeTaking(
    c: Pinned,
    base: string,
    from: string,
    paths: readonly string[],
  ): Promise<string> {
    return withPrivateIndex(c, base, async (env) => {
      for (const path of paths) {
        const entry = await treeEntry(c, from, path);
        await git(
          c,
          entry === null
            ? ['update-index', '--force-remove', '--', path]
            : ['update-index', '--add', '--cacheinfo', `${entry.mode},${entry.oid},${path}`],
          { env },
        );
      }
      return (await git(c, ['write-tree'], { env })).trim();
    });
  }

  /** The paths whose entries differ between commits `from` and `to`. */
  async function pathsBetween(c: Pinned, from: string, to: string): Promise<string[]> {
    return (await git(c, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]))
      .split('\0')
      .filter(Boolean);
  }

  async function moveKeptRef(
    repo: string,
    from: string,
    to: string,
    earlier?: KeptRefEarlier,
  ): Promise<string | null> {
    for (const ref of [from, to])
      if (!ref.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
    return withRepoLock(realpathSync(repo), async () => {
      const c = await pinned(repo);
      const sha = await revParse(c, `${from}^{commit}`);
      if (sha === null) return revParse(c, `${to}^{commit}`);
      const held = await revParse(c, `${to}^{commit}`);
      let moved = sha;
      if (held === earlier?.sha && held !== sha) {
        const keep: string[] = [];
        for (const path of await pathsBetween(c, earlier.base, earlier.sha)) {
          const ours = await treeEntry(c, sha, path);
          const was = await treeEntry(c, earlier.workBase, path);
          if (ours?.oid === was?.oid && ours?.mode === was?.mode) keep.push(path);
        }
        const tree = await treeTaking(c, sha, earlier.sha, keep);
        // Never pushed, so never signed.
        moved = (
          await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', sha, '-p', held], {
            input: 'Kept work, on the work kept before it\n',
          })
        ).trim();
        await git(c, ['update-ref', '--no-deref', '-m', '10db: kept work moved', to, moved, held]);
      } else if (
        held !== null &&
        held !== sha &&
        (await git(c, ['rev-list', '--parents', '-n', '1', held])).trim().split(' ').includes(sha)
      ) {
        // A rerun after the new commit was set: only `from` is left to go.
        moved = held;
      } else {
        await git(c, ['update-ref', '--no-deref', '-m', '10db: kept work moved', to, sha]);
      }
      await git(c, ['update-ref', '--no-deref', '-d', from, sha]);
      return moved;
    });
  }

  async function narrowKeptRef(
    repo: string,
    ref: string,
    kept: { readonly sha: string; readonly base: string },
    paths: readonly string[],
  ): Promise<string> {
    if (!ref.startsWith(KEPT_REF_PREFIX))
      throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
    const named = paths.map(checkPathName);
    return withRepoLock(realpathSync(repo), async () => {
      const c = await pinned(repo);
      const tree = await treeTaking(c, kept.base, kept.sha, named);
      const held = await revParse(c, `${ref}^{commit}`);
      if (
        held !== null &&
        held !== kept.sha &&
        (await revParse(c, `${held}^{tree}`)) === tree &&
        (await revParse(c, `${held}^1`)) === kept.sha
      )
        return held;
      // Never pushed, so never signed.
      const sha = (
        await git(c, ['commit-tree', '--no-gpg-sign', tree, '-p', kept.sha], {
          input: 'Kept work not yet back in the folder\n',
        })
      ).trim();
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          '10db: kept work narrowed',
          ref,
          sha,
          kept.sha,
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new KeptRefMovedError(ref, kept.sha, await revParse(c, `${ref}^{commit}`));
      }
      return sha;
    });
  }

  async function pointHeadAt(input: {
    readonly repo: string;
    readonly from: string;
    readonly to: string;
    readonly sha: string;
  }): Promise<boolean> {
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      if ((await currentBranch(c)) !== input.from) return false;
      for (const branch of [input.from, input.to])
        if ((await revParse(c, `refs/heads/${branch}^{commit}`)) !== input.sha) return false;
      if ((await branchInUseElsewhere(c, input.to)) !== null) return false;
      // Both branches are at the same commit, so naming the other moves no file and no index entry.
      await git(c, ['symbolic-ref', '-m', '10db: pass', 'HEAD', `refs/heads/${input.to}`]);
      return true;
    });
  }

  async function refreshIndex(repo: string, paths: readonly string[]): Promise<boolean> {
    const named = paths.map(checkPathName);
    if (named.length === 0) return true;
    const c = await pinned(repo);
    const env = { GIT_LITERAL_PATHSPECS: '1' };
    try {
      // `add --refresh` refuses a path the index does not hold, and stages nothing.
      const tracked = (await git(c, ['ls-files', '-z', '--', ...named], { env }))
        .split('\0')
        .filter(Boolean);
      if (tracked.length > 0) await git(c, ['add', '--refresh', '--', ...tracked], { env });
      return true;
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return false;
    }
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

  /** One fetch of the commit `sha` from origin's pinned fetch URL, into the object store only. */
  async function fetchCommitOnce(repo: string, sha: string, net: NetworkCall): Promise<NetworkRun> {
    if (!OBJECT_ID.test(sha)) throw new InvalidError(`${sha} is not a commit id`);
    const c = await pinned(repo);
    const network = await networkConfig(c, net);
    const url = await pinnedUrl(c, 'fetch');
    return gitNetwork(
      c.real,
      network.config,
      ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, sha],
      net,
      { bin, env: { ...c.env, ...network.env } },
    );
  }

  async function branchOnOriginOnce(
    repo: string,
    branch: string,
    net: NetworkCall,
  ): Promise<boolean> {
    const c = await pinned(repo);
    const network = await networkConfig(c, net);
    const url = await pinnedUrl(c, 'fetch');
    const ref = `refs/heads/${branch}`;
    const run = await gitNetwork(
      c.real,
      network.config,
      ['ls-remote', '--heads', '--', url, ref],
      net,
      { bin, env: { ...c.env, ...network.env } },
    );
    // Each answer line is `<sha>\t<ref>`; the pattern may match other refs, so compare the name.
    return run.output.split('\n').some((line) => line.trim().endsWith(`\t${ref}`));
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
      let resolved: ResolvedConflict[] = [];
      let regenerate: { dir: string; dropped: string[] }[] = [];
      let marked: string[] = [];
      if (!fastForward) {
        const merging = await mergeTree(c, tip, from);
        let tree = merging.tree;
        if (merging.conflicted.length > 0) {
          if (!input.resolve) return { kind: 'conflict', from, paths: merging.conflicted };
          const settled = await resolveConflicts(
            c,
            tip,
            from,
            tree,
            merging.entries,
            input.resolve,
          );
          if (settled.kind === 'unresolved')
            return {
              kind: 'conflict',
              from,
              paths: settled.unresolved.map((u) => u.path),
              unresolved: settled.unresolved,
              conflicted: merging.conflicted,
            };
          tree = settled.tree;
          resolved = settled.resolved;
          regenerate = settled.regenerate;
          marked = settled.marked;
        }
        const sign = signing(c, await configEntries(c));
        const settledNote = resolved.map((r) =>
          r.how === 'regenerated'
            ? `- ${r.path}: taken from ${input.from}, to be regenerated`
            : `- ${r.path}: both sides' added lines kept`,
        );
        const markedNote = marked.map((path) => `- ${path}: conflict markers left to resolve`);
        const message = [
          input.message,
          ...(settledNote.length === 0
            ? []
            : [`10db settled these conflicts:\n${settledNote.join('\n')}`]),
          ...(markedNote.length === 0
            ? []
            : [`10db left these conflicts for a session to resolve:\n${markedNote.join('\n')}`]),
        ].join('\n\n');
        head = (
          await git(c, ['commit-tree', ...sign.flags, tree, '-p', tip, '-p', from], {
            input: `${message}\n`,
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
      return {
        kind: 'merged',
        from,
        head,
        fastForward,
        paths,
        ...(resolved.length === 0 ? {} : { resolved, regenerate }),
        ...(marked.length === 0 ? {} : { marked }),
      };
    });
  }

  async function revertCommits(input: {
    readonly repo: string;
    readonly branch: string;
    readonly shas: readonly string[];
    readonly message: string;
  }): Promise<CommitsReverted> {
    // Inside the checkout's lock, so no commit of the daemon's moves the branch meanwhile.
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      if (await isSymbolic(c, ref))
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'symbolic' });
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} does not exist`);
      const current = await currentBranch(c);
      if (current !== input.branch)
        throw new InvalidError(
          `${c.real} is on ${current ?? 'a detached HEAD'}, not ${input.branch}, so 10db reverts nothing on it`,
        );
      // Each commit's parent, newest first: a later commit is undone before the ones it built on.
      const named: { readonly sha: string; readonly parent: string; readonly at: number }[] = [];
      for (const given of input.shas) {
        const sha = await revParse(c, `${given}^{commit}`);
        if (sha === null || !(await isAncestor(c, sha, tip)))
          throw new InvalidError(`${given} is not a commit of ${input.branch}`);
        const [, ...parents] = (await git(c, ['rev-list', '--parents', '-n', '1', sha]))
          .trim()
          .split(' ');
        if (parents.length !== 1 || parents[0] === undefined)
          throw new InvalidError(
            `${given} is a merge or a first commit, which 10db does not revert`,
          );
        const at = Number((await git(c, ['rev-list', '--count', sha])).trim());
        named.push({ sha, parent: parents[0], at });
      }
      named.sort((a, b) => b.at - a.at);
      const sign = signing(c, await configEntries(c));
      let top = tip;
      for (const { sha, parent } of named) {
        const reverting = await mergeTree(c, top, parent, sha);
        if (reverting.conflicted.length > 0)
          return { kind: 'conflict', paths: reverting.conflicted };
        // Each step is a commit only so the next merge has one to start from; the branch never names it.
        top = (
          await git(c, ['commit-tree', ...sign.flags, reverting.tree, '-p', top], {
            input: `Revert ${sha}\n`,
            config: sign.config,
          })
        ).trim();
      }
      if ((await revParse(c, `${top}^{tree}`)) === (await revParse(c, `${tip}^{tree}`)))
        return { kind: 'nothing' };
      const head = (
        await git(c, ['commit-tree', ...sign.flags, `${top}^{tree}`, '-p', tip], {
          input: `${input.message}\n`,
          config: sign.config,
        })
      ).trim();
      const needed = await filters(c, head);
      if (needed.length > 0) throw refusal(c.real, { kind: GitTrustFailure.Filter, paths: needed });
      const paths = (
        await git(c, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', tip, head])
      )
        .split('\0')
        .filter(Boolean)
        .sort();
      const marked: string[] = [];
      for (const path of paths) {
        const after = await mergeableText(c, head, path).catch(() => null);
        if (after === null || !hasConflictMarkers(after)) continue;
        const before = await mergeableText(c, tip, path).catch(() => null);
        if (before === null || !hasConflictMarkers(before)) marked.push(path);
      }
      if (marked.length > 0) return { kind: 'markers', paths: marked };
      const written = new Set(paths);
      const changed = (await changes(c)).filter((path) => written.has(path));
      if (changed.length > 0) return { kind: 'blocked', changed };
      // Fresh stat data, so read-tree doesn't take an unchanged file for an edited one and refuse.
      await git(c, ['update-index', '-q', '--ignore-submodules', '--refresh']).catch(
        () => undefined,
      );
      try {
        // Files first, then the branch: a crash between the two leaves the revert as uncommitted
        // edits, never the branch claiming files the checkout doesn't hold.
        await git(c, ['read-tree', '-m', '-u', tip, head]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(`10db could not write the revert into ${c.real}: ${error.message}`);
      }
      try {
        // Compare and swap on the branch itself, never through HEAD or a symbolic ref.
        await git(c, ['update-ref', '--no-deref', '-m', '10db: revert', ref, head, tip]);
      } catch (error) {
        await git(c, ['read-tree', '-m', '-u', head, tip]).catch(() => undefined);
        if (!(error instanceof GitError)) throw error;
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
      }
      return { kind: 'reverted', head, paths };
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
      keepSpotlightOut(root);
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

  async function fastForwardBranch(
    repo: string,
    branch: string,
    to: string,
  ): Promise<'unchanged' | 'created' | 'moved'> {
    if (!OBJECT_ID.test(to)) throw new InvalidError(`${to} is not a commit id`);
    return withRepoLock(realpathSync(repo), async () => {
      const c = await pinned(repo);
      const ref = `refs/heads/${branch}`;
      if ((await revParse(c, `${to}^{commit}`)) === null)
        throw new InvalidError(`${to} is not in the repository`);
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === to) return 'unchanged';
      const update = async (old: string): Promise<void> => {
        try {
          // The old value makes a branch that moved meanwhile, or one made meanwhile, a refusal.
          await git(c, ['update-ref', '--no-deref', ref, to, old]);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new InvalidError(
            `Branch ${branch} could not be set to ${to}: it changed, or the name is not valid`,
          );
        }
      };
      if (tip === null) {
        await update('0'.repeat(to.length));
        return 'created';
      }
      const holder = await branchInUse(c, branch);
      if (holder !== null)
        throw new InvalidError(
          `Branch ${branch} is checked out at ${holder}, so it can't be moved to ${to}`,
        );
      if (!(await isAncestor(c, tip, to)))
        throw new InvalidError(`Branch ${branch} is at ${tip}, which ${to} does not descend from`);
      await update(tip);
      return 'moved';
    });
  }

  async function moveBranchCas(input: {
    readonly repo: string;
    readonly branch: string;
    readonly to: string;
    readonly expect: string;
  }): Promise<'moved' | 'already' | 'raced'> {
    if (!OBJECT_ID.test(input.to) || !OBJECT_ID.test(input.expect))
      throw new InvalidError('A branch is moved between two commit ids');
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      if (await isSymbolic(c, ref))
        throw new InvalidError(`${ref} points at another branch, so 10db moves nothing there`);
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === input.to) return 'already';
      if (tip === null || tip !== input.expect) return 'raced';
      const holder = await branchInUse(c, input.branch);
      if (
        holder !== null &&
        (await revParse(c, `${input.to}^{tree}`)) !== (await revParse(c, `${tip}^{tree}`))
      )
        throw new InvalidError(
          `Branch ${input.branch} is checked out at ${holder}, so it moves only to a commit with the same files`,
        );
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          `10db: move to ${input.to}`,
          ref,
          input.to,
          input.expect,
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        return 'raced';
      }
      return 'moved';
    });
  }

  /** The last step of `moveCheckedOutBranch`: the branch moves by compare-and-swap. */
  async function moveRefOnly(
    c: Pinned,
    ref: string,
    from: string,
    target: string,
    found: string | null,
  ): Promise<SwitchBack> {
    try {
      await git(c, [
        'update-ref',
        '--no-deref',
        '-m',
        `10db: move to ${target}`,
        ref,
        target,
        from,
      ]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      return { kind: 'moved', found };
    }
    return { kind: 'switched' };
  }

  async function moveCheckedOutBranch(input: {
    readonly repo: string;
    readonly branch: string;
    readonly from: string;
    readonly to: string;
  }): Promise<SwitchBack> {
    if (!OBJECT_ID.test(input.from) || !OBJECT_ID.test(input.to))
      throw new InvalidError('A branch is moved between two commit ids');
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      const found = await currentBranch(c);
      if (found !== input.branch) return { kind: 'moved', found };
      if ((await revParse(c, `${ref}^{commit}`)) !== input.from) return { kind: 'moved', found };
      const target = await revParse(c, `${input.to}^{commit}`);
      if (target === null) return { kind: 'gone' };
      await git(c, ['update-index', '-q', '--ignore-submodules', '--refresh']).catch(
        () => undefined,
      );
      // A move a crash cut short after its files and index and before the branch: the index holds
      // the target's tree, so only the branch is left to move.
      const indexTree = await git(c, ['write-tree']).then(
        (out) => out.trim(),
        () => null,
      );
      if (indexTree !== null && indexTree === (await revParse(c, `${target}^{tree}`)))
        return moveRefOnly(c, ref, input.from, target, found);
      const paths = [...new Set([...(await changes(c)), ...(await stagedPaths(c))])];
      const written = new Set(
        (await git(c, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', input.from, target]))
          .split('\0')
          .filter(Boolean),
      );
      const overlapping = paths.filter((path) => written.has(path)).sort();
      if (overlapping.length > 0) return { kind: 'dirty', paths: overlapping };
      const inTheWay = await untrackedInTheWay(c, input.from, target, written);
      if (inTheWay.length > 0) return { kind: 'ignored', paths: inTheWay };
      try {
        await git(c, ['read-tree', '-m', '-u', input.from, target]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw new InvalidError(`10db could not move ${input.branch}'s files: ${error.message}`);
      }
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          `10db: move to ${target}`,
          ref,
          target,
          input.from,
        ]);
      } catch (error) {
        // The branch moved meanwhile: its files go back to what it held.
        await git(c, ['read-tree', '-m', '-u', target, input.from]).catch(() => undefined);
        if (!(error instanceof GitError)) throw error;
        return { kind: 'moved', found };
      }
      return { kind: 'switched' };
    });
  }

  async function mergeKeepingTree(input: {
    readonly repo: string;
    readonly branch: string;
    readonly theirs: string;
    readonly message: string;
  }): Promise<{ readonly kind: 'merged' | 'already'; readonly sha: string }> {
    if (!OBJECT_ID.test(input.theirs)) throw new InvalidError(`${input.theirs} is not a commit id`);
    return withRepoLock(realpathSync(input.repo), async () => {
      const c = await pinned(input.repo);
      const ref = `refs/heads/${input.branch}`;
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip === null) throw new InvalidError(`Branch ${input.branch} is not there`);
      if (await isAncestor(c, input.theirs, tip)) return { kind: 'already', sha: tip };
      const sign = signing(c, await configEntries(c));
      const sha = (
        await git(
          c,
          ['commit-tree', ...sign.flags, `${tip}^{tree}`, '-p', tip, '-p', input.theirs],
          {
            input: `${input.message}\n`,
            config: sign.config,
          },
        )
      ).trim();
      try {
        await git(c, [
          'update-ref',
          '--no-deref',
          '-m',
          '10db: merge keeping its tree',
          ref,
          sha,
          tip,
        ]);
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
      }
      return { kind: 'merged', sha };
    });
  }

  async function rewindBranch(
    repo: string,
    branch: string,
    from: string,
    to: string,
  ): Promise<void> {
    if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to))
      throw new InvalidError('A branch is rewound between two commit ids');
    return withRepoLock(realpathSync(repo), async () => {
      const c = await pinned(repo);
      const ref = `refs/heads/${branch}`;
      if (await isSymbolic(c, ref))
        throw new InvalidError(`${ref} points at another branch, so 10db rewinds nothing there`);
      const tip = await revParse(c, `${ref}^{commit}`);
      if (tip !== from)
        throw new InvalidError(`Branch ${branch} is at ${tip ?? 'nothing'}, not ${from}`);
      if (tip === to) return;
      if (!(await isAncestor(c, to, tip)))
        throw new InvalidError(`Branch ${branch} is at ${tip}, which does not descend from ${to}`);
      const here = (await currentBranch(c)) === branch;
      if (here) {
        await git(c, ['update-index', '-q', '--ignore-submodules', '--refresh']).catch(
          () => undefined,
        );
        try {
          // Files first, then the branch, as the merge itself did.
          await git(c, ['read-tree', '-m', '-u', tip, to]);
        } catch (error) {
          if (!(error instanceof GitError)) throw error;
          throw new InvalidError(`10db could not put ${to} back in ${c.real}: ${error.message}`);
        }
      } else {
        const holder = await branchInUseElsewhere(c, branch);
        if (holder !== null)
          throw new InvalidError(
            `Branch ${branch} is checked out at ${holder}, so it can't be moved to ${to}`,
          );
      }
      try {
        await git(c, ['update-ref', '--no-deref', '-m', `10db: rewind to ${to}`, ref, to, tip]);
      } catch (error) {
        if (here) await git(c, ['read-tree', '-m', '-u', to, tip]).catch(() => undefined);
        if (!(error instanceof GitError)) throw error;
        throw refusal(c.real, { kind: GitTrustFailure.Ref, ref, reason: 'raced' });
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
    let present: ReturnType<typeof lstatSync> | null;
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
        // Read again under the lock: a removal that held it before this one leaves nothing there.
        if (existsAsEntry(target))
          throw new WorktreeNotOursError(path, 'git lists no worktree there');
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
    async operation(fn) {
      if (currentOperation()) return fn();
      const op: Operation = { finished: false, pinned: new Map(), origin: new Map() };
      try {
        return await operations.run(op, fn);
      } finally {
        op.finished = true;
      }
    },
    async currentBranch(repo) {
      return currentBranch(await pinned(repo));
    },
    async remoteUrl(repo, name) {
      const c = await pinned(repo);
      if (name === 'origin') return originUrlOnce(c, false);
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
    async branchOnOrigin(repo, branch, net) {
      return branchOnOriginOnce(repo, branch, net);
    },
    async hasCommit(repo, sha) {
      return (
        OBJECT_ID.test(sha) && (await revParse(await pinned(repo), `${sha}^{commit}`)) !== null
      );
    },
    async ownCommitsWithSubject(repo, branch, prefix) {
      const c = await pinned(repo);
      // NUL between every field: it is the one byte a message cannot hold, and a session writes messages.
      const out = await git(c, [
        'log',
        '-z',
        '--no-show-signature',
        '--no-mailmap',
        '-n',
        String(OP_SEARCH_DEPTH),
        '--fixed-strings',
        `--grep=${prefix}`,
        '--format=%H%x00%B',
        `refs/heads/${branch}`,
        '--',
      ]);
      const fields = out.split('\0');
      const found: { sha: string; message: string }[] = [];
      for (let at = 0; at + 1 < fields.length; at += 2) {
        const sha = fields[at]?.trim();
        const message = fields[at + 1];
        if (
          sha &&
          OBJECT_ID.test(sha) &&
          message?.startsWith(prefix) &&
          !OP_TRAILER_LINE.test(message)
        )
          found.push({ sha, message });
      }
      return found.reverse();
    },
    async fetchCommit(repo, sha, net) {
      return serialized(fetches, realpathSync(repo), () => fetchCommitOnce(repo, sha, net));
    },
    async switchNewBranch(repo, name, startPoint) {
      return withRepoLock(realpathSync(repo), async () =>
        switchCheckout(await pinned(repo), name, startPoint),
      );
    },
    async switchBack(repo, from, to, opts) {
      return withRepoLock(realpathSync(repo), async () =>
        switchBackCheckout(await pinned(repo), from, to, opts?.keepChanges ?? false),
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
    async restoreDirs(repo, dirs) {
      const named = checkPaths(repo, dirs);
      if (named.length === 0) return [];
      return withRepoLock(realpathSync(repo), async () => {
        const c = await pinned(repo);
        const differing = await changes(c, named);
        if (differing.length === 0) return [];
        // In an index seeded from HEAD a file HEAD lacks is untracked, so `clean` removes it (a
        // symlink itself, never what it points at) before `checkout-index` writes HEAD's files.
        await withPrivateIndex(c, await revParse(c, 'HEAD^{commit}'), async (env) => {
          await git(c, ['clean', '-f', '-d', '-q', '--', ...named], { env });
          const tracked = (await git(c, ['ls-files', '-z', '--', ...differing], { env }))
            .split('\0')
            .filter(Boolean);
          if (tracked.length > 0)
            await git(c, ['checkout-index', '-f', '-q', '-z', '--stdin'], {
              env,
              input: `${tracked.join('\0')}\0`,
            });
        });
        return differing;
      });
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
    async filesAt(repo, rev) {
      // A rev that starts with a dash would be read as an option by ls-tree.
      if (rev.startsWith('-')) throw new GitError(['ls-tree', rev], `${rev} names no commit`, null);
      return parseTree(
        await git(await pinned(repo), ['ls-tree', '-r', '-z', '--full-tree', rev, '--']),
      ).map((entry) => entry.path);
    },
    async countCommits(repo, base, tip) {
      return Number(
        (await git(await pinned(repo), ['rev-list', '--count', `${base}..${tip}`, '--'])).trim(),
      );
    },
    async operationInProgress(repo) {
      return operationIn(await pinned(repo));
    },
    async lastChangedAt(repo, globs) {
      if (globs.length === 0) return null;
      const c = await pinned(repo);
      if ((await revParse(c, 'HEAD^{commit}')) === null) return null;
      const out = await git(c, [
        'log',
        '-1',
        '--format=%cI',
        'HEAD',
        '--',
        ...globs.map((g) => `:(glob)${g}`),
      ]);
      const at = out.trim();
      return at === '' ? null : new Date(at).toISOString();
    },
    async diffSince(repo, base, head, maxBytes, paths) {
      const c = await pinned(repo);
      const numstat = await git(
        c,
        ['diff-tree', ...DIFF_FLAGS, '--numstat', '-z', base, head, '--'],
        {
          config: DIFF_CONFIG,
        },
      );
      const patch = (specs: readonly string[], cap: number) =>
        gitCapped(
          c,
          ['diff-tree', ...DIFF_FLAGS, '-p', '--unified=3', base, head, '--', ...specs],
          cap,
          {
            config: DIFF_CONFIG,
          },
        );
      // A few bytes past the cap are read so a character split by the cap is seen whole.
      const cap = maxBytes + UTF8_MAX_BYTES;
      if (paths === undefined)
        return { ...cutDiff(await patch([], cap), maxBytes), files: parseNumstat(numstat) };
      // The files are picked from the whole change's counts, never named on one command line: the
      // kept ones are read in turns, in the counts' order, which is the order the text lists them in.
      const files = parseNumstat(numstat).filter((file) => keptBy(paths)(file.path));
      const read: Buffer[] = [];
      let size = 0;
      let left = false;
      for (const turn of pathspecTurns(files.map((file) => file.path))) {
        if (size >= cap) {
          left = true;
          break;
        }
        const text = await patch(turn, cap - size);
        read.push(text);
        size += text.length;
      }
      const cut = cutDiff(Buffer.concat(read), maxBytes);
      return { diff: cut.diff, truncated: cut.truncated || left, files };
    },
    async filtersIn(repo, rev) {
      return filters(await pinned(repo), rev);
    },
    commit,
    mergeIntoBranch,
    revertCommits,
    mergedCommit,
    openPassBranch,
    undoPassBranch,
    passDirtRecords,
    keepWork,
    pageChanges,
    hashOnDisk,
    restoreFiles,
    moveKeptRef,
    narrowKeptRef,
    mergeFileBack,
    pointHeadAt,
    refreshIndex,
    async conflictMarkers(repo, paths, rev = 'HEAD') {
      const c = await pinned(repo);
      const found: string[] = [];
      for (const path of paths) {
        const text = await mergeableText(c, rev, path).catch(() => null);
        if (text !== null && hasConflictMarkers(text)) found.push(path);
      }
      return found;
    },
    async keepNote(repo, ref, text) {
      if (!ref.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
      const c = await pinned(repo);
      const oid = (await git(c, ['hash-object', '-w', '--stdin'], { input: text })).trim();
      await git(c, ['update-ref', '--no-deref', '-m', '10db: kept note', ref, oid]);
    },
    async keptNote(repo, ref) {
      if (!ref.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
      const c = await pinned(repo);
      if ((await git(c, ['cat-file', '-t', ref]).catch(() => '')).trim() !== 'blob') return null;
      return git(c, ['cat-file', 'blob', ref]);
    },
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
    recordPaths,
    chainCommit,
    landPaths,
    async keepRef(repo, ref, sha) {
      if (!ref.startsWith(KEPT_REF_PREFIX))
        throw new InvalidError(`${ref} is not under ${KEPT_REF_PREFIX}`);
      const c = await pinned(repo);
      const commit = await revParse(c, `${sha}^{commit}`);
      if (commit === null) throw new InvalidError(`${sha} names no commit`);
      await git(c, ['update-ref', '--no-deref', '-m', '10db: kept ref', ref, commit]);
    },
    async blobsAt(repo, rev, paths) {
      const named = [...new Set(paths.map(checkPathName))].sort();
      if (named.length === 0) return [];
      const c = await pinned(repo);
      const found = new Map(
        parseTree(
          await git(c, ['ls-tree', '-r', '-z', '--full-tree', rev, '--', ...named], {
            env: { GIT_LITERAL_PATHSPECS: '1' },
          }),
        ).map((entry) => [entry.path, entry]),
      );
      return named.map((path) => ({
        path,
        blob: found.get(path)?.oid ?? null,
        mode: found.get(path)?.mode ?? null,
      }));
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
    fastForwardBranch,
    rewindBranch,
    moveBranchCas,
    moveCheckedOutBranch,
    mergeKeepingTree,
    async branchInUseElsewhere(repo, branch) {
      return branchInUseElsewhere(await pinned(repo), branch);
    },
    async ownCommitsSince(repo, base, tip) {
      return (
        await git(await pinned(repo), [
          'rev-list',
          '--first-parent',
          '--no-merges',
          `${base}..${tip}`,
        ])
      )
        .split('\n')
        .filter(Boolean);
    },
    removeWorktree,
    worktreeChanges,
    worktreeIgnoredFiles,
    async listWorktrees(repo) {
      return listWorktrees(await pinned(repo));
    },
    async pruneWorktrees(repo) {
      await git(await pinned(repo), ['worktree', 'prune']);
    },
    async deleteBranchIfAt(repo, branch, sha, tracking = null) {
      const c = await pinned(repo);
      // One transaction: both refs go, or, when either is missing or moved, neither does.
      const deletes = [`delete refs/heads/${branch} ${sha}`];
      if (tracking !== null) deletes.push(`delete refs/remotes/origin/${branch} ${tracking}`);
      try {
        await git(c, ['update-ref', '--stdin'], { input: `${deletes.join('\n')}\n` });
      } catch (error) {
        if (error instanceof GitError) return false;
        throw error;
      }
      // What `git branch -D` drops too: the section 10db's push wrote (`branch.<name>.remote`, `.merge`).
      const section = `branch.${branch}.`;
      const keys = (await git(c, ['config', '--local', '--name-only', '--list'])).split('\n');
      if (keys.some((key) => key.startsWith(section) && !key.slice(section.length).includes('.')))
        await git(c, ['config', '--local', '--remove-section', `branch.${branch}`]);
      return true;
    },
    async trackingTip(repo, branch) {
      return revParse(await pinned(repo), `refs/remotes/origin/${branch}`);
    },
    async branchInUse(repo, branch) {
      return branchInUse(await pinned(repo), branch);
    },
    async localBranches(repo, prefix) {
      const out = await git(await pinned(repo), [
        'for-each-ref',
        '--format=%(objectname) %(refname)',
        `refs/heads/${prefix}`,
      ]);
      const heads = 'refs/heads/';
      return out
        .split('\n')
        .flatMap((line) => {
          const [sha = '', ref = ''] = line.split(' ');
          return OBJECT_ID.test(sha) && ref.startsWith(heads)
            ? [{ name: ref.slice(heads.length), sha }]
            : [];
        })
        .filter((branch) => branch.name.startsWith(prefix))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async branchTip(repo, branch) {
      return revParse(await pinned(repo), `refs/heads/${branch}`);
    },
    async commitAt(repo, rev) {
      // A rev that starts with a dash would be read as an option by rev-parse.
      const sha = rev.startsWith('-')
        ? null
        : await revParse(await pinned(repo), `${rev}^{commit}`);
      if (sha === null) throw new GitError(['rev-parse', rev], `${rev} names no commit`, null);
      return sha;
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
    async bytesAt(repo, rev, path, maxBytes) {
      const c = await pinned(repo);
      const out = await git(c, ['ls-tree', '-z', '--long', '--full-tree', rev, '--', path], {
        env: { GIT_LITERAL_PATHSPECS: '1' },
      });
      const entry = out
        .split('\0')
        .map((line) => LS_TREE_ENTRY.exec(line))
        .find((match) => match?.[5] === path);
      if (!entry) return null;
      const [, mode = '', type, oid = '', size = ''] = entry;
      if (type !== 'blob' || !REGULAR_FILE_MODES.includes(mode)) return null;
      const bytes = Number(size);
      if (!Number.isSafeInteger(bytes) || bytes > maxBytes) return null;
      // One byte over the cap is never asked for: the size above says what the blob holds.
      return gitCapped(c, ['cat-file', 'blob', oid], maxBytes + 1);
    },
    async mergeBase(repo, one, other) {
      const c = await pinned(repo);
      try {
        return (await git(c, ['merge-base', one, other])).trim();
      } catch (error) {
        if (error instanceof GitError && error.exitCode === 1) return null;
        throw error;
      }
    },
    async folderAt(repo, rev, folder) {
      const c = await pinned(repo);
      const prefix = folder === '' ? '' : `${folder}/`;
      // Without -r, git lists only the entries directly inside the folder the trailing slash names.
      const out = await git(
        c,
        ['ls-tree', '-z', '--long', '--full-tree', rev, ...(prefix === '' ? [] : ['--', prefix])],
        { env: { GIT_LITERAL_PATHSPECS: '1' } },
      );
      const files: { name: string; bytes: number }[] = [];
      const folders: string[] = [];
      for (const record of out.split('\0')) {
        const entry = LS_TREE_ENTRY.exec(record);
        if (!entry) continue;
        const [, mode = '', type, , size = '', path = ''] = entry;
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        if (name === '' || name.includes('/')) continue;
        const bytes = Number(size);
        if (type === 'blob' && REGULAR_FILE_MODES.includes(mode) && Number.isSafeInteger(bytes)) {
          files.push({ name, bytes });
        } else if (type === 'tree') {
          folders.push(name);
        }
      }
      const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      return {
        files: files.sort((a, b) => byName(a.name, b.name)),
        folders: folders.sort(byName),
      };
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
        return refusalOf(error);
      }
    },
    async survey(path, maxCommits) {
      const site = observed(path);
      try {
        const bare = (await git(site, ['rev-parse', '--is-bare-repository'])).trim() === 'true';
        if (bare) return { refused: 'bare_repository', message: 'This is a bare repository.' };
        const at = observed(
          realpathSync((await git(site, ['rev-parse', '--show-toplevel'])).trim()),
        );
        // An empty repository has no HEAD: it holds no file and has no history.
        const head = await git(at, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
          answerExitCodes: [1],
        });
        if (head.trim() === '') return { files: [], commits: [] };
        const tree = await git(at, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']);
        const log = await git(at, [
          'log',
          '--no-show-signature',
          // log.mailmap is on by default and reads .mailmap from the checkout.
          '--no-mailmap',
          `--max-count=${String(maxCommits)}`,
          '--no-merges',
          '--no-renames',
          '--no-ext-diff',
          '--no-textconv',
          '--name-only',
          '-z',
          `--format=${SURVEY_COMMIT_MARK}`,
          // Without `--`, a file named HEAD makes the revision ambiguous and git stats the checkout.
          'HEAD',
          '--',
        ]);
        return { files: tree.split('\0').filter((f) => f !== ''), commits: parseSurveyLog(log) };
      } catch (error) {
        return refusalOf(error);
      }
    },
    async surveyTexts(path, paths, { maxBytes, maxTotalBytes, signal }) {
      const none = (refused: string | null): SurveyTexts => ({
        texts: new Map(),
        bytes: 0,
        refused,
      });
      const wanted = new Set(paths);
      if (wanted.size === 0) return none(null);
      // A missing blob is never fetched: the fetch would run the remote's programs. Should the config
      // change after the check below, no transport, ssh command or credential helper is reachable.
      // GIT_ALLOW_PROTOCOL overrides every protocol.* setting, the repository's own among them, and
      // no protocol is named `none`.
      const noFetch = {
        env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' },
        config: NO_TRANSPORT,
      };
      try {
        const at = observed(
          realpathSync((await git(observed(path), ['rev-parse', '--show-toplevel'])).trim()),
        );
        // Git before 2.45 has no GIT_NO_LAZY_FETCH, so a partial clone is not read at all. Reading
        // config runs no program; a config git can't read refuses too, never reads.
        let partial: string;
        let promisors: string;
        try {
          // `--get-regexp` prints the key whatever its value: an empty one still names a partial clone.
          partial = await git(at, ['config', '--get-regexp', '^extensions\\.partialclone$'], {
            answerExitCodes: [1],
          });
          promisors = await git(
            at,
            ['config', '--type=bool', '--get-regexp', '^remote\\..*\\.promisor$'],
            { answerExitCodes: [1] },
          );
        } catch {
          return none(UNREAD_CONFIG_REFUSAL);
        }
        if (partial !== '' || /\strue$/mu.test(promisors)) return none(PARTIAL_CLONE_REFUSAL);
        const head = await git(at, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], {
          answerExitCodes: [1],
        });
        if (head.trim() === '') return none(null);
        const blobs: { path: string; oid: string; bytes: number }[] = [];
        for (const record of (
          await git(at, ['ls-tree', '-r', '-z', '--long', head.trim()], noFetch)
        ).split('\0')) {
          const entry = LS_TREE_ENTRY.exec(record);
          if (!entry) continue;
          const [, mode = '', type, oid = '', size = '', file = ''] = entry;
          const bytes = Number(size);
          if (
            wanted.has(file) &&
            type === 'blob' &&
            REGULAR_FILE_MODES.includes(mode) &&
            Number.isSafeInteger(bytes) &&
            bytes <= maxBytes
          )
            blobs.push({ path: file, oid, bytes });
        }
        const total = blobs.reduce((sum, b) => sum + b.bytes, 0);
        if (total > maxTotalBytes) return none(OVER_BUDGET_REFUSAL);
        const texts = new Map<string, string>();
        // `cat-file --batch` prints `<oid> blob <size>\n<bytes>\n` per line it is given, in batches
        // that keep each call's output well under what one git call may print.
        for (let start = 0; start < blobs.length;) {
          signal?.throwIfAborted();
          let end = start;
          let size = 0;
          while (
            end < blobs.length &&
            (end === start || size + (blobs[end]?.bytes ?? 0) < SURVEY_TEXT_BATCH_BYTES)
          ) {
            size += (blobs[end]?.bytes ?? 0) + 100;
            end += 1;
          }
          const batch = blobs.slice(start, end);
          const out = await gitCapped(at, ['cat-file', '--batch'], size + 1, {
            ...noFetch,
            input: batch.map((b) => `${b.oid}\n`).join(''),
          });
          let offset = 0;
          for (const blob of batch) {
            const header = out.indexOf(0x0a, offset);
            if (header === -1) break;
            const body = out.subarray(header + 1, header + 1 + blob.bytes);
            offset = header + 1 + blob.bytes + 1;
            if (!body.includes(0)) texts.set(blob.path, body.toString('utf8'));
          }
          start = end;
        }
        return { texts, bytes: total, refused: null };
      } catch (error) {
        if (signal?.aborted === true) throw error;
        return none(null);
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
      // A restart may renumber the volume between the refusal and the answer; the inodes still hold.
      const same =
        sameCheckoutIdentity(now.id, candidate.id) &&
        now.gitDir === candidate.gitDir &&
        now.commonDir === candidate.commonDir &&
        now.fetchUrl === candidate.fetchUrl &&
        now.pushUrl === candidate.pushUrl;
      if (!same) throw mismatch(real, candidate, now);
      // `now` is the candidate's state with the device number the volume has today.
      pins.set(real, now);
      // Told even when no refusal since this start is known: the builder answered a card.
      refused.add(real);
      trustedAgain(real);
    },
  };
}
