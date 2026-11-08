import type { HazardAssessmentDto, ProjectId } from '@10db/contracts';
import { heldHazardAdditions, readHazardAssessment, type DbReader } from '@10db/db';
import { pendingHazardRemovals } from '../inbox';

/**
 * What Settings shows for a project: what 10db added and why that the hazards still hold (one the
 * builder took out by hand is not listed), and how many removals wait on a yes.
 */
export function hazardAssessmentDto(db: DbReader, projectId: ProjectId): HazardAssessmentDto {
  const state = readHazardAssessment(db, projectId);
  return {
    additions: heldHazardAdditions(db, projectId),
    assessedAt: state.assessedAt,
    commit: state.commit,
    pendingRemovals: pendingHazardRemovals(db, projectId).length,
  };
}
