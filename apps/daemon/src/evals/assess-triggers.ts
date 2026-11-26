import { EventType, type ProjectId, type WorkstreamId } from '@10db/contracts';
import type { EventBus } from '../events';
import type { EvalsAssessor } from './assess';
import { findEvalMarkers } from './markers';

/** Eval skills the agents read, and anything under an `evals` or `eval` folder that isn't a recorded result. */
const WATCHED = /^\.(?:claude|agents)\/skills\/[^/]+\/SKILL\.md$|(?:^|\/)evals?\/(?!reports\/)/u;

/** Whether any committed path is an eval definition, an eval skill or a file inside an evals folder. */
export function changesEvalFiles(paths: readonly string[]): boolean {
  return findEvalMarkers(paths).definitions.length > 0 || paths.some((path) => WATCHED.test(path));
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
      assessor.schedule(event.entityId as ProjectId);
    } else if (event.type === EventType.CommitRecorded) {
      const paths = event.data['paths'];
      if (!Array.isArray(paths)) return;
      if (!changesEvalFiles(paths.filter((p): p is string => typeof p === 'string'))) return;
      const projectId = projects.projectOfWorkstream(event.entityId as WorkstreamId);
      if (projectId !== null) assessor.schedule(projectId);
    }
  });
}
