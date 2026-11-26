import {
  BRANCH_PREFIX,
  batchBranchStem,
  slugOf,
  type BatchId,
  type WorkstreamId,
} from '@10db/contracts';

const ID_SUFFIX = 8;

export { slugOf };

/** `10db/<slug>-<last 8 hex of the batch id>` (batch delivery spec §5). */
export function batchBranchName(title: string, id: BatchId): string {
  return `${batchBranchStem(title)}-${id.slice(-ID_SUFFIX)}`;
}

/** Where a Commit Directly lane's own branches live; no batch names them. */
export const LANE_BRANCH_PREFIX = `${BRANCH_PREFIX}lane/`;

/**
 * `10db/lane/<last 8 hex of the workstream id>`: the branch a Your-folder run commits on. Named by the
 * run alone, since a task's title can change while its commits keep chaining on the branch.
 */
export function laneBranchName(id: WorkstreamId): string {
  return `${LANE_BRANCH_PREFIX}${id.slice(-ID_SUFFIX)}`;
}
