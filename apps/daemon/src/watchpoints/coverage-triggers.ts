import {
  effectiveWatchpoints,
  EventType,
  ProjectId,
  WorkstreamId,
  type Watchpoint,
} from '@10db/contracts';
import { getProject, readProjectWatchpoints, readYourWatchpoints, type DbReader } from '@10db/db';
import type { EventBus, StateStore } from '../events';
import { coverageSubjects, type WatchpointCoverageReader } from './coverage';

/** The entity type of the event that says a count landed, which the desktop follows. */
export const COVERAGE_ENTITY = 'watchpoint_coverage';

/**
 * What a background count covers for a project: the watchpoints that apply there and the builder's own, each with
 * the starters, so the project page and All Projects both find their counts ready. Null when the project is gone.
 */
export function backgroundSubjects(
  db: DbReader,
  projectId: ProjectId,
): { project: { id: ProjectId; repoPath: string }; watchpoints: Watchpoint[] } | null {
  try {
    const project = getProject(db, projectId);
    const yours = readYourWatchpoints(db);
    const here = effectiveWatchpoints(yours, readProjectWatchpoints(db, projectId));
    return {
      project,
      watchpoints: [...coverageSubjects(here, yours), ...coverageSubjects(yours)],
    };
  } catch {
    return null;
  }
}

/** Says, through the event log, that a count landed in the project. */
export function announceCoverage(state: Pick<StateStore, 'write'>, projectId: ProjectId): void {
  state.write((ctx) => {
    ctx.emit({
      type: EventType.WatchpointCoverageLanded,
      entityType: COVERAGE_ENTITY,
      entityId: projectId,
      data: {},
    });
  });
}

/**
 * Counts a project's watchpoints again, in the background, when it is added and when a commit is recorded, so a page
 * finds them kept. Returns the way to stop listening.
 */
export function subscribeWatchpointCoverage(
  bus: EventBus,
  projects: { projectOfWorkstream(id: WorkstreamId): ProjectId | null },
  coverage: Pick<WatchpointCoverageReader, 'schedule'>,
): () => void {
  return bus.subscribe((event) => {
    if (event.type === EventType.ProjectCreated) {
      const projectId = ProjectId.safeParse(event.entityId);
      if (projectId.success) coverage.schedule(projectId.data);
    } else if (event.type === EventType.CommitRecorded) {
      const workstreamId = WorkstreamId.safeParse(event.entityId);
      if (!workstreamId.success) return;
      const projectId = projects.projectOfWorkstream(workstreamId.data);
      if (projectId !== null) coverage.schedule(projectId);
    }
  });
}
