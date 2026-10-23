import type { ProjectId } from '@10db/contracts';
import type { StateStore } from '../events';
import type { Git, NetworkCall } from '../git';
import type { Gh, GhCall } from '../github';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import type { Card } from './cards';
import type { DeliveryJobs } from './jobs';

export interface DeliveryLimits {
  /** Each fetch and gh call. */
  readonly networkTimeoutMs: number;
  /**
   * The push, which runs the clone's pre-push hook: a hook may run a whole check suite, so it gets
   * the gate's time, not a network call's. The daemon passes the runner's gate timeout.
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

export function ghCall(ctx: DeliveryContext, repoPath: string, signal: AbortSignal): GhCall {
  return { cwd: repoPath, ...networkCall(ctx, signal) };
}

/** Delivery cards belong to the project, not to one workstream. */
export function raise(inbox: InboxService, projectId: ProjectId, card: Card): void {
  inbox.flag({
    projectId,
    workstreamId: null,
    title: card.title,
    body: card.body,
    ...(card.foldKey ? { foldKey: card.foldKey } : {}),
    ...(card.detail ? { detail: card.detail } : {}),
  });
}
