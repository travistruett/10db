import type { Clock } from '../clock';
import type { Logger } from '../log';
import type { GateRequest, GateResult, GateRunner } from './gate-runner';

/** The exit code of a gate stopped by its abort signal, as the gate runner reports it. */
const ABORT_EXIT = 130;

export interface GateSlot {
  /** Frees the slot; a second call does nothing. */
  release(): void;
}

/** A fixed number of gate slots for the whole daemon, in memory. */
export interface GateSlots {
  /** Gates holding a slot. */
  readonly busy: number;
  /** Gates waiting for one. */
  readonly waiting: number;
  /** Stops granting slots: every waiter, and every later caller, gets null. For shutdown. */
  close(): void;
  /**
   * Resolves with a slot, in the order callers asked. `onWait` is called at once, with the number of
   * gates ahead, only when the caller has to wait. Resolves null when `signal` aborts first.
   */
  acquire(signal?: AbortSignal, onWait?: (ahead: number) => void): Promise<GateSlot | null>;
}

interface Waiter {
  readonly grant: (slot: GateSlot) => void;
  readonly refuse: () => void;
}

/** A limit that could never grant a slot, so every gate would wait forever. */
export class GateSlotLimitError extends Error {
  override readonly name = 'GateSlotLimitError';
  constructor(limit: number) {
    super(`gate slots must be a whole number of at least 1, got ${String(limit)}`);
  }
}

export function createGateSlots(limit: number): GateSlots {
  if (!Number.isInteger(limit) || limit < 1) throw new GateSlotLimitError(limit);
  let busy = 0;
  let closed = false;
  const queue: Waiter[] = [];

  function take(): GateSlot {
    busy++;
    let held = true;
    return {
      release() {
        if (!held) return;
        held = false;
        busy--;
        const next = queue.shift();
        if (next) next.grant(take());
      },
    };
  }

  return {
    get busy() {
      return busy;
    },
    get waiting() {
      return queue.length;
    },
    close() {
      closed = true;
      for (const waiter of queue.splice(0)) waiter.refuse();
    },
    acquire(signal, onWait) {
      if (closed || signal?.aborted) return Promise.resolve(null);
      if (busy < limit) return Promise.resolve(take());
      onWait?.(busy + queue.length);
      return new Promise<GateSlot | null>((resolve) => {
        const waiter: Waiter = {
          grant(slot) {
            signal?.removeEventListener('abort', onAbort);
            resolve(slot);
          },
          refuse() {
            signal?.removeEventListener('abort', onAbort);
            resolve(null);
          },
        };
        const onAbort = (): void => {
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          resolve(null);
        };
        queue.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

/** Holds work back while the Mac is overloaded; the load guard is one. */
export interface Hold {
  /** Resolves true once work may start, and false when `signal` aborts first. */
  untilClear(signal?: AbortSignal): Promise<boolean>;
}

export interface LimitGatesOptions {
  readonly slots: GateSlots;
  readonly clock: Clock;
  readonly logger: Logger;
  /** A gate starts nothing, and holds no slot, until this lets it. */
  readonly hold?: Hold;
}

/**
 * Makes every gate the runner starts wait for a slot first. Wrapping one runner for every caller is
 * what makes the limit machine-wide. The runner times a gate from the moment it is called, which is
 * after the slot is held, so the wait never counts against the gate's timeout.
 */
export function limitGates(runner: GateRunner, options: LimitGatesOptions): GateRunner {
  return {
    async run(request: GateRequest): Promise<GateResult> {
      const asked = options.clock.now().getTime();
      // Before the slot, so a gate held for load never keeps one from a gate that could run.
      const released = (await options.hold?.untilClear(request.signal)) ?? true;
      const slot = released
        ? await options.slots.acquire(request.signal, (ahead) => {
            request.onWaiting?.(ahead);
          })
        : null;
      if (slot === null) {
        options.logger.info({ logPath: request.logPath }, 'gate stopped while waiting for a slot');
        return {
          exitCode: ABORT_EXIT,
          durationMs: 0,
          tail: '',
          logPath: request.logPath,
          timedOut: false,
          aborted: true,
        };
      }
      try {
        const waitedMs = options.clock.now().getTime() - asked;
        if (waitedMs > 0)
          options.logger.info({ logPath: request.logPath, waitedMs }, 'gate got a slot');
        return await runner.run(request);
      } finally {
        slot.release();
      }
    },
  };
}
