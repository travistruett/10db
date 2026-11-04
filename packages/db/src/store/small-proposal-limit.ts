import {
  DEFAULT_SMALL_PROPOSAL_LIMIT,
  MAX_SMALL_PROPOSAL_LIMIT,
  type ProjectId,
} from '@10db/contracts';
import { getAppSetting, setAppSetting } from './settings';
import type { DbReader, WriteContext } from './store';

const key = (projectId: ProjectId): string => `proposals.smallLimit.${projectId}`;

/**
 * The size, in characters of title and body, up to which a lane's new-task proposal with no risk tag
 * is filed to the Icebox without a card. The default until the builder sets one; zero is a real value
 * and sends every proposal to the Inbox.
 */
export function getSmallProposalLimit(db: DbReader, projectId: ProjectId): number {
  const value = getAppSetting(db, key(projectId));
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_SMALL_PROPOSAL_LIMIT
    ? value
    : DEFAULT_SMALL_PROPOSAL_LIMIT;
}

export function setSmallProposalLimit(
  ctx: WriteContext,
  projectId: ProjectId,
  limit: number,
): void {
  setAppSetting(ctx, key(projectId), limit);
}
