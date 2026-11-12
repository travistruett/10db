import { latestPerTask, WorkstreamState, type BatchDto, type WorkstreamDto } from '@10db/contracts';

/**
 * The tasks in a batch: each one's latest run, without the cancelled. More than one means several
 * tasks share the branch, which a card says with its shared-branch indicator. A Workbench pass's
 * pages count as one: they share the pass's branch, which their cards say instead.
 */
export function batchTaskCount(batch: BatchDto, workstreams: readonly WorkstreamDto[]): number {
  if (batch.passId != null) return 1;
  return latestPerTask(workstreams.filter((w) => w.batchId === batch.id)).filter(
    (w) => w.state !== WorkstreamState.Cancelled,
  ).length;
}
