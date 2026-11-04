import {
  BatchFailure,
  BatchState,
  type BatchDto,
  type CardResolvesWhen,
  type BatchId,
  type CiStopped,
  type FailingCheckDto,
  type InboxOption,
  type ProjectDto,
  type ProjectId,
  type RequiredCheckJobDto,
  type TaskDto,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import type { Json } from '@10db/db';
import {
  checkoutSwitchCommand,
  GitNetworkError,
  worktreeRemovalCommand,
  type CheckoutPlace,
} from '../git';
import { GhError } from '../github';
import type { GateResult } from '../verify';
import { batchCardFields } from './batch-card';
import { maxCiFixes } from './ci-failure-action';
import type { BlockedTask, UnmergedDependency } from './deps';
import type { GateStepFailure } from './gate-failures';
import { INSTALL_SUMMARY, type DependencyRefresh } from './worktree-dependencies';

/** A flag card's text. Every delivery card says what to fix (batch delivery spec §1). */
export interface Card {
  readonly title: string;
  readonly body: string;
  /** An open card with the same key is reused instead of raising another. */
  readonly foldKey?: string;
  /** A repeat that folds replaces the open card's title, body, options and detail with this one's. */
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

/** The `detail` key of a worktree or checkout card that offers an answer the daemon acts on. */
export const WORKTREE_CARD_DETAIL = 'worktreeCard';

/** The answers of a worktree card (`createWorktreeCardAnswers`). */
export const WorktreeChoice = {
  /** Make a failed batch's worktree whole again and reopen the batch. */
  Retry: 'Retry',
  Abandon: 'Abandon batch',
  /** Remove a kept worktree and what it holds. */
  Remove: 'Remove worktree',
  /** Delete a directory git doesn't list as a worktree. */
  Delete: 'Delete directory',
  Keep: 'Keep',
} as const;
export type WorktreeChoice = (typeof WorktreeChoice)[keyof typeof WorktreeChoice];

/** The answers of a card about a checkout left on a batch's branch. */
export const CheckoutChoice = {
  /** Try the switch back again, to where the checkout was when the batch started. */
  SwitchBack: 'Switch back',
  /** Switch to the batch's base branch instead of the place that is gone. */
  SwitchBase: 'Switch to the base branch',
  Leave: 'Leave it',
} as const;
export type CheckoutChoice = (typeof CheckoutChoice)[keyof typeof CheckoutChoice];

/** What a worktree or checkout card offers, which `createWorktreeCardAnswers` carries out. */
export type WorktreeOffer =
  /** A failed batch whose worktree can't be made whole: retry it, or give the batch up. */
  | { readonly kind: 'batch'; readonly batchId: BatchId }
  /** An open batch whose worktree is gone, which only abandoning settles. */
  | { readonly kind: 'abandon'; readonly batchId: BatchId }
  /** A finished batch's worktree 10db kept. */
  | { readonly kind: 'kept'; readonly batchId: BatchId }
  /** A worktree no batch uses any more. */
  | { readonly kind: 'orphan'; readonly path: string }
  /** A directory under the worktree root that git doesn't list as a worktree. */
  | { readonly kind: 'stray'; readonly path: string }
  /** A checkout left on a finished batch's branch; `place` is where it goes back to. */
  | {
      readonly kind: 'checkout';
      readonly batchId: BatchId;
      readonly place: { readonly branch: string | null; readonly sha: string };
      /** The base branch to switch to when the place is gone. */
      readonly base?: string;
    };

/** The options and detail a card carries to offer `offer`; `detail` adds to the card's own. */
export function worktreeOffer(
  offer: WorktreeOffer,
  detail: Record<string, Json> = {},
): Required<Pick<Card, 'options' | 'detail'>> {
  const keep = (what: string): InboxOption => ({
    label: WorktreeChoice.Keep,
    description: `Leave ${what} where it is`,
  });
  const abandon: InboxOption = {
    label: WorktreeChoice.Abandon,
    description: 'Give up the batch and its tasks stop; the branch is offered for deletion',
  };
  const options = ((): InboxOption[] => {
    switch (offer.kind) {
      case 'batch':
        return [
          {
            label: WorktreeChoice.Retry,
            description: 'Make the worktree whole again from the batch branch and reopen the batch',
          },
          abandon,
        ];
      case 'abandon':
        return [abandon];
      case 'kept':
      case 'orphan':
        return [
          {
            label: WorktreeChoice.Remove,
            description: 'Remove the worktree and everything in it, uncommitted work included',
          },
          keep('the worktree'),
        ];
      case 'stray':
        return [
          {
            label: WorktreeChoice.Delete,
            description: 'Delete the directory and everything in it',
          },
          keep('the directory'),
        ];
      case 'checkout':
        return [
          offer.base === undefined
            ? {
                label: CheckoutChoice.SwitchBack,
                description: 'Try switching the checkout back again, once nothing is in the way',
              }
            : {
                label: CheckoutChoice.SwitchBase,
                description: `Switch the checkout to ${offer.base}`,
              },
          { label: CheckoutChoice.Leave, description: 'Leave the checkout where it is' },
        ];
    }
  })();
  return { options, detail: { ...detail, [WORKTREE_CARD_DETAIL]: { ...offer } } };
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
  stray: (path: string): string => `worktree-stray:${path}`,
  removeFailed: (path: string): string => `worktree-remove-failed:${path}`,
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
    body: `10db switches branches only when no lane runs in Your folder (${project.repoPath}); lanes in separate copies don't block it. ${String(lanes)} lane(s) run in Your folder now. Let them finish, or cancel them in the Factory view, then start again.`,
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
  /** `where` and `depWhere` are the placements in words ("Your folder", "a separate copy"). */
  crossPlacementDependency: (
    task: TaskDto,
    where: string,
    dep: TaskDto,
    depWhere: string,
  ): Card => ({
    title: 'Not started: a task depends on a task that runs somewhere else',
    body: `${task.title} runs in ${where} but needs ${dep.title}, which runs in ${depWhere}. Tasks that depend on each other must run in the same place: change where one of them runs, then start them again.`,
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
          body: `Nothing in the batch starts without its worktree. Abandon the batch here, or restart 10db, which fails the batch so Retry can make the worktree again from ${branch}.`,
          foldKey: `worktree-missing:${batch.id}`,
          ...worktreeOffer({ kind: 'abandon', batchId: batch.id }, detail),
        };
      case 'failed':
        return {
          title: `Batch "${batch.title}" failed: its worktree ${path} is missing`,
          body: `10db restarted and found no worktree at ${path}, so nothing in the batch runs. Retry makes it again from ${branch}; Abandon batch gives the batch up.`,
          ...worktreeOffer({ kind: 'batch', batchId: batch.id }, detail),
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
    body: `10db never throws away uncommitted work, so it kept the worktree with these changes:\n${listPaths(paths)}${alsoIgnored(ignored)}\n\nCopy what you need, then answer Remove worktree, or remove it yourself with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.batchChanges(batch.id),
    ...worktreeOffer({ kind: 'kept', batchId: batch.id }, { batchId: batch.id }),
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
    }\n\nCopy what you need, then answer Remove worktree, or remove it yourself with ${worktreeRemovalCommand(main, path)}.${
      batch.branch === null
        ? ''
        : ` Its branch ${batch.branch} is checked out there, so 10db leaves the branch too until the worktree is gone.`
    }`,
    foldKey: keptWorktreeKey.batchIgnored(batch.id),
    ...worktreeOffer({ kind: 'kept', batchId: batch.id }, { batchId: batch.id }),
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
    }\n\n10db never throws away uncommitted work. Copy what you need, then answer Remove worktree, or remove it yourself with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.orphanChanges(path),
    ...worktreeOffer({ kind: 'orphan', path }),
  }),
  /** `main` is the project's main checkout, where the removal command runs. */
  orphanIgnored: (main: string, path: string, paths: readonly string[]): Card => ({
    title: `10db kept ${path}: it holds git-ignored files`,
    body: `No batch uses this worktree any more, but it holds git-ignored files 10db didn't put there, such as a hand-made .env:\n${listPaths(paths)}\n\nCopy what you need, then answer Remove worktree, or remove it yourself with ${worktreeRemovalCommand(main, path)}.`,
    foldKey: keptWorktreeKey.orphanIgnored(path),
    ...worktreeOffer({ kind: 'orphan', path }),
  }),
  leftBehind: (batch: BatchDto, path: string): Card => ({
    title: `10db left ${path} in place`,
    body: `The worktree path of batch "${batch.title}" holds a directory git doesn't list as a worktree, so 10db didn't remove it and no longer treats it as the batch's. Look inside first. Delete directory deletes it and everything in it; Keep leaves it for you.`,
    foldKey: keptWorktreeKey.stray(path),
    ...worktreeOffer({ kind: 'stray', path }, { batchId: batch.id }),
  }),
  /** 10db could not carry out a Remove worktree or Delete directory answer: the same offer again. */
  removeFailed: (
    offer: Extract<WorktreeOffer, { kind: 'kept' | 'orphan' | 'stray' }>,
    path: string,
    error: unknown,
  ): Card => ({
    title: `10db could not remove ${path}`,
    body: `${detailOf(error)}\n\nNothing was removed that the error doesn't name. Answer again once that is fixed, or keep ${path}.`,
    foldKey: keptWorktreeKey.removeFailed(path),
    refresh: true,
    ...worktreeOffer(offer),
  }),
  /** A Remove worktree answer on an orphan's card found the path no longer an orphan, so 10db left it. */
  orphanNotRemoved: (path: string, why: string): Card => ({
    title: `10db removed nothing at ${path}`,
    body: `You answered Remove worktree, but 10db checked again and ${why}, so it is no longer a worktree no batch uses. Nothing was removed.`,
    foldKey: keptWorktreeKey.removeFailed(path),
    refresh: true,
  }),
  inTheWay: (batch: BatchDto, path: string, reason: string): Card => ({
    title: `Batch "${batch.title}" not retried: ${path} is in the way`,
    body: `10db makes the worktree whole on ${batch.branch ?? '(not cut)'} before a retry, and won't remove what is at ${path}: ${reason}. Look inside; if nothing there is needed, delete it, then answer Retry (Abandon batch gives the batch up).`,
    foldKey: `worktree-in-the-way:${batch.id}`,
    ...worktreeOffer({ kind: 'batch', batchId: batch.id }, { batchId: batch.id }),
  }),
  notReopened: (batch: BatchDto, error: unknown): Card => ({
    title: `Batch "${batch.title}" not reopened: ${detailOf(error)}`,
    body: `10db makes the worktree whole on ${batch.branch ?? '(not cut)'} before the batch reopens, and couldn't. Fix the cause, then answer Retry (Abandon batch gives the batch up).`,
    ...worktreeOffer({ kind: 'batch', batchId: batch.id }, { batchId: batch.id }),
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
      body: `10db makes the worktree whole on ${branch} before a retry and won't throw away changes. Commit or discard these in ${path}, or run git switch ${branch} there, then answer Retry (Abandon batch gives the batch up):\n${listPaths(paths)}`,
      ...worktreeOffer({ kind: 'batch', batchId: batch.id }, { batchId: batch.id }),
    };
  },
};

/**
 * The fold keys of the cards an earlier build raised for a batch's conflict with its base and for files
 * in its way. Now a notice on the batch's tasks shows both (`notices.ts`); the keys stay so that the
 * removal of the batch's worktree can still close a card such a build left open.
 */
export const baseConflictKey = (batchId: BatchId): string => `base-conflict:${batchId}`;
export const baseKeptKey = (batchId: BatchId): string => `base-kept:${batchId}`;

/**
 * The fold keys of the cards an earlier build raised for a pull request that waits to be merged by hand:
 * the project's repository doesn't allow auto-merge, and GitHub refused it for one batch. The batch's
 * `pull-request-merge` notice says both now; a ship that writes or clears it closes such a card.
 */
export const autoMergeOffKey = (projectId: ProjectId): string => `auto-merge-off:${projectId}`;
export const autoMergeRefusedKey = (batchId: BatchId): string => `auto-merge-refused:${batchId}`;

/** The fold key of a batch's regeneration-failed card; the builder dismisses it once the files are regenerated. */
export const baseRegenerateKey = (batchId: BatchId): string => `base-regenerate:${batchId}`;

/** The answer of a card about a lost-migrations notice whose list could not be read. */
export const LostChoice = { Clear: 'Clear the notice' } as const;
export type LostChoice = (typeof LostChoice)[keyof typeof LostChoice];

/** The `detail` key of such a card; it holds the batch id (`createLostMigrationsAnswers`). */
export const LOST_MIGRATIONS_DETAIL = 'lostMigrations';

/**
 * What a card carries to let the builder end a lost-migrations notice with no readable list. The
 * list is the only thing a gate checks the journal against, so with it gone nothing but the builder
 * can say the migrations are back: the answer is the builder's word that they are.
 */
export function lostMigrationsOffer(batch: BatchDto): Pick<Card, 'options' | 'detail'> {
  return {
    options: [
      {
        label: LostChoice.Clear,
        description:
          "Remove the notice, so gates and a ship no longer stop on it. Only after you checked that the batch's journal holds every migration the base merge lost",
      },
    ],
    detail: { batchId: batch.id, [LOST_MIGRATIONS_DETAIL]: { batchId: batch.id } },
  };
}

/** What the builder checks before answering `LostChoice.Clear`, in words. */
export const CHECK_THE_JOURNAL =
  "To check: list the migrations the batch added (`git diff --name-only <base>...<branch>` on the package's drizzle directory, and the commits the notice names), and confirm each one's name is in the journal at the branch's HEAD, under a number after the base's, with its SQL intact. A migration still missing is re-created on the branch (generate --name <name>, or --custom --name <name> with the SQL copied back byte for byte) before the notice is cleared.";

/**
 * What delivery tells the builder when a worktree batch's branch took its base but its generated files
 * could not be made again. A conflict or files in the way are notices instead (`notices.ts`).
 */
export const baseCards = {
  /**
   * The batch's lost-migrations notice has no readable list, so no gate can tell whether the journal
   * holds the migrations. It folds into `regenerate`'s card, and offers the one answer that ends it.
   */
  lostUnreadable: (batch: BatchDto, worktree: string): Card => ({
    title: `Batch "${batch.title}": a merge of ${batch.baseBranch} lost migrations 10db can no longer list`,
    body: `A merge of ${batch.baseBranch} lost migrations of this batch's, and the list of them could not be read from the batch's lost-migrations notice. 10db cannot tell whether the journal holds them, so no gate passes and nothing ships while the notice stands, and 10db never reads an unreadable list as all carried.\n\n${CHECK_THE_JOURNAL}\n\nThe batch's worktree is ${worktree}. Once the journal holds them all, answer "${LostChoice.Clear}" here: the next gate then runs, and a retry of a failed ship can pass. Abandoning the batch also ends it.`,
    foldKey: baseRegenerateKey(batch.id),
    refresh: true,
    ...lostMigrationsOffer(batch),
  }),
  /**
   * 10db merged the base, taking its version of the generated directories `dirs`, but couldn't
   * regenerate them. `why` is the reason; `restored` says it removed what a failed run wrote there.
   * `worktree` is the batch's worktree.
   */
  regenerate: (
    batch: BatchDto,
    worktree: string,
    dirs: readonly string[],
    problem: { readonly why: string; readonly logPath: string | null; readonly restored: boolean },
  ): Card => ({
    title: `Batch "${batch.title}": 10db couldn't regenerate files after merging ${batch.baseBranch}`,
    body: `10db merged ${batch.baseBranch} into the batch's branch. Both sides changed generated files, which are regenerated from their sources and never merged by hand, so 10db took ${batch.baseBranch}'s version of these directories to regenerate them:\n${listPaths(dirs)}\n\nBut ${problem.why}.${problem.restored ? ` 10db removed what the failed run wrote there, so they hold ${batch.baseBranch}'s version as the merge left them.` : ''}\n\nRegenerate them in the worktree ${worktree} (each package's generate script) and commit the result. Until then the gates see generated files that may not match the sources${problem.logPath === null ? '' : `. The log: ${problem.logPath}`}.`,
    foldKey: baseRegenerateKey(batch.id),
    refresh: true,
    detail: { batchId: batch.id, paths: dirs.slice(0, MAX_LISTED_PATHS) },
  }),
};

/** The answers of a refused start's card, which the daemon acts on (`createStartCardAnswers`). */
export const StartChoice = { Retry: 'Retry start', Cancel: 'Cancel task' } as const;
export type StartChoice = (typeof StartChoice)[keyof typeof StartChoice];

/** The `detail` key of a refused start's card: what Retry start asks the starter to do again. */
export const START_REFUSED_DETAIL = 'startRefused';

/** What a start was asked to do, kept on the card so Retry start can repeat it. */
export interface StartRequest {
  readonly title: string;
  /** The batch the tasks were to join, when they were not starting a batch of their own. */
  readonly batchId?: BatchId;
}

/** A batch title (at most 200 characters) for a repeated start of `tasks`: the first one's, and how many more. */
export function startTitle(tasks: readonly TaskDto[]): string {
  const [first, ...rest] = tasks;
  const more = rest.length > 0 ? ` and ${String(rest.length)} more` : '';
  return `${(first?.title ?? 'Tasks').slice(0, 200 - more.length)}${more}`;
}

/**
 * A refused start's card names its tasks (and the batch it tried to join), so a client can tell a
 * refused start from a join that is still on its way: a joined task gets a workstream instead.
 * The same refusal of the same tasks folds into the card still open, so starting again after a
 * failure does not stack identical cards. It offers two answers the daemon acts on: start the same
 * tasks again once what the card says is fixed, or cancel them. A `request` without a title is
 * repeated under one made from its tasks (`startTitle`). `request` is null for the tasks of a CI
 * fix batch, which a start can't repeat (the pull request's CI-stop card has the Retry): the card
 * then offers Cancel task alone.
 */
export function forTasks(
  card: Card,
  taskIds: Iterable<TaskId>,
  request: Partial<StartRequest> | null = {},
): Card {
  const ids = [...taskIds];
  const these = ids.length > 1 ? 'these tasks' : 'this task';
  return {
    ...card,
    foldKey: card.foldKey ?? `start-refused:${[...ids].sort().join(',')}:${card.title}`,
    refresh: true,
    detail: {
      ...card.detail,
      taskIds: ids,
      [START_REFUSED_DETAIL]: {
        ...(request?.title ? { title: request.title } : {}),
        ...(request?.batchId ? { batchId: request.batchId } : {}),
      },
    },
    options: [
      ...(request
        ? [
            {
              label: StartChoice.Retry,
              description: `Start ${these} again, once what the card says is fixed`,
            },
          ]
        : []),
      { label: StartChoice.Cancel, description: `Remove ${these} from the project's list` },
    ],
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
        // Retry ship and Abandon, as every other ship failure offers.
        detail: answers(batch),
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
/** What ran before the push, as a failed ship's card names it. */
export type ShipCheckName = 'gate' | 'pre-check';

/**
 * The fold key of the card an earlier build raised for a pull request left open because only the
 * pre-check checked it. A `pull-request-merge` notice says it now; a ship that writes the notice closes
 * such a card.
 */
export const preCheckOnlyKey = (batchId: BatchId): string => `pre-check-only:${batchId}`;

const RETRY = "Press Retry in a task's drawer on the Board to ship again; nothing was merged.";

/** How many failing tests a gate card lists. */
const MAX_LISTED_TESTS = 5;

export const RERAN =
  "Every failing test was in a file the batch didn't change and had passed in its tasks' own gates, so 10db ran the gate again by itself";

/** " in test, lint", naming the failing steps after a gate card's title; empty when the gate named none. */
export function inSteps(steps: readonly GateStepFailure[]): string {
  return steps.length === 0 ? '' : ` in ${steps.map((s) => s.name).join(', ')}`;
}

/** Up to five failing tests across the steps, as list lines, then how many more there are. */
export function testLines(steps: readonly GateStepFailure[]): string {
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

/**
 * What a not-shipped card carries so the Inbox shows Retry and Abandon of its batch as buttons over the
 * ship and abandon routes (`detail.actions`). Every ship failure is one the builder answers with one of
 * the two, so none is a card to dismiss.
 */
function answers(batch: BatchDto): Record<string, Json> {
  return { batchId: batch.id, actions: ['retry', 'abandon'] };
}

/** The batch's answers and the first failing step's log, which the desktop offers to open. */
function stepsDetail(batch: BatchDto, steps: readonly GateStepFailure[]): Record<string, Json> {
  const logPath = steps.find((s) => s.logPath !== null)?.logPath;
  return { ...answers(batch), ...(logPath ? { logPath } : {}) };
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
      detail: answers(batch),
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
    check: ShipCheckName = 'gate',
  ): ShipFailure => {
    const what =
      steps.length > 0
        ? stepsText(steps)
        : `Last output:\n${gate.tail.slice(-1500)}\n\nFull log: ${gate.logPath}`;
    return {
      failure: BatchFailure.GateFailed,
      card: {
        title: `${notShipped(batch)}: the ${check} failed (exit ${String(gate.exitCode)})${inSteps(steps)}`,
        body: `${note === null ? '' : `${note}\n\n`}${reran ? `${RERAN}, and it failed again.\n\n` : ''}${what}\n\nStart a fix task in the batch (it reopens the batch), or ${RETRY.charAt(0).toLowerCase()}${RETRY.slice(1)}`,
        detail: stepsDetail(batch, steps),
      },
    };
  },
  /**
   * The branch still holds git's conflict markers from 10db's merge of the base, in `paths`: the
   * shipping gate has no session to resolve them, so it didn't run. The batch records `GateFailed`,
   * the nearest code it has: the check couldn't pass, and a retry runs it once the markers are gone.
   */
  baseMarkers: (batch: BatchDto, paths: readonly string[]): ShipFailure => ({
    failure: BatchFailure.GateFailed,
    card: {
      title: `${notShipped(batch)}: conflict markers from the merge of ${batch.baseBranch} are still in the branch`,
      body: `10db merged origin/${batch.baseBranch} into the branch for a task's gate and left git's conflict markers for a session to resolve. They are still in:\n${listPaths(paths)}\n\nNo gate ran and nothing was pushed. Start a fix task in the batch to resolve them (it reopens the batch), or resolve them by hand in the batch's worktree and commit, then press Retry in a task's drawer on the Board to ship again.`,
      detail: answers(batch),
    },
  }),
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
      detail: stepsDetail(batch, steps),
    },
  }),
  gateTimedOut: (
    batch: BatchDto,
    timeoutMs: number,
    logPath: string,
    note: string | null = null,
    check: ShipCheckName = 'gate',
  ): ShipFailure => ({
    failure: BatchFailure.GateTimedOut,
    card: {
      title: `${notShipped(batch)}: the ${check} timed out after ${duration(timeoutMs)}`,
      body: `${note === null ? '' : `${note}\n\n`}10db stopped the ${check} and pushed nothing. Log: ${logPath}\n\n${RETRY}`,
      detail: answers(batch),
    },
  }),
  /**
   * The base merge before the shipping gate left git's conflict markers in `paths`, and the batch's
   * last task could not be sent back to resolve them (`why`): nothing was pushed and no gate ran.
   */
  baseConflict: (batch: BatchDto, paths: readonly string[], why: string): ShipFailure => ({
    failure: BatchFailure.BaseConflict,
    card: {
      title: `${notShipped(batch)}: it conflicts with ${batch.baseBranch}`,
      body: `10db merged origin/${batch.baseBranch} into the branch and git left conflict markers in:\n${listPaths(paths)}\n\nNo session could resolve them, because ${why}. No gate ran and nothing was pushed. Resolve the markers in the batch's worktree, commit, then retry.\n\n${RETRY}`,
      detail: { batchId: batch.id },
    },
  }),
  /**
   * The copy's packages still did not resolve what its lockfile names after 10db installed again
   * (`note` says which), so the shipping gate did not run: its tools could not have started, and a
   * failure would have said nothing of the batch's code. Retry installs again before the gate.
   */
  /**
   * `note` names the migrations a merge of the base lost and says how to re-create them. An
   * `unreadable` notice has no list a journal could satisfy, so a Retry would stop here again until
   * the builder clears the notice after checking the journal (`LostChoice.Clear`); Abandon also ends it.
   */
  migrationsLost: (
    batch: BatchDto,
    { note, unreadable }: { readonly note: string; readonly unreadable?: true },
  ): ShipFailure => ({
    failure: BatchFailure.BaseConflict,
    card: {
      title: `${notShipped(batch)}: merging ${batch.baseBranch} lost a migration of the batch's`,
      body:
        unreadable === true
          ? `${note}\n\nNo gate ran and nothing was pushed. A Retry would stop here again until the notice is cleared.\n\n${CHECK_THE_JOURNAL}\n\nOnce the journal holds them all, answer "${LostChoice.Clear}" on this card and ${RETRY.charAt(0).toLowerCase()}${RETRY.slice(1)} Abandon gives the batch up instead.`
          : `${note}\n\nNo gate ran and nothing was pushed. Re-create the migration on the batch's branch and commit it.\n\n${RETRY}`,
      detail:
        unreadable === true
          ? { ...lostMigrationsOffer(batch).detail, ...answers(batch) }
          : answers(batch),
      ...(unreadable === true ? { options: lostMigrationsOffer(batch).options } : {}),
    },
  }),
  installBroken: (batch: BatchDto, note: string, noPnpm = false): ShipFailure => ({
    failure: BatchFailure.InstallBroken,
    card: {
      title: `${notShipped(batch)}: the install in its copy is broken`,
      // With no trustworthy pnpm a Retry meets the same refusal: it removes and installs nothing.
      // The daemon captures the login PATH once, at startup, so a PATH change needs a restart.
      body: `${note}\n\nNo gate ran and nothing was pushed. This is the copy's packages, not the batch's code. ${noPnpm ? "Fix pnpm on the login shell's PATH first (a real program outside the project's checkouts, not a script or a version manager's shim): until then a Retry meets the same refusal and nothing changes. If you change PATH, restart 10db so it reads the new one, then Retry; a program replaced in a directory already on PATH needs only the Retry." : "Retry removes the copy's node_modules and installs again from the lockfile before the gate runs."}\n\n${RETRY}`,
      detail: answers(batch),
    },
  }),
  pushRejected: (batch: BatchDto, detail: string): ShipFailure => ({
    failure: BatchFailure.PushRejected,
    card: {
      title: `${notShipped(batch)}: git push was rejected`,
      body: `${detail}\n\norigin's ${batch.branch ?? 'branch'} has commits this checkout doesn't, and 10db never force-pushes. Reconcile the branch by hand, then retry.`,
      detail: answers(batch),
    },
  }),
  /**
   * The remote refused the push for a repository rule or a hook (GH013, a protected branch, a
   * pre-receive hook). Nothing is known of the branch having diverged, so the card quotes the
   * remote's own words and asks for no reconcile.
   */
  pushDeclined: (batch: BatchDto, detail: string): ShipFailure => ({
    failure: BatchFailure.Network,
    card: {
      title: `${notShipped(batch)}: origin refused the push`,
      body: `origin said:\n${detail}\n\nA repository rule or hook on origin declined the push, whatever the branch holds. 10db pushed nothing and never force-pushes. Change the rule or hook (or its bypass list) for ${batch.branch ?? 'this branch'}, then retry.\n\n${RETRY}`,
      detail: answers(batch),
    },
  }),
  /**
   * GitHub's server failed the push (an HTTP 5xx, or a remote rejection with its own error as the
   * reason) and 10db pushed `retries` more times by itself. This says nothing of the branch having
   * diverged: it never learned of a divergence.
   */
  pushServerError: (batch: BatchDto, detail: string, retries: number): ShipFailure => ({
    failure: BatchFailure.Network,
    card: {
      title: `${notShipped(batch)}: GitHub failed the push`,
      body: `GitHub said:\n${detail}\n\nThis is an error on GitHub's side, not a sign the branch diverged. 10db pushed again ${String(retries)} times, a few seconds apart, and it failed each time. Nothing was merged.\n\n${RETRY}`,
      detail: answers(batch),
    },
  }),
  pushTimedOut: (batch: BatchDto, timeoutMs: number): ShipFailure => ({
    failure: BatchFailure.Network,
    card: {
      title: `${notShipped(batch)}: git push ran past ${duration(timeoutMs)}`,
      body: `git push was still running after ${duration(timeoutMs)}, so 10db stopped it and every process it started. Check that git reaches origin from your login shell (its SSH agent or credential helper).\n\n${RETRY}`,
      detail: answers(batch),
    },
  }),
  /** gh missing or signed out; anything else gh or the network did is `network`. */
  network: (batch: BatchDto, step: string, error: unknown): ShipFailure => {
    const gh = ghCard(notShipped(batch), error, 'retry');
    return gh
      ? { failure: BatchFailure.GhUnavailable, card: { ...gh, detail: answers(batch) } }
      : {
          failure: BatchFailure.Network,
          card: {
            title: `${notShipped(batch)}: ${step} failed`,
            body: `${detailOf(error)}\n\n${RETRY}`,
            detail: answers(batch),
          },
        };
  },
};

