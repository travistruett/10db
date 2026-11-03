import { InvalidError, KnowledgeScope, type KnowledgeTarget } from '@10db/contracts';
import { getProject, type DbReader } from '@10db/db';

/** A target's project must exist, and an area target must name one of its areas. */
export function checkTarget(db: DbReader, target: KnowledgeTarget): void {
  if (target.scope === KnowledgeScope.You) return;
  const project = getProject(db, target.projectId);
  if (target.scope === KnowledgeScope.Area && !project.areas.some((a) => a.name === target.area))
    throw new InvalidError(`${project.name} has no area named ${target.area}`);
}
