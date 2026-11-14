import { getStakeholderTimers, markReturned, openSends } from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { dueTimers } from './timers';

/** How often the timers are looked at; a Mac that slept is caught up by the first tick after it wakes. */
export const TIMER_INTERVAL_MS = 60_000;

export interface TimerWatchDeps {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly log: Logger;
  readonly intervalMs?: number;
}

export interface TimerWatch {
  start(): void;
  /** Stops scheduling and waits for the tick in flight. */
  stop(): Promise<void>;
  tick(): Promise<void>;
}

/**
 * Returns a send to the builder when the wall clock says its answer is overdue. It never calls Slack, so a
 * disconnected Slack never keeps a card from coming back; the reminder, which needs Slack, is the reply
 * watch's. Due-ness is worked out again inside the write that returns the send, so ticks that overlap
 * return it once.
 */
export function createTimerWatch(deps: TimerWatchDeps): TimerWatch {
  const interval = deps.intervalMs ?? TIMER_INTERVAL_MS;
  let timer: Timer | null = null;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();

  function tick(): Promise<void> {
    const run = (): void => {
      const now = deps.clock.now();
      const timers = getStakeholderTimers(deps.state.db);
      for (const open of openSends(deps.state.db)) {
        if (dueTimers(open, timers, now) !== 'return') continue;
        deps.state.write((ctx) => {
          const fresh = openSends(ctx.tx).find((s) => s.id === open.id);
          if (fresh && dueTimers(fresh, getStakeholderTimers(ctx.tx), now) === 'return')
            markReturned(ctx, open.id, 'timer');
        });
      }
    };
    return Promise.resolve().then(() => {
      try {
        run();
      } catch (error) {
        deps.log.warn({ err: error }, 'the stakeholder timers could not be checked');
      }
    });
  }

  function schedule(): void {
    if (!running) return;
    timer = deps.clock.setTimeout(() => {
      inFlight = tick().finally(schedule);
    }, interval);
  }

  return {
    tick,
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    async stop() {
      running = false;
      timer?.cancel();
      timer = null;
      await inFlight;
    },
  };
}
