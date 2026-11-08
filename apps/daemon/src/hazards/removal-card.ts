import type { HazardRemoval, InboxItemDto, ProjectDto } from '@10db/contracts';
import { findOpenByFoldKey, type WriteContext } from '@10db/db';
import { flagCard, hazardCardFoldKey, hazardRemovalCard, withdrawCard } from '../inbox';

/**
 * Makes the project's one Inbox card say exactly these changes, in the caller's transaction: it is
 * raised or, when it is open, replaced. With nothing to remove an open card is withdrawn, since what
 * it asked is moot. Applies nothing: only the builder's answer takes an entry out.
 */
export function setHazardRemovalCard(
  ctx: WriteContext,
  project: Pick<ProjectDto, 'id' | 'name'>,
  removals: readonly HazardRemoval[],
): InboxItemDto | null {
  if (removals.length > 0) return flagCard(ctx, hazardRemovalCard(project, removals));
  const open = findOpenByFoldKey(ctx.tx, project.id, hazardCardFoldKey(project.id));
  if (open) withdrawCard(ctx, open.id);
  return null;
}
