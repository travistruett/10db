import {
  BatchFailure,
  BatchState,
  type BatchDto,
  type CardResolvesWhen,
  type BatchId,
  type FailingCheckDto,
  type InboxOption,
  type ProjectDto,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';
import type { Json } from '@10db/db';
import {
  checkoutSwitchCommand,
  GitNetworkError,
  worktreeMergeCommand,
  worktreeRemovalCommand,
  worktreeRestoreCommand,
  type CheckoutPlace,
} from '../git';
import { GhError } from '../github';
import type { GateResult } from '../verify';
import type { BlockedTask, UnmergedDependency } from './deps';
import type { GateStepFailure } from './gate-failures';
import type { TakenNumber } from './migration-numbers';
import { INSTALL_SUMMARY, type DependencyRefresh } from './worktree-dependencies';

/** A flag card's text. Every delivery card says what to fix (batch delivery spec §1). */
export interface Card {
  readonly title: string;
  readonly body: string;
  /** An open card with the same key is reused instead of raising another. */
  readonly foldKey?: string;
  /** A repeat that folds rewrites the open card with this one's body and detail. */
  readonly refresh?: boolean;
  readonly detail?: Record<string, Json>;
  /** The answers the card offers; none for a card the builder only dismisses. */
  readonly options?: readonly InboxOption[];
  /** What makes the card stale: 10db closes it itself when that happens (CardResolvesWhen). */
  readonly resolvesWhen?: CardResolvesWhen;
}

/** The answers of a card that offers to delete a task's local branch. */
export const BranchChoice = { Delete: 'Delete Branch', Keep: 'Keep' } as const;
export type BranchChoice = (typeof BranchChoice)[keyof typeof BranchChoice];

/** The `detail` key of a card that offers to delete a batch's local branch; it holds the batch id. */
export const BRANCH_CARD_DETAIL = 'branchCard';

/** What a card carries to offer deleting `batch`'s local branch. */
function branchOffer(batch: BatchDto): Pick<Card, 'options' | 'detail'> {
  return {
    options: [
      {
        label: BranchChoice.Delete,
        description: `Delete ${batch.branch ?? 'the branch'} from your repository`,
      },
      { label: BranchChoice.Keep, description: 'Leave the branch where it is' },
    ],
    detail: { batchId: batch.id, [BRANCH_CARD_DETAIL]: { batchId: batch.id } },
  };
}

const commitsOf = (count: number): string => `${String(count)} commit${count === 1 ? '' : 's'}`;

export const MAX_LISTED_PATHS = 20;

export function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- ${p}`);
  const extra = paths.length - MAX_LISTED_PATHS;
  return [...shown, ...(extra > 0 ? [`- and ${String(extra)} more`] : [])].join('\n');
}

/** The fold keys of the cards that name a kept worktree. */
export const keptWorktreeKey = {
  batchChanges: (batchId: BatchId): string => `worktree-kept:${batchId}`,
  batchIgnored: (batchId: BatchId): string => `worktree-ignored:${batchId}`,
  orphanChanges: (path: string): string => `worktree-orphan:${path}`,
  orphanIgnored: (path: string): string => `worktree-orphan-ignored:${path}`,
};

/** The git-ignored files beside a kept worktree's changes, which its removal command deletes too. */
function alsoIgnored(ignored: readonly string[]): string {
  return ignored.length === 0
    ? ''
    : `\n\nIt also holds these git-ignored files, which the command removes too:\n${listPaths(ignored)}`;
}

/** The part of an error a builder can act on. */
export function detailOf(error: unknown): string {
  if (error instanceof GitNetworkError) return error.detail || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

const NOT_STARTED = 'Batch not started';

function ghCard(prefix: string, error: unknown, then: string): Card | null {
  if (!(error instanceof GhError)) return null;
  switch (error.kind) {
    case 'not_installed':
      return {
        title: `${prefix}: gh is not installed`,
        body: `Install the GitHub CLI (brew install gh) and sign in with gh auth login, then ${then}.`,
      };
    case 'signed_out':
      return {
        title: `${prefix}: gh is signed out`,
        body: `Run gh auth login in a terminal, then ${then}.`,
      };
    case 'timeout':
    case 'aborted':
    case 'unreachable':
    case 'failed':
      return null;
  }
}

export const startCards = {
  lanesRunning: (project: ProjectDto, lanes: number): Card => ({
    title: `${NOT_STARTED}: work is still running in ${project.name}`,
    body: `10db switches branches only when no lane runs in the project, and ${String(lanes)} lane(s) run now. Let them finish, or cancel them in the Factory view, then start again.`,
  }),
  dirtyCheckout: (project: ProjectDto, paths: readonly string[]): Card => ({
    title: `${NOT_STARTED}: the checkout has uncommitted changes`,
    body: `10db switches your checkout to a new branch to start, so it needs nothing uncommitted. These files have changes that are in the way:\n${listPaths(paths)}\n\nCommit, stash or discard them in ${project.repoPath}, then start again.`,
  }),
  usesFilters: (
    project: ProjectDto,
    filters: readonly { readonly path: string; readonly filter: string }[],
  ): Card => ({
    title: `${NOT_STARTED}: ${project.repoPath} uses git filters`,
    body: `10db commits and pushes files exactly as they are and never runs a filter, so it can't deliver a repository whose attributes ask for one (Git LFS is the usual one):\n${listPaths(filters.map((f) => `${f.path} (${f.filter})`))}\n\nUse local delivery for this project, or ship its changes yourself.`,
  }),
  noOrigin: (project: ProjectDto): Card => ({
    title: `${NOT_STARTED}: ${project.repoPath} has no remote named origin`,
    body: 'Pull request delivery pushes to origin. Add it with git remote add origin <GitHub URL>, then start again.',
  }),
  fetchFailed: (base: string, error: unknown): Card => ({
    title: `${NOT_STARTED}: git fetch origin ${base} failed`,
    body: `${detailOf(error)}\n\nCheck that ${base} exists on origin and that git reaches origin from your login shell (its credential helper or SSH agent), then start again.`,
  }),
  branchMissing: (branch: string): Card => ({
    title: `Not started: origin has no branch named ${branch}`,
    body: `A task set to merge into ${branch} is built from it, and its pull request targets it, so ${branch} has to exist on origin first. Create it on origin (git push origin <commit>:refs/heads/${branch}), or change where the task lands, then start again.`,
  }),
  ghUnavailable: (error: unknown): Card =>
    ghCard(NOT_STARTED, error, 'start again') ?? {
      title: `${NOT_STARTED}: gh auth status failed`,
      body: `${detailOf(error)}\n\nRun gh auth status in a terminal to see why, then start again.`,
    },
  repoUnknown: (project: ProjectDto): Card => ({
    title: `${NOT_STARTED}: origin in ${project.repoPath} is not a github.com repository`,
    body: 'Pull request delivery opens pull requests on github.com, for the repository origin pushes to, as 10db recorded it with the project. Point origin at github.com (https://github.com/owner/name.git or git@github.com:owner/name.git), answer the card that asks you to trust the new origin, then start again.',
  }),
  unfinishedDependencies: (blocked: readonly BlockedTask[]): Card => ({
    title: 'Not started: tasks depend on unfinished work',
    body: `${blocked.map((b) => `- ${b.task.title} needs ${b.deps.map((d) => d.title).join(', ')}`).join('\n')}\n\nStart them together, or finish those tasks first.`,
  }),
  unmergedDependencies: (found: readonly UnmergedDependency[]): Card => ({
    title: 'Not started: tasks depend on code that is not on the base branch',
    body: `${found.map((f) => `- ${f.task.title} needs ${f.dep.title}: ${f.reason}`).join('\n')}\n\nMerge that work into the base branch, then start again.`,
  }),
  notStarted: (error: unknown): Card => ({
    title: `${NOT_STARTED}: ${detailOf(error)}`,
    body: 'Nothing was pushed. Fix the cause, then start again.',
  }),
  notJoined: (batch: BatchDto, error: unknown): Card => ({
    title: `Not added to batch "${batch.title}": ${detailOf(error)}`,
    body: 'Start the task again once the batch is open, or after it ships.',
    detail: { batchId: batch.id },
  }),
  joinInterrupted: (batch: BatchDto): Card => ({
    title: `Not added to batch "${batch.title}": 10db stopped first`,
    body: 'The daemon shut down before these tasks joined the batch. Start them again.',
    detail: { batchId: batch.id },
  }),
  cutInterrupted: (batch: BatchDto): Card => ({
    title: `Batch not started: 10db stopped while cutting the branch for "${batch.title}"`,
    body: 'Nothing was pushed, and its tasks did not start. Start them again.',
    detail: { batchId: batch.id },
  }),
};

