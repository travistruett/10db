import { defineProject } from 'vitest/config';

// Unit tests for the desktop app's build and dev scripts; they run in node, apart from the jsdom UI tests.
export default defineProject({
  test: {
    name: 'desktop-scripts',
    // Vitest roots a project at its config's directory; knip roots it at the workspace unless told.
    root: import.meta.dirname,
    environment: 'node',
    setupFiles: ['../../../tests/git-isolation.setup.ts'],
    include: ['*.test.ts'],
  },
});
