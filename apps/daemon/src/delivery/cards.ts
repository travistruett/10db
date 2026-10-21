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
  repoUnknown: (project: ProjectDto, error: unknown): Card =>
    ghCard(NOT_STARTED, error, 'start again') ?? {
      title: `${NOT_STARTED}: gh can't find the GitHub repository for ${project.repoPath}`,
      body: `${detailOf(error)}\n\nPull request delivery needs origin to point at github.com and gh to be signed in to an account that can open pull requests there.`,
    },
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
  dirtyCheckout: (batch: BatchDto, paths: readonly string[]): ShipFailure => ({
    failure: BatchFailure.DirtyCheckout,
    card: {
      title: `${notShipped(batch)}: the checkout has uncommitted changes`,
      body: `10db ships only a clean branch. Commit these with a fix task in the batch, or discard them, then retry:\n${listPaths(paths)}\n\n${RETRY}`,
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
