import { ACTIVE_STATES, type ProjectId } from '@10db/contracts';
import { listActiveProjects, listWorkstreams, type DbReader } from '@10db/db';

/**
 * Where a card about the whole Mac sits: the project with the oldest work in flight, or the first
 * project. Null with no project, when there is nowhere to put it.
 */
export function projectForMachineCard(db: DbReader): ProjectId | null {
  const oldest = listWorkstreams(db, { states: ACTIVE_STATES })[0];
  return oldest?.projectId ?? listActiveProjects(db)[0]?.id ?? null;
}
