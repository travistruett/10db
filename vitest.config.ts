import { defineConfig } from 'vitest/config';

// Each workspace package with tests is listed here.
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
