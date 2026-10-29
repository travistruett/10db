import { batchBranchStem, slugOf, type BatchId } from '@10db/contracts';

const ID_SUFFIX = 8;

export { slugOf };

/** `10db/<slug>-<last 8 hex of the batch id>` (batch delivery spec §5). */
export function batchBranchName(title: string, id: BatchId): string {
  return `${batchBranchStem(title)}-${id.slice(-ID_SUFFIX)}`;
}