/** What delivery tells the builder about a batch's worktree. */
export const worktreeCards = {
  pathExists: (batch: BatchDto, path: string): Card => ({
    title: `${NOT_STARTED}: ${path} already exists`,
    body: `10db makes the worktree for "${batch.title}" at a path nothing holds yet, and never writes into a directory it didn't make. Move or remove ${path}, then start again.`,
  }),
  seedFailed: (batch: BatchDto, error: unknown): Card => ({
    title: `${NOT_STARTED}: 10db couldn't seed the worktree for "${batch.title}"`,
    body: `${detailOf(error)}\n\n10db copies the checkout's ignored directories named in the project's worktree seed (node_modules unless you changed it) into each new worktree, and one entry could not be read or written. The worktree and its branch were removed. Fix the entry's permissions, or take its directory out of the seed, then start again.`,
  }),
  installFailed: (
    batch: BatchDto,
    failure: Extract<DependencyRefresh, { readonly kind: 'failed' }>,
  ): Card => ({
    title: `${NOT_STARTED}: 10db couldn't install the dependencies for "${batch.title}"`,
    body: `${failure.timedOut ? 'The install timed out.' : `The install exited with ${String(failure.exitCode)}.`} Its output ended:\n\n${failure.tail.trim()}\n\nA new worktree's node_modules is copied from the checkout, which can hold older packages than the branch's lockfile names, so 10db runs ${INSTALL_SUMMARY} in the worktree under the gate's sandbox. The sandbox reaches only the hosts the project allows: if the output shows a blocked connection (a 403 or a tunnel error from the proxy), allow the package registry's host in the project's network settings. Full log: ${failure.logPath}. The worktree was removed. Fix the cause, then try again.`,
  }),
  missing: (batch: BatchDto, path: string, outcome: 'waits' | 'failed'): Card => {
    const branch = batch.branch ?? '(not cut)';
    const detail = { batchId: batch.id };
    switch (outcome) {
      case 'waits':
        return {
          title: `Batch "${batch.title}" waits: its worktree ${path} is missing`,
          body: `Nothing in the batch starts without its worktree. Abandon the batch in a task's drawer on the Board, or restart 10db, which fails the batch so Retry can make the worktree again from ${branch}.`,
          foldKey: `worktree-missing:${batch.id}`,
          detail,
        };
      case 'failed':
        return {
          title: `Batch "${batch.title}" failed: its worktree ${path} is missing`,
          body: `10db restarted and found no worktree at ${path}, so nothing in the batch runs. Press Retry in a task's drawer on the Board to make it again from ${branch}, or abandon the batch there.`,
          detail,
        };
    }
  },
  /** `main` is the project's main checkout, where the removal command runs. */
  keptDirty: (
    batch: BatchDto,
    main: string,
    path: string,
    paths: readonly string[],
    ignored: readonly string[],
  ): Card => ({
    title: `Batch "${batch.title}" abandoned: uncommitted changes kept in ${path}`,
    body: `10db never throws away uncommitted work, so it kept the worktree with these changes:\n${listPaths(paths)}${alsoIgnored(ignored)}\n\nCopy what you need, then remove it with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.batchChanges(batch.id),
    detail: { batchId: batch.id },
  }),
  /** `main` is the project's main checkout, where the removal command runs. */
  /**
   * `paths` is null when 10db won't read the worktree's git dir, so it may hold anything. `main` is
   * the project's main checkout, where the removal command runs.
   */
  keptIgnored: (
    batch: BatchDto,
    main: string,
    path: string,
    paths: readonly string[] | null,
  ): Card => ({
    title:
      paths === null
        ? `10db kept the worktree of "${batch.title}": it can't be read`
        : `10db kept the worktree of "${batch.title}": it holds git-ignored files`,
    body: `${
      paths === null
        ? `The batch is finished, but 10db couldn't read its worktree ${path}, so it may hold files you need, and kept it.`
        : `The batch is finished, but its worktree ${path} holds git-ignored files 10db didn't put there, such as a hand-made .env, so 10db kept it:\n${listPaths(paths)}`
    }\n\nCopy what you need, then remove it with ${worktreeRemovalCommand(main, path)}.${
      batch.branch === null
        ? ''
        : ` Its branch ${batch.branch} is checked out there, so 10db leaves the branch too until the worktree is gone.`
    }`,
    foldKey: keptWorktreeKey.batchIgnored(batch.id),
    detail: { batchId: batch.id },
  }),
  /**
   * `paths` is null when git couldn't read the worktree, which counts as changed. `main` is the
   * project's main checkout, where the removal command runs.
   */
  orphanKept: (
    main: string,
    path: string,
    paths: readonly string[] | null,
    ignored: readonly string[],
  ): Card => ({
    title:
      paths === null
        ? `10db kept ${path}: it can't be read`
        : `10db kept ${path}: it has uncommitted changes`,
    body: `No batch uses this worktree any more, but ${
      paths === null
        ? "10db couldn't read it, so it may hold uncommitted work"
        : `it holds uncommitted changes:\n${listPaths(paths)}${alsoIgnored(ignored)}`
    }\n\n10db never throws away uncommitted work. Copy what you need, then remove it with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.orphanChanges(path),
  }),
  /** `main` is the project's main checkout, where the removal command runs. */
  orphanIgnored: (main: string, path: string, paths: readonly string[]): Card => ({
    title: `10db kept ${path}: it holds git-ignored files`,
    body: `No batch uses this worktree any more, but it holds git-ignored files 10db didn't put there, such as a hand-made .env:\n${listPaths(paths)}\n\nCopy what you need, then remove it with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.orphanIgnored(path),
  }),
  leftBehind: (batch: BatchDto, path: string): Card => ({
    title: `10db left ${path} in place`,
    body: `The worktree path of batch "${batch.title}" holds a directory git doesn't list as a worktree, so 10db didn't remove it and no longer treats it as the batch's. Look inside, then delete it yourself if nothing there is needed.`,
    detail: { batchId: batch.id },
  }),
  inTheWay: (batch: BatchDto, path: string, reason: string): Card => ({
    title: `Batch "${batch.title}" not retried: ${path} is in the way`,
    body: `10db makes the worktree whole on ${batch.branch ?? '(not cut)'} before a retry, and won't remove what is at ${path}: ${reason}. Look inside; if nothing there is needed, delete it, then press Retry in a task's drawer on the Board.`,
    foldKey: `worktree-in-the-way:${batch.id}`,
    detail: { batchId: batch.id },
  }),
  notReopened: (batch: BatchDto, error: unknown): Card => ({
    title: `Batch "${batch.title}" not reopened: ${detailOf(error)}`,
    body: `10db makes the worktree whole on ${batch.branch ?? '(not cut)'} before the batch reopens, and couldn't. Fix the cause, then press Retry in a task's drawer on the Board.`,
    detail: { batchId: batch.id },
  }),
  notWhole: (
    batch: BatchDto,
    path: string,
    found: string | null,
    paths: readonly string[],
  ): Card => {
    const branch = batch.branch ?? '(not cut)';
    return {
      title: `Batch "${batch.title}" not retried: its worktree is on ${found ?? 'a detached HEAD'}, with uncommitted changes`,
      body: `10db makes the worktree whole on ${branch} before a retry and won't throw away changes. Commit or discard these in ${path}, or run git switch ${branch} there, then press Retry in a task's drawer on the Board:\n${listPaths(paths)}`,
      detail: { batchId: batch.id },
    };
  },
};

