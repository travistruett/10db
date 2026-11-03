import type { Hold } from '../verify';

/**
 * The drain of a waiting update: from the moment it begins, nothing new starts (a lane's next
 * session, a gate, a queued lane, a ship) until it ends, and nothing that runs is stopped. Work that
 * waits here is parked: it has not started, so it no longer counts as mid-session.
 */
export interface Drain extends Hold {
  readonly draining: boolean;
  /** When the drain began; null while it is not draining. */
  readonly since: Date | null;
  /** How many callers wait in `untilClear` now. */
  parked(): number;
  /** Starts holding new work. A drain that already holds keeps its first start. */
  begin(since: Date): void;
  /** Lets every parked waiter go on and stops holding. */
  end(): void;
  /** Shutdown: lets every waiter go, so nothing is left waiting for a daemon that is ending. */
  stop(): void;
}

interface Waiter {
  readonly release: (value: boolean) => void;
}

export function createDrain(): Drain {
  let since: Date | null = null;
  const waiting = new Set<Waiter>();

  function releaseAll(): void {
    for (const waiter of [...waiting]) {
      waiting.delete(waiter);
      waiter.release(true);
    }
  }

  return {
    get draining() {
      return since !== null;
    },
    get since() {
      return since;
    },
    parked: () => waiting.size,
    begin(at) {
      since ??= at;
    },
    end() {
      since = null;
      releaseAll();
    },
    stop() {
      since = null;
      releaseAll();
    },
    untilClear(signal) {
      if (since === null) return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        const onAbort = (): void => {
          waiting.delete(waiter);
          resolve(false);
        };
        const waiter: Waiter = {
          release: (value) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
        };
        waiting.add(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** A hold, and whether it holds now: `untilClear` alone cannot say whether it would wait. */
export interface Holding {
  holding(): boolean;
  readonly hold: Hold;
}

/**
 * Waits for each hold in turn, and again from the first when one began holding while another was
 * waited for, so work starts only at a moment when none of them holds.
 */
export function holdBoth(holds: readonly Holding[]): Hold {
  return {
    async untilClear(signal) {
      for (;;) {
        for (const { hold } of holds) {
          if (!(await hold.untilClear(signal))) return false;
        }
        if (!holds.some((h) => h.holding())) return true;
      }
    },
  };
}
