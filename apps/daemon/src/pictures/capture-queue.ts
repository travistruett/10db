import {
  ScreenKind,
  type BrowserState,
  type PassId,
  type PassTurnId,
  type ProjectId,
  type TaskId,
} from '@10db/contracts';

// Workbench spec docs/superpowers/specs/2026-11-09-10db-workbench-design.md §10, §12: the daemon's one
// capture queue, as a pure step. One capture loads at a time; what waits is replaced, dropped or held
// back as turns, sign-off, take-out, a close, an Abandon, the app address and the browser's download
// race it. Whether a before is still right is the before rule's (`before-rule.ts`), decided at the shot.

/** A picture to take of a task's pages: every route it names, in every viewport and theme. */
export interface CaptureRequest {
  readonly kind: ScreenKind;
  readonly projectId: ProjectId;
  /** The pass the task was in when it was asked; null for a task in Your folder outside a pass. */
  readonly passId: PassId | null;
  readonly taskId: TaskId;
  /** The turn a turn picture follows; null for a before or an after. */
  readonly turnId: PassTurnId | null;
}

export interface CaptureQueue {
  readonly waiting: readonly CaptureRequest[];
  readonly loading: CaptureRequest | null;
  /** Afters asked while their pass closes or is abandoned, queued once it no longer is. */
  readonly deferred: readonly CaptureRequest[];
  /** Passes CLOSING or ABANDONING. */
  readonly holding: readonly PassId[];
  readonly browser: BrowserState;
  /** The daemon is shutting down: nothing is asked or started again. */
  readonly closed: boolean;
}

export const CAPTURE_IDLE: CaptureQueue = {
  waiting: [],
  loading: null,
  deferred: [],
  holding: [],
  browser: 'off',
  closed: false,
};

export type CaptureEvent =
  | { readonly kind: 'ask'; readonly request: CaptureRequest }
  /** The task's next turn started, or its turn was stopped: a turn picture now may show half a turn. */
  | { readonly kind: 'turn_started'; readonly taskId: TaskId }
  | { readonly kind: 'signing_off'; readonly taskId: TaskId }
  | { readonly kind: 'taken_out'; readonly taskId: TaskId }
  /** The pass entered CLOSING or ABANDONING. */
  | { readonly kind: 'pass_holding'; readonly passId: PassId }
  /** The pass left CLOSING (closed, or open again after a failed gate), or was abandoned. */
  | { readonly kind: 'pass_released'; readonly passId: PassId }
  /** The project's app address was cleared or changed. */
  | { readonly kind: 'app_changed'; readonly projectId: ProjectId }
  | { readonly kind: 'browser'; readonly state: BrowserState }
  | { readonly kind: 'shutdown' }
  /** The driver is idle: take the next request, if one may run. */
  | { readonly kind: 'start' }
  /** The load ended, kept, dropped or aborted. */
  | { readonly kind: 'done' };

export interface CaptureStep {
  readonly queue: CaptureQueue;
  /** Abort the request that is loading: nothing of it may be written. */
  readonly abort: boolean;
  /** The request that began loading. */
  readonly started: CaptureRequest | null;
}

const isTurn = (r: CaptureRequest): boolean => r.kind === ScreenKind.Turn;
const isAfter = (r: CaptureRequest): boolean => r.kind === ScreenKind.After;
const isBefore = (r: CaptureRequest): boolean => r.kind === ScreenKind.Before;
const ofPass = (passId: PassId) => (r: CaptureRequest) => r.passId === passId;

function step(
  queue: CaptureQueue,
  abort = false,
  started: CaptureRequest | null = null,
): CaptureStep {
  return { queue, abort, started };
}

