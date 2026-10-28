import type { TestProject } from 'vitest/node';
import { buildRepoTemplate } from './fixtures';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The repository `createTempRepo` copies. */
    repoTemplate: string;
  }
}

/** Builds the template repository once for the run and removes it when the run ends. */
export default function setup(project: TestProject): () => void {
  const template = buildRepoTemplate();
  project.provide('repoTemplate', template.path);
  return () => {
    template.cleanup();
  };
}
