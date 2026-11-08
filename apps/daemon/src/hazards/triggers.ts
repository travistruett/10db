import { EventType, type ProjectId, type WorkstreamId } from '@10db/contracts';
import type { EventBus } from '../events';
import type { HazardAssessor } from './assess';

/**
 * The files a hazard is read from: manifests and lockfiles of the usual stacks, makefiles and task
 * runners, compose files, and the agents' instructions. A commit that changes one may have changed
 * what the project uses to change its lockfiles and migrations.
 */
const WATCHED =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.(?:toml|lock)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|requirements[\w.-]*\.txt|go\.(?:mod|sum)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|justfile|Taskfile\.ya?ml|GNUmakefile|[Mm]akefile|[\w.-]+\.mk|AGENTS\.md|CLAUDE\.md|(?:docker-)?compose[\w.-]*\.ya?ml)$/u;

/** Whether any of the committed paths is a file hazards are read from. */
export function changesWhatHazardsReadFrom(paths: readonly string[]): boolean {
  return paths.some((path) => WATCHED.test(path));
}

/**
 * Reads a project's hazards again, in the background, when it is added and when a commit changes a
 * manifest, lockfile, makefile, compose file or AGENTS.md. Returns the way to stop listening.
 */
export function subscribeHazardAssessment(
  bus: EventBus,
  projects: { projectOfWorkstream(id: WorkstreamId): ProjectId | null },
  assessor: Pick<HazardAssessor, 'schedule'>,
): () => void {
  return bus.subscribe((event) => {
    if (event.type === EventType.ProjectCreated) {
      assessor.schedule(event.entityId as ProjectId);
    } else if (event.type === EventType.CommitRecorded) {
      const paths = event.data['paths'];
      if (!Array.isArray(paths)) return;
      if (!changesWhatHazardsReadFrom(paths.filter((p): p is string => typeof p === 'string')))
        return;
      const projectId = projects.projectOfWorkstream(event.entityId as WorkstreamId);
      if (projectId !== null) assessor.schedule(projectId);
    }
  });
}
