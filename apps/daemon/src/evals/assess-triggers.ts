import { EventType, type ProjectId, type WorkstreamId } from '@10db/contracts';
import type { EventBus } from '../events';
import type { EvalsAssessor } from './assess';
import { findEvalMarkers } from './markers';

/** An eval skill the agents read: a project skill whose folder is named for evals. */
const EVAL_SKILL = /^\.(?:claude|agents)\/skills\/[^/]*eval[^/]*\/SKILL\.md$/iu;

/** Whether any committed path is an eval definition, a `claude plugin eval` case or an eval skill. */
export function changesEvalFiles(paths: readonly string[]): boolean {
  const markers = findEvalMarkers(paths);
  return (
    markers.definitions.length > 0 ||
    markers.promptCases.size > 0 ||
    paths.some((path) => EVAL_SKILL.test(path))
  );
}

/**
 * Assesses a project's evals, in the background, when it is added and when a commit changes an eval file or an
 * eval skill. A commit's changes to model-calling code alone don't start one: that would cost a model call
 * per code commit; Assess now covers it. Returns the way to stop listening.
 */
export function subscribeEvalAssessment(
  bus: EventBus,
  projects: { projectOfWorkstream(id: WorkstreamId): ProjectId | null },
  assessor: Pick<EvalsAssessor, 'schedule'>,
): () => void {
  return bus.subscribe((event) => {
    if (event.type === EventType.ProjectCreated) {
      // A project event's entity is the project, as the hazard assessment's subscription reads it.
      assessor.schedule(event.entityId as ProjectId);
    } else if (event.type === EventType.CommitRecorded) {
      const paths = event.data['paths'];
      if (!Array.isArray(paths)) return;
      if (!changesEvalFiles(paths.filter((p): p is string => typeof p === 'string'))) return;
      // A commit event's entity is its workstream.
      const projectId = projects.projectOfWorkstream(event.entityId as WorkstreamId);
      if (projectId !== null) assessor.schedule(projectId);
    }
  });
}
