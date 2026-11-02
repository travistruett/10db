import { z } from 'zod';
import { WorkstreamDto } from './entities';

/** What a workstream needs to be placed in the queue. */
export interface QueueEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly runNextAt: string | null;
}

/**
 * The order queued workstreams take free lanes: stamped ones first, the latest stamp leading, then
 * the rest in the order they were started. The builder's Run Next press stamps one workstream;
 * recovery stamps every workstream it re-queues with one shared time, so work a restart cut short
 * goes back ahead of work that never started and, under that stamp, keeps its start order.
 */
export function queueOrder(a: QueueEntry, b: QueueEntry): number {
  if (a.runNextAt !== null || b.runNextAt !== null) {
    if (a.runNextAt === null) return 1;
    if (b.runNextAt === null) return -1;
    if (a.runNextAt !== b.runNextAt) return a.runNextAt < b.runNextAt ? 1 : -1;
  }
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * `POST /tasks/:taskId/run-next`: the queued workstream, now first in line, and the titles of the
 * task's dependencies that aren't done. While any are open it runs once they finish.
 */
export const RunNextResult = z.object({
  workstream: WorkstreamDto,
  waitingOn: z.array(z.string()),
});
export type RunNextResult = z.infer<typeof RunNextResult>;
