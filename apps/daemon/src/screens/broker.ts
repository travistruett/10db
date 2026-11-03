import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ProjectId,
  ScreenImageInput,
  ScreenName,
  ScreenRenderRequest,
  ShapeId,
  TaskId,
} from '@10db/contracts';

// Shape spec §5.5. The daemon cannot draw a screen: only the app's window can. The broker is the
// rendezvous. A session's `see_screen` call becomes a request; the window asks for work by long-
// polling `POST /screens/claim`, draws the screen in a hidden frame, and answers with the picture or
// a reason it could not. Nothing here is stored: a request lives in memory until it is answered, so
// asking for a screen writes no row.

export interface ScreenSpec {
  readonly shapeId: ShapeId;
  readonly projectId: ProjectId;
  readonly screen: ScreenName;
  readonly taskId?: TaskId;
  readonly width: number;
  readonly height: number;
}

export type ScreenOutcome =
  | { readonly ok: true; readonly image: ScreenImageInput }
  | { readonly ok: false; readonly reason: string };

export interface ScreenBrokerOptions {
  /** How long a window's ask waits for work before answering empty and asking again. */
  readonly claimWaitMs?: number;
  /** How long a request waits for its picture, from the moment it is made. */
  readonly renderTimeoutMs?: number;
  /** How recently a window must have asked for work for a request to be worth making. */
  readonly rendererFreshMs?: number;
}

export interface ScreenBroker {
  /** Asks the window to draw `spec` and answers with its picture, or why there is none. */
  request(spec: ScreenSpec): Promise<ScreenOutcome>;
  /** The window's ask: the next request, or null once the wait ends or `signal` aborts. */
  claim(signal?: AbortSignal): Promise<ScreenRenderRequest | null>;
  /** The window's picture for a request; false for one already answered or never made. */
  deliver(id: string, image: ScreenImageInput): boolean;
  /** The window's reason it could not draw a request; false for one already answered. */
  refuse(id: string, reason: string): boolean;
  /** Whether `token` belongs to a request that is still open. */
  tokenValid(token: string): boolean;
}

interface Open {
  readonly request: ScreenRenderRequest;
  readonly settle: (outcome: ScreenOutcome) => void;
  claimed: boolean;
}

interface Waiter {
  readonly resolve: (request: ScreenRenderRequest | null) => void;
}

const second = (ms: number): string => String(Math.round(ms / 100) / 10).replace(/\.0$/, '');

export function createScreenBroker(options: ScreenBrokerOptions = {}): ScreenBroker {
  const claimWaitMs = options.claimWaitMs ?? 25_000;
  const renderTimeoutMs = options.renderTimeoutMs ?? 20_000;
  const rendererFreshMs = options.rendererFreshMs ?? 40_000;

  const open = new Map<string, Open>();
  const waiters: Waiter[] = [];
  let lastAsk = Number.NEGATIVE_INFINITY;

  const unclaimed = (): Open | undefined => [...open.values()].find((o) => !o.claimed);

  const hand = (): void => {
    for (;;) {
      const next = unclaimed();
      const waiter = waiters.shift();
      if (next === undefined || waiter === undefined) {
        if (waiter !== undefined) waiters.unshift(waiter);
        return;
      }
      next.claimed = true;
      waiter.resolve(next.request);
    }
  };

  return {
    request(spec) {
      if (waiters.length === 0 && Date.now() - lastAsk > rendererFreshMs)
        return Promise.resolve({
          ok: false,
          reason:
            "10db's window isn't open, so there is nothing to draw the screen in. Ask the builder to open 10db and try again.",
        });
      const id = randomUUID();
      const request: ScreenRenderRequest = {
        id,
        screen: spec.screen,
        projectId: spec.projectId,
        ...(spec.taskId === undefined ? {} : { taskId: spec.taskId }),
        shapeId: spec.shapeId,
        width: spec.width,
        height: spec.height,
        token: randomBytes(24).toString('base64url'),
      };
      return new Promise<ScreenOutcome>((resolve) => {
        const timer = setTimeout(() => {
          settle({
            ok: false,
            reason: `10db's window didn't answer in ${second(renderTimeoutMs)} s, so the screen was not drawn. Try again.`,
          });
        }, renderTimeoutMs);
        const settle = (outcome: ScreenOutcome): void => {
          clearTimeout(timer);
          open.delete(id);
          resolve(outcome);
        };
        open.set(id, { request, settle, claimed: false });
        hand();
      });
    },

    claim(signal) {
      lastAsk = Date.now();
      return new Promise<ScreenRenderRequest | null>((resolve) => {
        if (signal?.aborted === true) {
          resolve(null);
          return;
        }
        const waiter: Waiter = {
          resolve: (request) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            lastAsk = Date.now();
            resolve(request);
          },
        };
        const leave = (): void => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          waiter.resolve(null);
        };
        const timer = setTimeout(leave, claimWaitMs);
        const onAbort = (): void => {
          leave();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
        hand();
      });
    },

    deliver(id, image) {
      const entry = open.get(id);
      if (entry === undefined) return false;
      entry.settle({ ok: true, image });
      return true;
    },

    refuse(id, reason) {
      const entry = open.get(id);
      if (entry === undefined) return false;
      entry.settle({ ok: false, reason });
      return true;
    },

    tokenValid(token) {
      return [...open.values()].some((o) => o.request.token === token);
    },
  };
}
