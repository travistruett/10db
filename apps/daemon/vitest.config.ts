import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    testTimeout: 30_000,
    // Hooks build temp git repos too; under the full gate's load they can pass the 10 s default.
    hookTimeout: 30_000,
    setupFiles: ['../../tests/git-isolation.setup.ts'],
    globalSetup: ['./test/repo-template.global.ts'],
  },
});