/** The fold key of a batch's conflict-with-its-base card, so a clean merge can withdraw it. */
export const baseConflictKey = (batchId: BatchId): string => `base-conflict:${batchId}`;

/** The fold key of a batch's files-in-the-way card, so a clean merge can withdraw it. */
export const baseKeptKey = (batchId: BatchId): string => `base-kept:${batchId}`;

/** Why a base card was raised beyond the gate, and what more it found. */
export interface BaseCardContext {
  /** The task that asked for the migrations hazard, which 10db holds back until the branch holds its base. */
  readonly migrationsFor?: string;
  /** The branch's migrations whose number the base already gives another. */
  readonly taken?: readonly TakenNumber[];
}

/** What a task held back from the migrations hazard is told on the card, after its first paragraph. */
function migrationsHeld(batch: BatchDto, context: BaseCardContext, until: string): string {
  return context.migrationsFor === undefined
    ? ''
    : `\n\nTask "${context.migrationsFor}" asked for the migrations hazard. 10db gives it only once this branch holds ${batch.baseBranch}, so that a migration it generates is numbered after ${batch.baseBranch}'s latest: until ${until}, the task generates no migration.`;
}

/** The migrations a conflict renumbers, in a title: "migration 0009_x" or "migrations 0009_x, 0010_y". */
function migrationNames(taken: readonly TakenNumber[]): string {
  const tags = [...new Set(taken.map((t) => t.ours))];
  return `${tags.length === 1 ? 'migration' : 'migrations'} ${tags.join(', ')}`;
}

