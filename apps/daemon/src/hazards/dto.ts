import type { HazardAssessmentDto, ProjectId } from '@10db/contracts';
import { readHazardAssessment, type DbReader } from '@10db/db';
import { pendingHazardRemovals } from '../inbox';

/** What Settings shows for a project: what 10db added and why, and how many removals wait on a yes. */
export function hazardAssessmentDto(db: DbReader, projectId: ProjectId): HazardAssessmentDto {
  const state = readHazardAssessment(db, projectId);
  return {
    additions: state.additions,
    assessedAt: state.assessedAt,
    commit: state.commit,
    pendingRemovals: pendingHazardRemovals(db, projectId).length,
  };
}
