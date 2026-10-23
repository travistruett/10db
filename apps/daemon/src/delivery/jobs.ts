import type { Logger } from '../log';

/** Background delivery work. Jobs with the same key (a project) run one at a time, in order. */
export interface DeliveryJobs {
  run(key: string, job: (signal: AbortSignal) => Promise<void>): void;
  /** Settles once no job is queued or running. */
  idle(): Promise<void>;
  /** Aborts the running jobs' signal, waits for every job to settle and takes no new ones. */
  stop(): Promise<void>;
}

export function createDeliveryJobs(logger: Logger): DeliveryJobs {
  const controller = new AbortController();
  const tails = new Map<string, Promise<void>>();
  const pending = new Set<Promise<void>>();

  async function idle(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  return {
    run(key, job) {
      if (controller.signal.aborted) return;
      const previous = tails.get(key) ?? Promise.resolve();
      const next = previous
        // A job queued before stop() still runs, with its signal aborted, so it can say it stopped.
        .then(() => job(controller.signal))
        .catch((error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error), key },
            'delivery job failed',
          );
        });
      tails.set(key, next);
      pending.add(next);
      void next.then(() => {
        pending.delete(next);
        if (tails.get(key) === next) tails.delete(key);
      });
    },
    idle,
    async stop() {
      controller.abort();
      await idle();
    },
  };
}
