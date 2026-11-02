import { latestPerTask, WorkstreamState, type BatchDto, type WorkstreamDto } from '@10db/contracts';

/**
 * The tasks in a batch: each one's latest run, without the cancelled. More than one means several
 * tasks share the branch, which a card says with its shared-branch indicator.
 */
export function batchTaskCount(batch: BatchDto, workstreams: readonly WorkstreamDto[]): number {
  return latestPerTask(workstreams.filter((w) => w.batchId === batch.id)).filter(
    (w) => w.state !== WorkstreamState.Cancelled,
  ).length;
}
