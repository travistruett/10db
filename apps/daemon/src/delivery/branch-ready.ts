import type { BatchDto } from '@10db/contracts';
import type { DbReader } from '@10db/db';
import type { Git } from '../git';
import { resolveStaleCards, type InboxService } from '../inbox';
import { batchCheckout } from './checkout';

/**
 * Closes the batch's open wrong-branch cards when its checkout is on the batch's branch now: a
 * `branch_ready` closer. Reads the branch itself, so a checkout still off it, or one git won't read,
 * leaves every card open. Returns whether the checkout is on the branch.
 */
export async function resolveBranchReadyCards(
  deps: {
    readonly db: DbReader;
    readonly git: Pick<Git, 'currentBranch'>;
    readonly inbox: InboxService;
  },
  batch: BatchDto,
): Promise<boolean> {
  if (batch.branch === null) return false;
  const current = await deps.git.currentBranch(batchCheckout(deps.db, batch)).catch(() => null);
  if (current !== batch.branch) return false;
  resolveStaleCards(deps.db, deps.inbox, batch.projectId, (when) =>
    when.event === 'branch_ready' && when.batchId === batch.id
      ? `The checkout is on ${batch.branch ?? 'the batch branch'} again`
      : null,
  );
  return true;
}