/**
 * GitHub's answer to turning on auto-merge for a pull request that has nothing left to wait for:
 * either "is in clean status" (checks all pass), or "Protected branch rules not configured for
 * this branch" (the base branch has no protection rules, as `next` has none).
 */
export function nothingToWaitFor(error: unknown): boolean {
  return /clean status|protected branch rules not configured/i.test(detailOf(error));
}

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
function leftCard(
  batch: BatchDto,
  place: CheckoutPlace,
  why: string,
  body: string,
  /** Offers the batch's base branch instead of the place, which is gone. */
  base?: string,
): Card {
  return {
    title: `Your checkout stays on ${batch.branch ?? '(no branch)'}: ${why}`,
    body,
    foldKey: `checkout-return:${batch.id}`,
    ...worktreeOffer(
      {
        kind: 'checkout',
        batchId: batch.id,
        place: { branch: place.branch, sha: place.sha },
        ...(base === undefined ? {} : { base }),
      },
      { batchId: batch.id },
    ),
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
      place,
      'it has uncommitted changes',
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to ${placeName(place)} when a batch ends, but only when nothing in it is uncommitted, and these files have changes:\n${listPaths(paths)}\n\nCommit, stash or discard them, then answer Switch back, or switch back yourself with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  ignored: (
    batch: BatchDto,
    project: Checkout,
    place: CheckoutPlace,
    paths: readonly string[],
  ): Card =>
    leftCard(
      batch,
      place,
      `ignored files are where ${placeName(place)} has files`,
      `Batch "${batch.title}" ${ended(batch)}. Switching your checkout back to ${placeName(place)} would overwrite or delete these git-ignored files, which git treats as disposable:\n${listPaths(paths)}\n\nMove what you need out of the way, then answer Switch back, or switch back yourself with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  checkedOut: (batch: BatchDto, place: CheckoutPlace, path: string): Card =>
    leftCard(
      batch,
      place,
      `${placeName(place)} is checked out in another worktree`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to ${placeName(place)} when a batch ends, but ${placeName(place)} is checked out in the worktree at ${path}, and git checks a branch out in one worktree at a time. Switch that worktree to another branch or remove it, then answer Switch back.`,
    ),
  gone: (batch: BatchDto, project: Checkout, place: CheckoutPlace): Card =>
    leftCard(
      batch,
      place,
      `${placeName(place)} no longer exists`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches your checkout back to where it was when the batch started, ${placeName(place)}, which is gone now. Switch to the base branch ${batch.baseBranch} here, or switch ${project.repoPath} to the branch you want yourself with git switch.`,
      batch.baseBranch,
    ),
  lanesRunning: (batch: BatchDto, project: Checkout, place: CheckoutPlace, lanes: number): Card =>
    leftCard(
      batch,
      place,
      `work is running in ${project.name}`,
      `Batch "${batch.title}" ${ended(batch)}. 10db switches branches only when no lane runs in Your folder (${project.repoPath}); lanes in separate copies don't block it. ${String(lanes)} lane(s) run in Your folder now. Once they finish, answer Switch back, or switch back yourself with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
  failed: (batch: BatchDto, project: Checkout, place: CheckoutPlace, error: unknown): Card =>
    leftCard(
      batch,
      place,
      `10db could not switch it back to ${placeName(place)}`,
      `Batch "${batch.title}" ${ended(batch)}. ${detailOf(error)}\n\nOnce that is fixed, answer Switch back, or switch back yourself with ${checkoutSwitchCommand(project.repoPath, place)}.`,
    ),
};

/** The fold keys of a shipped pull request's cards. */
export const prCardKey = {
  checks: (batchId: BatchId): string => `pr-checks:${batchId}`,
  closed: (batchId: BatchId): string => `pr-closed:${batchId}`,
  /** Fixing the pull request's failing required checks stopped: the root batch's id. */
  ciStopped: (batchId: BatchId): string => `ci-stopped:${batchId}`,
  /** 10db could not bring the base into the conflicting pull request: the root batch's id. */
  catchUp: (batchId: BatchId): string => `pr-catch-up:${batchId}`,
  /** One per daemon: gh being unavailable is the same problem for every pull request. */
  ghUnavailable: 'pr-watch-gh',
} as const;

/** The batch's pull request; the cards carry it as `detail.link` so the desktop can open it. */
function prDetail(batch: BatchDto, link: string): Record<string, Json> {
  return { batchId: batch.id, prUrl: batch.prUrl, link };
}

/** The `detail` key marking the gh card, whose Check again reads the followed pull requests now. */
export const GH_CHECK_DETAIL = 'ghCheck';

/** The answer of the gh card: the watch reads every followed pull request again at once. */
export const GH_CHECK_CHOICE = 'Check again';

/** The `detail` key of a stop card that offers Retry; it holds the root batch's id. */
export const CI_RERUN_DETAIL = 'ciRerun';

/** The answer of a stop card that reruns the failed jobs on GitHub. */
export const CI_RERUN_CHOICE = 'Retry';

const fixesOf = (n: number): string => `${String(n)} ${n === 1 ? 'fix' : 'fixes'}`;

/** What a stop card says of why 10db stopped fixing; `note` is the cut's reason for `no_cut`. */
const CI_STOP_REASON: Record<CiStopped, (fixes: number, note: string | null) => string> = {
  limit: (fixes) =>
    `10db made ${fixesOf(fixes)} for this pull request and the checks still fail. It stops at ${String(maxCiFixes)} and starts no more.`,
  no_change: (fixes) =>
    `The last fix changed nothing, so the cause may not be in the code (a flaky check, or the base branch). 10db ran ${fixesOf(fixes)} and starts no more.`,
  no_log: (fixes) =>
    `10db could not read a log for the failing check (it is not a GitHub Actions job, or GitHub no longer keeps its log), so it started ${fixes === 0 ? 'no fix' : 'no more fixes'}.`,
  no_cut: (fixes, note) =>
    `10db could not set up a fix session on the pull request's branch${note === null ? '' : `: ${note}`}. It ran ${fixesOf(fixes)} and starts no more.`,
};

/** What stopped 10db from bringing a conflicting pull request's base into it. */
export type CatchUpStop =
  /** Both sides changed these files in ways 10db can't combine. */
  | { readonly kind: 'conflict'; readonly paths: readonly string[]; readonly reasons?: string }
  /** The base merged, and the check before shipping failed on the result (nothing was pushed). */
  | {
      readonly kind: 'gate';
      readonly name: ShipCheckName;
      readonly logPath: string | null;
      /** The files 10db settled itself in the merge (both sides' lines kept, or regenerated). */
      readonly settled?: readonly string[];
    }
  /** Something else kept the base out, or the update could not finish: `why` says what. */
  | { readonly kind: 'other'; readonly why: string };

/** What the pull request watch tells the builder about a shipped pull request. */
export const prCards = {
  /**
   * 10db tried to bring the base into the pull request that conflicts with it, and couldn't. One
   * card, which names the files; it closes by itself when GitHub says the pull request merges.
   */
  catchUpStopped: (batch: BatchDto, stop: CatchUpStop): Card => {
    const prUrl = batch.prUrl ?? '(no pull request)';
    const base = batch.baseBranch;
    const resolveOnGitHub = `Resolve it on GitHub (Update branch, then Resolve conflicts), or merge ${base} into ${batch.branch ?? 'the branch'} yourself and push it. 10db merges the pull request once GitHub says it can be merged.`;
    switch (stop.kind) {
      case 'conflict':
        return {
          title: `Pull request for "${batch.title}" conflicts with ${base}`,
          body: `${prUrl}\n\n${base} changed these files in ways that conflict with the batch's own changes, and 10db couldn't settle them itself:\n${listPaths(stop.paths)}${stop.reasons ? `\n\n${stop.reasons}` : ''}\n\n${resolveOnGitHub}`,
          foldKey: prCardKey.catchUp(batch.id),
          refresh: true,
          detail: prDetail(batch, prUrl),
        };
      case 'gate':
        return {
          title: `Pull request for "${batch.title}" not updated: the ${stop.name} failed after merging ${base}`,
          body: `${prUrl}\n\nThe pull request conflicted with ${base}. 10db merged ${base} into the batch's branch, and the ${stop.name} failed on the result, so it pushed nothing.${stop.logPath === null ? '' : ` The log: ${stop.logPath}`}${stop.settled && stop.settled.length > 0 ? `\n\n10db settled these files itself in the merge, so look there first:\n${listPaths(stop.settled)}` : ''}\n\n${resolveOnGitHub}`,
          foldKey: prCardKey.catchUp(batch.id),
          refresh: true,
          detail: prDetail(batch, prUrl),
        };
      case 'other':
        return {
          title: `Pull request for "${batch.title}" conflicts with ${base} and 10db couldn't update it`,
          body: `${prUrl}\n\n${stop.why}\n\n${resolveOnGitHub}`,
          foldKey: prCardKey.catchUp(batch.id),
          refresh: true,
          detail: prDetail(batch, prUrl),
        };
    }
  },

  /**
   * Fixing stopped and the task is Blocked. Names each failing check with its link, and offers to
   * rerun the failed jobs of each failing Actions run on GitHub. `fixes` is how many ran; `note` is
   * the cut's reason when a fix cut was refused.
   */
  ciStopped: (
    root: BatchDto,
    reason: CiStopped,
    failing: readonly RequiredCheckJobDto[],
    fixes: number,
    note: string | null = null,
  ): Card => {
    const prUrl = root.prUrl ?? '(no pull request)';
    const link = failing[0]?.link ?? prUrl;
    const rerun = failing.some((job) => job.runId !== null);
    return {
      title: `CI still failing on ${root.title}: ${failing.map((job) => job.name).join(', ') || 'a required check'}`,
      body: [
        link,
        `Failing:\n${failing.map((c) => `- ${c.name}${c.link ? `: ${c.link}` : ' (no link)'}`).join('\n')}`,
        CI_STOP_REASON[reason](fixes, note),
        `Pull request: ${prUrl}`,
        `${rerun ? 'Retry reruns the failed jobs on GitHub. ' : ''}Or push a commit to ${root.branch ?? 'the branch'}. The task is Blocked on the Board until the required checks pass or start again, or the pull request merges or closes; 10db then closes this card.`,
      ].join('\n\n'),
      foldKey: prCardKey.ciStopped(root.id),
      ...(rerun
        ? {
            options: [
              {
                label: CI_RERUN_CHOICE,
                description: 'Rerun the failed jobs on GitHub (gh run rerun --failed)',
              },
            ],
          }
        : {}),
      detail: { ...prDetail(root, link), [CI_RERUN_DETAIL]: { batchId: root.id } },
    };
  },
  /** GitHub refused the rerun the stop card's Retry asked for. */
  rerunFailed: (root: BatchDto, error: unknown): Card => ({
    title: `Could not rerun the failed CI jobs for ${root.title}`,
    body: `GitHub did not rerun the failed jobs: ${detailOf(error)}\n\nPull request: ${root.prUrl ?? '(none)'}\n\nRerun them from the pull request's checks page, or push a commit to ${root.branch ?? 'the branch'}.`,
    foldKey: `${prCardKey.ciStopped(root.id)}:rerun`,
    detail: prDetail(root, root.prUrl ?? ''),
  }),
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
    detail: { batchId: batch.id, prUrl: batch.prUrl, [GH_CHECK_DETAIL]: true },
    options: [
      {
        label: GH_CHECK_CHOICE,
        description: 'Read every followed pull request now, once gh works',
      },
    ],
  }),
  /** The gh card without its detail: what an open one is rewritten with when gh fails another way. */
  ghUnavailableText: (error: unknown): Card => {
    const kind = error instanceof GhError ? error.kind : null;
    const until =
      'Until then the status of shipped pull requests stays unknown here. Nothing else is affected, and 10db keeps checking; once gh works, answer Check again to read them now.';
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
  deleted: (batchId: BatchId): string => `branch-deleted:${batchId}`,
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
  /**
   * 10db deleted an abandoned task's branch because it held no commits beyond its base;
   * `withWorktree` when the batch's separate copy was removed with it.
   */
  abandonedBranchDeleted: (batch: BatchDto, withWorktree: boolean): Card => ({
    title: `Batch "${batch.title}" abandoned: ${batch.branch ?? 'its branch'} deleted`,
    body: `The branch ${batch.branch ?? '(none)'} held no commits beyond ${batch.baseBranch}, so 10db deleted it${withWorktree ? " along with the batch's worktree" : ''}. Nothing was lost.`,
    foldKey: branchCardKey.deleted(batch.id),
    detail: { batchId: batch.id },
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

/**
 * The tasks a stopped Ship without it meant to leave out, the failed run it was answered on, and the
 * revert commit an earlier answer left on the branch, if one did.
 */
export interface LeftOutAttempt {
  readonly workstreamId: WorkstreamId;
  readonly titles: readonly string[];
  readonly revert?: string | null;
}

/**
 * What every card of a stopped revert shares: it folds per batch, goes when the batch ships, and
 * offers the failed task's own choices, so Ship without it can be answered again here. The first
 * answer closed the failed card, and Ship anyway from the drawer reverts nothing. A revert already on
 * the branch stays in the card's detail, because each stopped answer folds over the card before it.
 */
function leftOutCard(
  batch: BatchDto,
  attempt: LeftOutAttempt,
  card: Pick<Card, 'title' | 'body'>,
): Card {
  return {
    ...card,
    foldKey: `left-out:${batch.id}`,
    refresh: true,
    resolvesWhen: { event: 'batch_shipped', batchId: batch.id },
    ...batchCardFields({ id: attempt.workstreamId, batchId: batch.id }, attempt.revert),
  };
}

const leftOutSubject = (attempt: LeftOutAttempt): string =>
  `${attempt.titles.join(', ')} ${attempt.titles.length === 1 ? 'was' : 'were'} not left out`;

const leftOutNames = (attempt: LeftOutAttempt): string =>
  attempt.titles.map((t) => `"${t}"`).join(', ');

/** What a stopped answer left on the branch: nothing new, and any revert an earlier answer made. */
const leftOutBranch = ({ revert }: LeftOutAttempt): string =>
  revert
    ? `Nothing was shipped, and this answer changed nothing on the branch: the revert commit ${revert.slice(0, 9)} an earlier answer made stays on it.`
    : 'Nothing was shipped and the branch is unchanged.';

/** What the cards say last: how to go on, and what the other answer would do. */
const leftOutAgain = (attempt: LeftOutAttempt): string =>
  `answer Ship without it on this card. ${
    attempt.revert
      ? 'Ship anyway would ship the branch as it stands, and leave the revert unexplained in the drawer and the pull request.'
      : `Ship anyway would put the commits of ${leftOutNames(attempt)} in the pull request.`
  }`;

/** What Ship without it tells the builder when it could not revert a failed task's commits. */
export const leftOutCards = {
  /**
   * The answer no longer fit, or the job could not begin, so nothing was reverted. `why` is a clause
   * that follows "not left out". The answer is offered again only when it can still be given; when
   * it cannot, the batch may have shipped by another way, so the card speaks only of this answer.
   */
  notStarted: (
    batch: BatchDto,
    attempt: LeftOutAttempt,
    why: string,
    answerable: boolean,
  ): Card => {
    const text = {
      title: `${leftOutSubject(attempt)}: ${why}`,
      body: `Ship without it did not begin on ${leftOutNames(attempt)}: ${why}.\n\n${answerable ? `${leftOutBranch(attempt)} When that is settled, ${leftOutAgain(attempt)}` : attempt.revert ? `This answer changed nothing, and Ship without it no longer applies to this batch. The revert commit ${attempt.revert.slice(0, 9)} an earlier answer made stays on the branch.` : 'Ship without it changed nothing, and no longer applies to this batch.'}`,
    };
    return answerable
      ? leftOutCard(batch, attempt, text)
      : { ...text, foldKey: `left-out:${batch.id}`, refresh: true };
  },
  /**
   * The revert commit `revert` is on the batch's branch, but the notices and the move to shipping
   * were not written. `state` is the batch's state now (null when it could not be read), and the
   * next step follows it:
   * - open or failed (or unknown): Ship without it is offered again, with `revert` in the card's
   *   detail. The answer leaves the commits that revert covers out of `revertCommits`, which would
   *   conflict on commits that built on each other, writes the notices naming `revert` and moves the
   *   batch. That beats Ship anyway, which leaves the revert unexplained in the drawer and the pull
   *   request. The card goes when the batch ships;
   * - shipping or later: the ship goes on with the revert in the branch, so there is nothing to do;
   *   the card goes when the batch ships;
   * - abandoned: nothing ships, and no step is offered.
   */
  revertKept: (
    batch: BatchDto,
    attempt: LeftOutAttempt,
    revert: string,
    why: string,
    state: BatchState | null,
  ): Card => {
    const one = attempt.titles.length === 1;
    const its = one ? 'its' : 'their';
    const branch = batch.branch ?? 'the branch';
    const names = leftOutNames(attempt);
    const answerable = state === null || state === BatchState.Open || state === BatchState.Failed;
    const lead = `Ship without it reverted the commits of ${names} on the batch's branch (revert commit ${revert.slice(0, 9)}), and then could not finish:\n\n${why.slice(0, 1500)}\n\n`;
    const fold = { foldKey: `left-out:${batch.id}`, refresh: true } as const;
    if (answerable)
      return leftOutCard(
        batch,
        { ...attempt, revert },
        {
          title: `${names}: the revert is on the branch, but the batch did not move`,
          body: `${lead}The revert stays on ${branch}, and nothing was shipped. ${names} ${one ? 'is' : 'are'} still failed here, and ${its} drawer does not yet say the work was left out. When that is settled, answer Ship without it again on this card: 10db leaves out the commits this revert covers, so it reverts nothing more of them, writes the notices and moves the batch on to ship. Ship anyway also ships the branch without ${its} changes, but leaves the revert unexplained in the drawer and the pull request.`,
        },
      );
    const title = `${names}: the revert is on the branch`;
    if (state === BatchState.Abandoned)
      return {
        title,
        body: `${lead}The batch was abandoned, so nothing will ship. The revert stays on ${branch}, with the branch's other commits.`,
        ...fold,
      };
    const body = `${lead}The batch is ${state.toLowerCase()}, so it went or goes on without ${its} changes: the revert is in the branch. The notices on ${names} were not written, so ${its} drawer does not say the work was left out. There is nothing to answer here.`;
    // A batch that shipped already will not ship again, so nothing would close the card.
    return state === BatchState.Shipped || state === BatchState.Closed
      ? { title, body, ...fold }
      : { title, body, ...fold, resolvesWhen: { event: 'batch_shipped', batchId: batch.id } };
  },
  /** Later commits changed `paths` in ways that conflict with undoing the task's commits. */
  conflict: (batch: BatchDto, attempt: LeftOutAttempt, paths: readonly string[]): Card =>
    leftOutCard(batch, attempt, {
      title: `${leftOutSubject(attempt)}: reverting ${attempt.titles.length === 1 ? 'its' : 'their'} commits conflicts`,
      body: `Ship without it reverts a failed task's commits on the batch's branch before shipping, and later commits changed these files in ways that conflict with that:\n${listPaths(paths)}\n\n${leftOutBranch(attempt)} Resolve it on the branch (revert the commits by hand, or start a fix task in the batch), then ${leftOutAgain(attempt)}`,
    }),
  /** A commit being undone resolved the conflict markers of a merge of the base, now in `paths`. */
  markers: (batch: BatchDto, attempt: LeftOutAttempt, paths: readonly string[]): Card =>
    leftOutCard(batch, attempt, {
      title: `${leftOutSubject(attempt)}: ${attempt.titles.length === 1 ? 'its' : 'their'} commits resolved conflict markers`,
      body: `Ship without it reverts a failed task's commits on the batch's branch before shipping, and one of them resolved the conflict markers a merge of ${batch.baseBranch} left in these files, so undoing it would put the markers back:\n${listPaths(paths)}\n\n${leftOutBranch(attempt)} ${attempt.revert ? 'Resolve' : 'Retry the task, or resolve'} the conflict on the branch without its commits (start a fix task in the batch), then ${leftOutAgain(attempt)}`,
    }),
  /** Something else stopped the revert: `why` is git's or 10db's own words. */
  failed: (batch: BatchDto, attempt: LeftOutAttempt, why: string): Card =>
    leftOutCard(batch, attempt, {
      title: `${leftOutSubject(attempt)}: ${why.split('\n')[0]?.slice(0, 200) ?? why}`,
      body: `Ship without it could not ${attempt.revert ? 'finish leaving out' : 'revert the commits of'} ${leftOutNames(attempt)} on the batch's branch:\n\n${why.slice(0, 1500)}\n\n${leftOutBranch(attempt)} Fix what it names, then ${leftOutAgain(attempt)}`,
    }),
  /** Uncommitted changes are in `paths`, which the revert writes. */
  blocked: (batch: BatchDto, attempt: LeftOutAttempt, paths: readonly string[]): Card =>
    leftOutCard(batch, attempt, {
      title: `${leftOutSubject(attempt)}: uncommitted changes are in the way`,
      body: `Ship without it reverts a failed task's commits on the batch's branch, which writes these files, and they have uncommitted changes:\n${listPaths(paths)}\n\n${leftOutBranch(attempt)} Commit or discard the changes, then ${leftOutAgain(attempt)}`,
    }),
};