function ask(queue: CaptureQueue, request: CaptureRequest): CaptureStep {
  if (queue.closed || queue.browser === 'refused') return step(queue);
  // A download in progress holds befores back (they must be before the first edit); the rest wait for no one.
  if (queue.browser === 'fetching' && !isBefore(request)) return step(queue);
  if (request.passId !== null && queue.holding.includes(request.passId))
    return isAfter(request) && !queue.deferred.some((r) => sameAsk(r, request))
      ? step({ ...queue, deferred: [...queue.deferred, request] })
      : step(queue);
  if (isTurn(request))
    return step({
      ...queue,
      waiting: [
        ...queue.waiting.filter((r) => !(isTurn(r) && r.taskId === request.taskId)),
        request,
      ],
    });
  if (
    queue.waiting.some((r) => sameAsk(r, request)) ||
    (queue.loading !== null && sameAsk(queue.loading, request))
  )
    return step(queue);
  return step({ ...queue, waiting: [...queue.waiting, request] });
}

const sameAsk = (x: CaptureRequest, y: CaptureRequest): boolean =>
  x.kind === y.kind && x.taskId === y.taskId;

/** One event's effect on the queue: what it holds after, and whether the load in flight must stop. */
export function captureStep(queue: CaptureQueue, event: CaptureEvent): CaptureStep {
  const loading = queue.loading;
  switch (event.kind) {
    case 'ask':
      return ask(queue, event.request);
    case 'turn_started':
      return step(
        {
          ...queue,
          waiting: queue.waiting.filter((r) => !(isTurn(r) && r.taskId === event.taskId)),
        },
        loading !== null && isTurn(loading) && loading.taskId === event.taskId,
      );
    case 'signing_off':
      return step({
        ...queue,
        waiting: queue.waiting.filter((r) => !(isTurn(r) && r.taskId === event.taskId)),
      });
    case 'taken_out':
      return step(
        {
          ...queue,
          waiting: queue.waiting.filter((r) => r.taskId !== event.taskId),
          deferred: queue.deferred.filter((r) => r.taskId !== event.taskId),
        },
        loading?.taskId === event.taskId,
      );
    case 'pass_holding': {
      const mine = ofPass(event.passId);
      return step(
        {
          ...queue,
          holding: queue.holding.includes(event.passId)
            ? queue.holding
            : [...queue.holding, event.passId],
          waiting: queue.waiting.filter((r) => !mine(r)),
          deferred: [...queue.deferred, ...queue.waiting.filter((r) => mine(r) && isAfter(r))],
        },
        loading !== null && mine(loading) && !isAfter(loading),
      );
    }
    case 'pass_released': {
      const mine = ofPass(event.passId);
      const released = queue.deferred.filter(mine);
      return step({
        ...queue,
        holding: queue.holding.filter((p) => p !== event.passId),
        deferred: queue.deferred.filter((r) => !mine(r)),
        waiting: queue.closed ? queue.waiting : [...queue.waiting, ...released],
      });
    }
    case 'app_changed':
      return step(
        {
          ...queue,
          waiting: queue.waiting.filter((r) => r.projectId !== event.projectId),
          deferred: queue.deferred.filter((r) => r.projectId !== event.projectId),
        },
        loading?.projectId === event.projectId,
      );
    case 'browser':
      return step({
        ...queue,
        browser: event.state,
        waiting:
          event.state === 'refused'
            ? []
            : event.state === 'fetching'
              ? queue.waiting.filter(isBefore)
              : queue.waiting,
        deferred: event.state === 'refused' ? [] : queue.deferred,
      });
    case 'shutdown':
      return step({ ...queue, closed: true, waiting: [], deferred: [] }, loading !== null);
    case 'start': {
      const next = queue.waiting[0];
      if (
        queue.closed ||
        loading !== null ||
        next === undefined ||
        queue.browser === 'fetching' ||
        queue.browser === 'refused'
      )
        return step(queue);
      return step({ ...queue, loading: next, waiting: queue.waiting.slice(1) }, false, next);
    }
    case 'done':
      return step({ ...queue, loading: null });
  }
}
