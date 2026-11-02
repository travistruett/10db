import type { TestProject } from 'vitest/node';
import { buildRemoteTemplate, buildRepoTemplate } from './fixtures';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The repository `createTempRepo` copies. */
    repoTemplate: string;
    /** The repository and its bare origin `createTempRepoWithOrigin` copies. */
    remoteTemplate: { repo: string; origin: string };
  }
}

/** Builds the template repositories once for the run and removes them when the run ends. */
export default function setup(project: TestProject): () => void {
  const template = buildRepoTemplate();
  const remote = buildRemoteTemplate();
  project.provide('repoTemplate', template.path);
  project.provide('remoteTemplate', { repo: remote.repo.path, origin: remote.origin.path });
  return () => {
    template.cleanup();
    remote.cleanup();
  };
}