/** How the builder makes the branch's migrations again on top of the base, step by step. */
function regenerateSteps(batch: BatchDto, worktree: string, taken: readonly TakenNumber[]): string {
  const base = batch.baseBranch;
  const dirs = [...new Set(taken.map((t) => t.dir))];
  const named = dirs.map((d) => `${d}/`).join(' and ');
  const each = taken
    .map(
      (t) =>
        `Migration ${t.ours} takes number ${t.number}, which ${base}'s ${t.theirs} already has.`,
    )
    .join('\n');
  const restores = dirs.map((d) => worktreeRestoreCommand(worktree, base, d)).join(', then ');
  return `${each}\n\nMigrations are numbered in order, and ${named} is generated, so it is never merged by hand: the batch's migration has to be generated again on top of ${base}. In the worktree:\n1. ${worktreeMergeCommand(worktree, base)}, which stops at the conflict.\n2. ${restores}, which takes ${base}'s migrations whole and drops the batch's own.\n3. Run drizzle-kit generate the way the project does, in the package that holds ${named}, so the batch's schema change becomes the migration after ${base}'s latest.\n4. Resolve any other file listed above, then git add and git commit, with hooks off as in step 1.\n\nUntil then the gates test the branch without ${base}'s newer commits. The next gate tests the result, and this card goes once the branch holds ${base}.`;
}

/** What delivery tells the builder when a worktree batch's branch can't take its base before a gate. */
export const baseCards = {
  /**
   * `worktree` is the batch's worktree, where the builder can merge by hand. A conflict that renumbers
   * a migration says how to generate it again instead of how to merge.
   */
  conflict: (
    batch: BatchDto,
    worktree: string,
    paths: readonly string[],
    context: BaseCardContext = {},
  ): Card => {
    const taken = context.taken ?? [];
    const conflicting = `${batch.baseBranch} on origin changed these files in ways that conflict with the batch's own changes:\n${listPaths(paths)}`;
    const held = migrationsHeld(batch, context, 'the conflict is resolved');
    return {
      title:
        taken.length > 0
          ? `Batch "${batch.title}" must regenerate ${migrationNames(taken)} on top of ${batch.baseBranch}`
          : `Batch "${batch.title}" conflicts with ${batch.baseBranch}`,
      body:
        taken.length > 0
          ? `${conflicting}${held}\n\n${regenerateSteps(batch, worktree, taken)}`
          : `${conflicting}${held}\n\nBefore each gate 10db merges ${batch.baseBranch} into the batch's branch, so the gate tests what the pull request would merge. It can't resolve a conflict: a lane commits only its own files and never records a merge. Until the conflict is resolved, the gates test the branch without ${batch.baseBranch}'s newer commits, so a failure they fix still shows.\n\nOnce the pull request is open, resolve it there (GitHub's Update branch, then Resolve conflicts). Or merge it yourself in the worktree: ${worktreeMergeCommand(worktree, batch.baseBranch)}. That command turns the repository's hooks off, because lanes write in the worktree, so the hook config there is theirs to choose. The next gate tests the result, and this card goes once the branch holds ${batch.baseBranch}.`,
      foldKey: baseConflictKey(batch.id),
      // Asked for the migrations hazard, the open card is rewritten to say the task is held back.
      ...(context.migrationsFor === undefined ? {} : { refresh: true }),
      detail: { batchId: batch.id, paths: paths.slice(0, MAX_LISTED_PATHS) },
    };
  },
  /** `worktree` is the batch's worktree, which holds `paths`. */
  kept: (
    batch: BatchDto,
    worktree: string,
    paths: readonly string[],
    context: BaseCardContext = {},
  ): Card => ({
    title: `Batch "${batch.title}" can't take ${batch.baseBranch}: files git doesn't track are in the way`,
    body: `${batch.baseBranch} on origin adds files where the batch's worktree ${worktree} holds files git doesn't track, most likely ignored ones such as a hand-made .env or a build directory:\n${listPaths(paths)}${migrationsHeld(batch, context, 'they are out of the way')}\n\n10db never overwrites or deletes them, so it didn't merge ${batch.baseBranch}, and the gates test the branch without its newer commits. A fix session is told to leave them. If you don't need them, move or delete them; otherwise leave the merge to the pull request. The next gate tries again, and this card goes once the branch holds ${batch.baseBranch}.`,
    foldKey: baseKeptKey(batch.id),
    ...(context.migrationsFor === undefined ? {} : { refresh: true }),
    detail: { batchId: batch.id, paths: paths.slice(0, MAX_LISTED_PATHS) },
  }),
};

