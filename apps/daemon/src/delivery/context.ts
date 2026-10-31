import { CARD_RESOLVES_WHEN, type BatchId, type Notice, type ProjectId } from '@10db/contracts';
import { clearBatchNotice, findOpenByFoldKey, setBatchNotice, type WriteContext } from '@10db/db';
import type { StateStore } from '../events';
import type { Git, NetworkCall } from '../git';
import type { Gh, GhCall } from '../github';
import { flagCard, rewordCard, withdrawCard, type InboxService } from '../inbox';
import type { Logger } from '../log';
import type { Card } from './cards';
import type { DeliveryJobs } from './jobs';
import type { WorktreeDependencies } from './worktree-dependencies';

export interface DeliveryLimits {
  /** Each fetch and gh call. */
  readonly networkTimeoutMs: number;
  /**
   * The push. It runs no hook, but it uploads every commit of the batch, which on a slow link takes
   * longer than a fetch of one branch.
   */
  readonly pushTimeoutMs: number;
  /** The shipping gate; the daemon passes the runner's gate timeout. */
  readonly gateTimeoutMs: number;
}

export const DEFAULT_DELIVERY_LIMITS: DeliveryLimits = {
  networkTimeoutMs: 2 * 60_000,
  pushTimeoutMs: 30 * 60_000,
  gateTimeoutMs: 30 * 60_000,
};

/** What every delivery step needs. */
export interface DeliveryContext {
  readonly state: StateStore;
  readonly git: Git;
  readonly gh: Gh;
  readonly inbox: InboxService;
  readonly jobs: DeliveryJobs;
  readonly logger: Logger;
  readonly limits: DeliveryLimits;
  /** Where this daemon makes worktrees: the data dir's hashed level, made at the first worktree cut. */
  readonly worktreeRoot: string;
  /** Brings a new worktree's seeded packages in line with its lockfile. */
  readonly dependencies: WorktreeDependencies;
  /** The login environment network calls run in (environment/buildNetworkEnv). */
  networkEnv(): Readonly<Record<string, string>>;
  /** Asks the scheduler to look for work: a batch opened, grew or reopened. */
  onWorkQueued(): void;
}

export function networkCall(ctx: DeliveryContext, signal: AbortSignal): NetworkCall {
  return { env: ctx.networkEnv(), timeoutMs: ctx.limits.networkTimeoutMs, signal };
}

export function pushCall(ctx: DeliveryContext, signal: AbortSignal): NetworkCall {
  return { ...networkCall(ctx, signal), timeoutMs: ctx.limits.pushTimeoutMs };
}

export function ghCall(ctx: DeliveryContext, signal: AbortSignal): GhCall {
  return networkCall(ctx, signal);
}

/** The flag a delivery card raises. */
function flagOf(projectId: ProjectId, card: Card) {
  return {
    projectId,
    workstreamId: null,
    title: card.title,
    body: card.body,
    ...(card.foldKey ? { foldKey: card.foldKey } : {}),
    ...(card.refresh ? { refresh: true } : {}),
    ...(card.detail || card.resolvesWhen
      ? {
          detail: {
            ...card.detail,
            ...(card.resolvesWhen ? { [CARD_RESOLVES_WHEN]: card.resolvesWhen } : {}),
          },
        }
      : {}),
    ...(card.options ? { options: card.options } : {}),
  };
}

/**
 * Shows `notice` on the batch's tasks. Finding the same cause again writes nothing and tells no one,
 * so a gate that meets a standing conflict again changes nothing.
 */
export function showNotice(state: StateStore, batchId: BatchId, notice: Notice): void {
  state.write((w) => setBatchNotice(w, batchId, notice));
}

/** Takes the notices with these keys off the batch's tasks: what they said is gone. */
export function hideNotices(state: StateStore, batchId: BatchId, keys: readonly string[]): void {
  state.write((w) => {
    for (const key of keys) clearBatchNotice(w, batchId, key);
  });
}

/** Delivery cards belong to the project, not to one workstream. */
export function raise(inbox: InboxService, projectId: ProjectId, card: Card): void {
  inbox.flag(flagOf(projectId, card));
}

/** `raise` inside the caller's write: the card commits with the change that raised it, or neither does. */
export function raiseIn(write: WriteContext, projectId: ProjectId, card: Card): void {
  flagCard(write, flagOf(projectId, card));
}

/**
 * Brings the project's open card with `card`'s fold key in line with `card`, inside the caller's
 * write: its title and body, and its detail when `card` has one, so it says what holds now. A
 * dismissed card stays dismissed, and a card that says this already is not written again.
 */
export function rewriteIn(write: WriteContext, projectId: ProjectId, card: Card): void {
  if (card.foldKey === undefined) return;
  const open = findOpenByFoldKey(write.tx, projectId, card.foldKey);
  if (open === undefined) return;
  const same =
    open.title === card.title &&
    open.body === card.body &&
    (card.detail === undefined || JSON.stringify(open.detail) === JSON.stringify(card.detail));
  if (same) return;
  rewordCard(write, open.id, card.body, {
    title: card.title,
    ...(card.detail ? { detail: card.detail } : {}),
  });
}

/** `withdraw` inside the caller's write. */
export function withdrawIn(
  write: WriteContext,
  projectId: ProjectId,
  foldKeys: readonly string[],
): void {
  for (const key of foldKeys) {
    const open = findOpenByFoldKey(write.tx, projectId, key);
    if (open) withdrawCard(write, open.id);
  }
}

/** Withdraws the project's open cards with these fold keys: what they asked about is gone. */
export function withdraw(
  state: StateStore,
  inbox: InboxService,
  projectId: ProjectId,
  foldKeys: readonly string[],
): void {
  for (const key of foldKeys) {
    const open = findOpenByFoldKey(state.db, projectId, key);
    if (open) inbox.withdraw(open.id);
  }
}
