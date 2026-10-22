import { defineConfig } from 'vitest/config';

// Each workspace package with tests is listed here. Every project's own config runs
// tests/git-isolation.setup.ts first; tests/repo checks that none is missing it.
export default defineConfig({
  test: {
    projects: [
      'tests/repo',
      'packages/contracts',
      'packages/db',
      'packages/harness',
      'apps/daemon',
      'apps/desktop',
    ],
  },
});
