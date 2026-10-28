import { BatchFailure, type BatchDto, type ProjectDto, type TaskId } from '@10db/contracts';
import type { Json } from '@10db/db';
import { GitNetworkError } from '../git';
import { GhError } from '../github';
import type { GateResult } from '../verify';
import type { BlockedTask, UnmergedDependency } from './deps';

/** A flag card's text. Every delivery card says what to fix (batch delivery spec §1). */
export interface Card {
  readonly title: string;
  readonly body: string;
  /** An open card with the same key is reused instead of raising another. */
  readonly foldKey?: string;
  readonly detail?: Record<string, Json>;
}

export const MAX_LISTED_PATHS = 20;

export function listPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED_PATHS).map((p) => `- ${p}`);
  const extra = paths.length - MAX_LISTED_PATHS;
  return [...shown, ...(extra > 0 ? [`- and ${String(extra)} more`] : [])].join('\n');
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
    body: `10db cuts a batch branch only from a clean checkout. Commit, stash or discard these paths in ${project.repoPath}, then start again:\n${listPaths(paths)}`,
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
  missing: (batch: BatchDto, path: string, outcome: 'waits' | 'failed'): Card => {
    const branch = batch.branch ?? '(not cut)';
    const detail = { batchId: batch.id };
    switch (outcome) {
      case 'waits':
        return {
          title: `Batch "${batch.title}" waits: its worktree ${path} is missing`,
          body: `Nothing in the batch starts without its worktree. Abandon the batch on its strip, or restart 10db, which fails the batch so Retry can make the worktree again from ${branch}.`,
          foldKey: `worktree-missing:${batch.id}`,
          detail,
        };
      case 'failed':
        return {
          title: `Batch "${batch.title}" failed: its worktree ${path} is missing`,
          body: `10db restarted and found no worktree at ${path}, so nothing in the batch runs. Press Retry on the batch strip to make it again from ${branch}, or abandon the batch there.`,
          detail,
        };
    }
  },
  keptDirty: (batch: BatchDto, path: string, paths: readonly string[]): Card => ({
    title: `Batch "${batch.title}" abandoned: uncommitted changes kept in ${path}`,
    body: `10db never throws away uncommitted work, so it kept the worktree with these changes:\n${listPaths(paths)}\n\nCopy what you need, then remove it with git worktree remove --force --force ${path}`,
    foldKey: `worktree-kept:${batch.id}`,
    detail: { batchId: batch.id },
  }),
  leftBehind: (batch: BatchDto, path: string): Card => ({
    title: `10db left ${path} in place`,
    body: `The worktree path of batch "${batch.title}" holds a directory git doesn't list as a worktree, so 10db didn't remove it and no longer treats it as the batch's. Look inside, then delete it yourself if nothing there is needed.`,
    detail: { batchId: batch.id },
  }),
  notReopened: (batch: BatchDto, error: unknown): Card => ({
    title: `Batch "${batch.title}" not reopened: ${detailOf(error)}`,
    body: `10db makes the worktree whole on ${batch.branch ?? '(not cut)'} before the batch reopens, and couldn't. Fix the cause, then press Retry on the batch strip.`,
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
      body: `10db makes the worktree whole on ${branch} before a retry and won't throw away changes. Commit or discard these in ${path}, or run git switch ${branch} there, then press Retry on the batch strip:\n${listPaths(paths)}`,
      detail: { batchId: batch.id },
    };
  },
};

/**
 * A refused start's card names its tasks (and the batch it tried to join), so a client can tell a
 * refused start from a join that is still on its way: a joined task gets a workstream instead.
 */
export function forTasks(card: Card, taskIds: Iterable<TaskId>): Card {
  return { ...card, detail: { ...card.detail, taskIds: [...taskIds] } };
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
        body: `Nothing in the batch starts until the checkout is back on its branch. Run git switch ${branch} in ${repoPath}, or abandon the batch on its strip.`,
        foldKey: `batch-branch:${batch.id}:${on}`,
        detail,
      };
    case 'failed':
      return {
        title: `Batch "${batch.title}" failed: ${where}`,
        body: `10db restarted with the checkout off the batch branch, so nothing in the batch runs. Run git switch ${branch} in ${repoPath}, then press Retry on the batch strip; or abandon the batch there.`,
        detail,
      };
    case 'not_shipped':
      return {
        title: `Batch "${batch.title}" not shipped: ${where}`,
        body: `10db ships only from the batch branch, and pushed nothing. Run git switch ${branch} in ${repoPath}, then press Retry on the batch strip.`,
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
const RETRY = 'Press Retry on the batch strip to ship again; nothing was merged.';

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
  gateFailed: (batch: BatchDto, gate: GateResult): ShipFailure => ({
    failure: BatchFailure.GateFailed,
    card: {
      title: `${notShipped(batch)}: the gate failed (exit ${String(gate.exitCode)})`,
      body: `Last output:\n${gate.tail.slice(-1500)}\n\nFull log: ${gate.logPath}\n\nStart a fix task in the batch (it reopens the batch), or ${RETRY.charAt(0).toLowerCase()}${RETRY.slice(1)}`,
      detail: { batchId: batch.id },
    },
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
        : `Nothing in it finished. The local branch ${batch.branch ?? '(none)'} is kept.`,
    detail: { batchId: batch.id },
  }),
};
