import { defineProject } from 'vitest/config';
import { localWorkerCap } from '../../../tests/max-workers';

// Unit tests for the E2E harness itself; they run in node, apart from the jsdom UI tests.
export default defineProject({
  test: {
    ...localWorkerCap,
    name: 'desktop-e2e',
    // Vitest roots a project at its config's directory; knip roots it at the workspace unless told.
    root: import.meta.dirname,
    environment: 'node',
    setupFiles: ['../../../tests/git-isolation.setup.ts'],
    include: ['*.test.ts'],
  },
});