/**
 * A refused start's card names its tasks (and the batch it tried to join), so a client can tell a
 * refused start from a join that is still on its way: a joined task gets a workstream instead.
 * The same refusal of the same tasks folds into the card still open, so starting again after a
 * failure does not stack identical cards.
 */
export function forTasks(card: Card, taskIds: Iterable<TaskId>): Card {
  const ids = [...taskIds];
  return {
    ...card,
    foldKey: card.foldKey ?? `start-refused:${[...ids].sort().join(',')}:${card.title}`,
    refresh: true,
    detail: { ...card.detail, taskIds: ids },
    ...(ids.length > 0 ? { resolvesWhen: { event: 'tasks_started', taskIds: ids } } : {}),
  };
}

/** Where a wrong-branch card comes from, which decides what it tells the builder to do. */
export type WrongBranchOutcome = 'waits' | 'failed' | 'not_joined' | 'not_shipped';

/** The spec's wrong-branch card: "checkout is on X, the batch branch is Y". */
export function wrongBranchCard(
  batch: BatchDto,
  current: string | null,
  repoPath: string,
  outcome: WrongBranchOutcome,
): Card {
  const on = current ?? 'a detached HEAD';
  const branch = batch.branch ?? '(not cut)';
  const where = `checkout is on ${on}, the batch branch is ${branch}`;
  const detail = { batchId: batch.id };
  switch (outcome) {
    case 'waits':
      // The scheduler raises this every time the work waits; one open card per branch is enough.
      return {
        title: `Batch "${batch.title}" waits: ${where}`,
        body: `Nothing in the batch starts until the checkout is back on its branch. Run git switch ${branch} in ${repoPath}, or abandon the batch in a task's drawer on the Board.`,
        foldKey: `batch-branch:${batch.id}:${on}`,
        detail,
      };
    case 'failed':
      return {
        title: `Batch "${batch.title}" failed: ${where}`,
        body: `10db restarted with the checkout off the batch branch, so nothing in the batch runs. Run git switch ${branch} in ${repoPath}, then press Retry in a task's drawer on the Board; or abandon the batch there.`,
        detail,
      };
    case 'not_shipped':
      return {
        title: `Batch "${batch.title}" not shipped: ${where}`,
        body: `10db ships only from the batch branch, and pushed nothing. Run git switch ${branch} in ${repoPath}, then press Retry in a task's drawer on the Board.`,
        detail,
      };
    case 'not_joined':
      return {
        title: `Not added to batch "${batch.title}": ${where}`,
        body: `Start the task again once the checkout is on ${branch} (git switch ${branch} in ${repoPath}).`,
        detail,
      };
  }
}

const notShipped = (batch: BatchDto): string => `Batch "${batch.title}" not shipped`;

