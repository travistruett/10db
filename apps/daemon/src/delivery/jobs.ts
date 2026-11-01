import type { BatchDto } from '@10db/contracts';
import type { Logger } from '../log';

/** Which of a project's job queues a job runs in. */
export const JobQueue = { Cut: 'cut', Ship: 'ship' } as const;
export type JobQueue = (typeof JobQueue)[keyof typeof JobQueue];

/**
 * A separate copy's cuts and joins run in one queue and its ships and cleanup in another, so they
 * never wait behind the shared batch's queue or a shipping gate. A batch in Your folder keeps the
 * project's single queue: its cut switches the checkout a ship reads. The queue follows the batch
 * (whether it has a worktree), never the project's default placement, which can change while
 * batches are unfinished.
 */
export function jobKey(
  batch: Pick<BatchDto, 'projectId' | 'worktreePath'>,
  queue: JobQueue,
): string {
  return batch.worktreePath === null ? batch.projectId : `${batch.projectId}:${queue}`;
}

/** Background delivery work. Jobs with the same key (a project's queue) run one at a time, in order. */
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