/** "0.3 s" or "45 s" under a minute, "30 min" from one, so a short timeout never reads "0 min". */
export function duration(ms: number): string {
  if (ms >= 60_000) return `${String(Math.round(ms / 60_000))} min`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
const RETRY = "Press Retry in a task's drawer on the Board to ship again; nothing was merged.";

/** How many failing tests a gate card lists. */
const MAX_LISTED_TESTS = 5;

const RERAN =
  "Every failing test was in a file the batch didn't change and had passed in its tasks' own gates, so 10db ran the gate again by itself";

/** " in test, lint", naming the failing steps after a gate card's title; empty when the gate named none. */
function inSteps(steps: readonly GateStepFailure[]): string {
  return steps.length === 0 ? '' : ` in ${steps.map((s) => s.name).join(', ')}`;
}

/** Up to five failing tests across the steps, as list lines, then how many more there are. */
function testLines(steps: readonly GateStepFailure[]): string {
  const tests = steps.flatMap((s) => s.tests);
  const shown = tests
    .slice(0, MAX_LISTED_TESTS)
    .map(
      (t) =>
        `- ${t.name === null ? `${t.file} (the file failed to run)` : `${t.file} > ${t.name}`}`,
    );
  const extra = tests.length - MAX_LISTED_TESTS;
  return [...shown, ...(extra > 0 ? [`- and ${String(extra)} more`] : [])].join('\n');
}

/** Each failing step with its rerun command, its failing tests and its full log. */
function stepsText(steps: readonly GateStepFailure[]): string {
  const failed = `Failed steps:\n${steps.map((s) => `- ${s.name}${s.command === null ? '' : `: ${s.command}`}`).join('\n')}`;
  const tests = steps.some((s) => s.tests.length > 0)
    ? `\n\nFailing tests:\n${testLines(steps)}`
    : '';
  const logs = steps.flatMap((s) =>
    s.logPath === null ? [] : [`Full ${s.name} log: ${s.logPath}`],
  );
  return `${failed}${tests}${logs.length > 0 ? `\n\n${logs.join('\n')}` : ''}`;
}

/** The batch and the first failing step's log, which the desktop offers to open. */
function stepsDetail(batch: BatchDto, steps: readonly GateStepFailure[]): Record<string, Json> {
  const logPath = steps.find((s) => s.logPath !== null)?.logPath;
  return { batchId: batch.id, ...(logPath ? { logPath } : {}) };
}

/** A shipping failure: the code the batch records and the card the builder reads. */
export interface ShipFailure {
  readonly failure: BatchFailure;
  readonly card: Card;
}

export const shipCards = {
  /** `checkout` names a worktree the changes are in; the shared checkout is not named. */
  dirtyCheckout: (batch: BatchDto, paths: readonly string[], checkout?: string): ShipFailure => ({
    failure: BatchFailure.DirtyCheckout,
    card: {
      title: `${notShipped(batch)}: the checkout has uncommitted changes`,
      body: `10db ships only a clean branch. Commit these with a fix task in the batch, or discard them${checkout === undefined ? '' : ` in ${checkout}`}, then retry:\n${listPaths(paths)}\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  /**
   * `note` says why the gate ran without the batch's base as origin has it, when it did. `steps` are
   * the failing steps the gate named, each with its failing tests and log; with none, the card quotes
   * the gate's last output. `reran` says 10db already ran this gate a second time by itself.
   */
  gateFailed: (
    batch: BatchDto,
    gate: GateResult,
    note: string | null = null,
    steps: readonly GateStepFailure[] = [],
    reran = false,
  ): ShipFailure => {
    const what =
      steps.length > 0
        ? stepsText(steps)
        : `Last output:\n${gate.tail.slice(-1500)}\n\nFull log: ${gate.logPath}`;
    return {
      failure: BatchFailure.GateFailed,
      card: {
        title: `${notShipped(batch)}: the gate failed (exit ${String(gate.exitCode)})${inSteps(steps)}`,
        body: `${note === null ? '' : `${note}\n\n`}${reran ? `${RERAN}, and it failed again.\n\n` : ''}${what}\n\nStart a fix task in the batch (it reopens the batch), or ${RETRY.charAt(0).toLowerCase()}${RETRY.slice(1)}`,
        detail: stepsDetail(batch, steps),
      },
    };
  },
  /**
   * The second run 10db made by itself failed in tests the batch didn't change too: the failure looks
   * like the batch's surroundings, so the card offers Retry and Abandon and no fix task.
   */
  gateFailedUnrelated: (
    batch: BatchDto,
    note: string | null,
    steps: readonly GateStepFailure[],
  ): ShipFailure => ({
    failure: BatchFailure.GateFailed,
    card: {
      title: `${notShipped(batch)}: the gate failed twice, in tests the batch didn't change`,
      body: `${note === null ? '' : `${note}\n\n`}This failure looks unrelated to the batch's work. ${RERAN}, and it failed again in tests the batch didn't change, so a flaky test, the base branch or this machine is the likelier cause. 10db started no fix session.\n\n${stepsText(steps)}\n\nPress Retry to run the gate and ship again, or Abandon to give up the batch; both are here and in a task's drawer on the Board. Nothing was merged.`,
      detail: { ...stepsDetail(batch, steps), actions: ['retry', 'abandon'] },
    },
  }),
  /** The second run 10db made by itself passed, and the batch went on to ship. */
  gatePassedOnRerun: (batch: BatchDto, steps: readonly GateStepFailure[]): Card => ({
    title: `Batch "${batch.title}": the gate passed when 10db ran it again`,
    body: `The shipping gate's first run failed${inSteps(steps)}. ${RERAN}, and it passed, so the batch went on to ship. These tests may be flaky:\n${testLines(steps)}`,
    detail: { batchId: batch.id },
  }),
  gateTimedOut: (batch: BatchDto, timeoutMs: number, logPath: string): ShipFailure => ({
    failure: BatchFailure.GateTimedOut,
    card: {
      title: `${notShipped(batch)}: the gate timed out after ${duration(timeoutMs)}`,
      body: `10db stopped the gate and pushed nothing. Log: ${logPath}\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  pushRejected: (batch: BatchDto, detail: string): ShipFailure => ({
    failure: BatchFailure.PushRejected,
    card: {
      title: `${notShipped(batch)}: git push was rejected`,
      body: `${detail}\n\norigin's ${batch.branch ?? 'branch'} has commits this checkout doesn't, and 10db never force-pushes. Reconcile the branch by hand, then retry.`,
      detail: { batchId: batch.id },
    },
  }),
  pushTimedOut: (batch: BatchDto, timeoutMs: number): ShipFailure => ({
    failure: BatchFailure.Network,
    card: {
      title: `${notShipped(batch)}: git push ran past ${duration(timeoutMs)}`,
      body: `git push was still running after ${duration(timeoutMs)}, so 10db stopped it and every process it started. Check that git reaches origin from your login shell (its SSH agent or credential helper).\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  /** gh missing or signed out; anything else gh or the network did is `network`. */
  network: (batch: BatchDto, step: string, error: unknown): ShipFailure => {
    const gh = ghCard(notShipped(batch), error, 'retry');
    return gh
      ? { failure: BatchFailure.GhUnavailable, card: { ...gh, detail: { batchId: batch.id } } }
      : {
          failure: BatchFailure.Network,
          card: {
            title: `${notShipped(batch)}: ${step} failed`,
            body: `${detailOf(error)}\n\n${RETRY}`,
            detail: { batchId: batch.id },
          },
        };
  },
  abandoned: (batch: BatchDto, doneTitles: readonly string[]): Card => ({
    title: `Batch "${batch.title}" abandoned`,
    body:
      doneTitles.length > 0
        ? `These tasks stay done, but their code is unmerged, only on the local branch ${batch.branch ?? '(none)'}:\n${doneTitles.map((t) => `- ${t}`).join('\n')}`
        : 'Nothing in it finished.',
    detail: { batchId: batch.id },
  }),
};

/** The fold key of the project's repository-doesn't-allow-auto-merge card: one stays open at a time. */
export const autoMergeOffKey = (projectId: ProjectId): string => `auto-merge-off:${projectId}`;

/** What delivery tells the builder when a pull request that should merge by itself can't. */
export const mergeCards = {
  /** The repository's own setting is off; every later pull request of the project waits the same way. */
  notAllowed: (
    project: Pick<ProjectDto, 'id'>,
    repo: string,
    batch: BatchDto,
    prUrl: string,
  ): Card => ({
    title: "This repository doesn't allow auto-merge",
    body: `GitHub's "Allow auto-merge" setting is off for ${repo}, so a pull request can't merge itself when its checks pass. The pull request for batch "${batch.title}" is open and waits for you to merge it: ${prUrl}\n\nTurn on Allow auto-merge in ${repo}'s settings on GitHub (Settings, General, Pull Requests) and 10db will have later pull requests merge by themselves.`,
    foldKey: autoMergeOffKey(project.id),
    detail: { batchId: batch.id },
  }),
  /** GitHub turned this one pull request down, or gh could not ask. */
  refused: (batch: BatchDto, prUrl: string, error: unknown): Card => {
    const detail = detailOf(error);
    const nothingToWaitFor = /clean status/i.test(detail)
      ? `\n\nGitHub says nothing is left for it to wait for, which usually means ${batch.baseBranch} has no required checks, so there is nothing for auto-merge to wait on.`
      : '';
    return {
      title: `Pull request opened but not set to merge by itself: batch "${batch.title}"`,
      body: `${detail}${nothingToWaitFor}\n\nThe pull request is open and waits for you to merge it: ${prUrl}`,
      foldKey: `auto-merge-refused:${batch.id}`,
      detail: { batchId: batch.id },
    };
  },
};

/** The place 10db switches a checkout back to, in words. */
function placeName(place: CheckoutPlace): string {
  return place.branch ?? `commit ${place.sha.slice(0, 12)}`;
}

function ended(batch: BatchDto): string {
  switch (batch.state) {
    case BatchState.Shipped:
      return 'shipped';
    case BatchState.Closed:
      return 'closed with nothing to push';
    case BatchState.Abandoned:
      return 'was abandoned';
    // Only a finished batch's checkout is switched back.
    case BatchState.Cutting:
    case BatchState.Open:
    case BatchState.Shipping:
    case BatchState.Failed:
      return 'ended';
  }
}

/**
 * Why 10db left a shared batch's checkout on the batch's branch when the batch ended, instead of
 * switching it back to where the cut found it. One per batch.
 */
function leftCard(batch: BatchDto, why: string, body: string): Card {
  return {
    title: `Your checkout stays on ${batch.branch ?? '(no branch)'}: ${why}`,
    body,
    foldKey: `checkout-return:${batch.id}`,
    detail: { batchId: batch.id },
  };
}

/** The project as these cards name it. */
type Checkout = Pick<ProjectDto, 'name' | 'repoPath'>;

export const checkoutCards = {
  dirty: (
    batch: BatchDto,
    project: Checkout,
    place: CheckoutPlace,
    paths: readonly string[],
  ): Card =>
    leftCard(
      batch,
      'it has uncommitted changes',
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to ${placeName(place)} when a batch ends, but only when nothing in it is uncommitted, and these files have changes:\n${listPaths(paths)}\n\nCommit, stash or discard them, then switch back with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  ignored: (
    batch: BatchDto,
    project: Checkout,
    place: CheckoutPlace,
    paths: readonly string[],
  ): Card =>
    leftCard(
      batch,
      `ignored files are where ${placeName(place)} has files`,
      `Batch "${batch.title}" ${ended(batch)}. Switching your checkout back to ${placeName(place)} would overwrite or delete these git-ignored files, which git treats as disposable:\n${listPaths(paths)}\n\nMove what you need out of the way, then switch back with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  checkedOut: (batch: BatchDto, place: CheckoutPlace, path: string): Card =>
    leftCard(
      batch,
      `${placeName(place)} is checked out in another worktree`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to ${placeName(place)} when a batch ends, but ${placeName(place)} is checked out in the worktree at ${path}, and git checks a branch out in one worktree at a time. Switch that worktree to another branch or remove it, then switch this checkout yourself.`,
    ),
  gone: (batch: BatchDto, project: Checkout, place: CheckoutPlace): Card =>
    leftCard(
      batch,
      `${placeName(place)} no longer exists`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to where it was when the batch started, ${placeName(place)}, which is gone now. Switch ${project.repoPath} to the branch you want with git switch.`,
    ),
  lanesRunning: (batch: BatchDto, project: Checkout, place: CheckoutPlace, lanes: number): Card =>
    leftCard(
      batch,
      `work is running in ${project.name}`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches branches only when no work runs in the project, and ${String(lanes)} workstream(s) run now. Once they finish, switch back with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  failed: (batch: BatchDto, project: Checkout, place: CheckoutPlace, error: unknown): Card =>
    leftCard(
      batch,
      `10db could not switch it back to ${placeName(place)}`,
      `Batch "${batch.title}" ${ended(batch)}. ${detailOf(error)}\n\nOnce that is fixed, switch back with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
};

/** The fold keys of a shipped pull request's cards. */
export const prCardKey = {
  checks: (batchId: BatchId): string => `pr-checks:${batchId}`,
  closed: (batchId: BatchId): string => `pr-closed:${batchId}`,
  /** One per daemon: gh being unavailable is the same problem for every pull request. */
  ghUnavailable: 'pr-watch-gh',
} as const;

/** The batch's pull request; the cards carry it as `detail.link` so the desktop can open it. */
function prDetail(batch: BatchDto, link: string): Record<string, Json> {
  return { batchId: batch.id, prUrl: batch.prUrl, link };
}

/** What the pull request watch tells the builder about a shipped pull request. */
export const prCards = {
  /** `failing` is never empty; the first check's link leads the body and is the card's link. */
  checksFailed: (batch: BatchDto, failing: readonly FailingCheckDto[]): Card => {
    const prUrl = batch.prUrl ?? '(no pull request)';
    const first = failing[0];
    const more = failing.length - 1;
    const link = first?.url ?? prUrl;
    return {
      title: `Pull request checks failed for "${batch.title}": ${first?.name ?? 'a check'}${more > 0 ? ` and ${String(more)} more` : ''}`,
      body: [
        link,
        `Failing:\n${failing.map((c) => `- ${c.name}${c.url ? `: ${c.url}` : ' (no link)'}`).join('\n')}`,
        `Pull request: ${prUrl}`,
        `Open the link to see why it failed, then fix it on the branch ${batch.branch ?? '(none)'} and push. 10db withdraws this card when the checks pass or the pull request merges.`,
      ].join('\n\n'),
      foldKey: prCardKey.checks(batch.id),
      detail: prDetail(batch, link),
    };
  },
  /** Offers to delete the local branch, which stays until the builder answers. */
  closed: (batch: BatchDto): Card => {
    const prUrl = batch.prUrl ?? '(no pull request)';
    const offer = batch.branch === null ? {} : branchOffer(batch);
    const keeps =
      batch.branch === null
        ? ''
        : ` 10db keeps the local branch ${batch.branch} until you answer: Delete Branch removes it from your repository, Keep leaves it.`;
    return {
      title: `Pull request closed without merging: "${batch.title}"`,
      body: `${prUrl}\n\nThe batch's tasks are in Blocked on the Board, because their code is not on ${batch.baseBranch}.${keeps}\n\nOn the Board, reopen a task to run it again, or close it if you don't want the work. To land the existing work instead, reopen the pull request on GitHub and merge it there; 10db doesn't follow a reopened pull request, so close the tasks once it merges.`,
      foldKey: prCardKey.closed(batch.id),
      ...offer,
      detail: { ...prDetail(batch, prUrl), ...offer.detail },
    };
  },
  /**
   * `batch` is the first one whose status turned unknown. The card has no `detail.link`: the desktop
   * would offer to open that one pull request, and no page there says why gh fails.
   */
  ghUnavailable: (batch: BatchDto, error: unknown): Card => ({
    ...prCards.ghUnavailableText(error),
    detail: { batchId: batch.id, prUrl: batch.prUrl },
  }),
  /** The gh card without its detail: what an open one is rewritten with when gh fails another way. */
  ghUnavailableText: (error: unknown): Card => {
    const kind = error instanceof GhError ? error.kind : null;
    const until =
      'Until then the status of shipped pull requests stays unknown here. Nothing else is affected, and 10db keeps checking.';
    const foldKey = prCardKey.ghUnavailable;
    if (kind === 'signed_out')
      return {
        foldKey,
        title: 'Pull request status unknown: gh is signed out',
        body: `10db reads your pull requests' checks and merge state with gh. Run gh auth login in a terminal. ${until}`,
      };
    if (kind === 'not_installed')
      return {
        foldKey,
        title: 'Pull request status unknown: gh is not installed',
        body: `10db reads your pull requests' checks and merge state with gh. Install the GitHub CLI (brew install gh) and sign in with gh auth login. ${until}`,
      };
    return {
      foldKey,
      title: 'Pull request status unknown: gh could not reach GitHub',
      body: `gh couldn't reach GitHub: ${detailOf(error)}\n\nCheck your connection and run gh auth status in a terminal to see why. ${until}`,
    };
  },
};

/** The fold keys of the cards about a task's local branch. */
export const branchCardKey = {
  offer: (batchId: BatchId): string => `branch-offer:${batchId}`,
  /** One per project: the branches no batch names. */
  withoutBatch: 'branches-without-batch',
} as const;

/** What 10db tells the builder about the local branches of finished tasks. */
export const branchCards = {
  /** An abandoned task's branch holds work; `commits` counts what it has beyond its base. */
  abandoned: (batch: BatchDto, commits: number): Card => ({
    title: `Delete ${batch.branch ?? 'the branch'}? It holds ${commitsOf(commits)}`,
    body: `Batch "${batch.title}" was abandoned, and its branch ${batch.branch ?? '(none)'} holds ${commitsOf(commits)} beyond ${batch.baseBranch}. 10db keeps it until you answer: Delete Branch removes it from your repository, so that work is gone; Keep leaves it.`,
    foldKey: branchCardKey.offer(batch.id),
    ...branchOffer(batch),
  }),
  /** A Delete Branch answer git can't carry out while the branch is checked out. */
  checkedOut: (batch: BatchDto, path: string): Card => ({
    title: `${batch.branch ?? 'The branch'} was not deleted: it is checked out`,
    body: `${batch.branch ?? 'The branch'} is checked out in ${path}, and git won't delete a branch that is in use. Switch ${path} to another branch, then answer again.`,
    foldKey: branchCardKey.offer(batch.id),
    ...branchOffer(batch),
  }),
  /** `branches` is never empty. 10db never deletes these: nothing records that it made them. */
  withoutBatch: (branches: readonly string[]): Card => ({
    title: `${String(branches.length)} local branch${branches.length === 1 ? '' : 'es'} under 10db/ without a task`,
    body: `10db has no task for these local branches, so it can't tell whether they are yours and leaves them alone:\n${listPaths(branches)}\n\nDelete the ones you don't need with git branch -D <name>.`,
    foldKey: branchCardKey.withoutBatch,
    refresh: true,
  }),
};
