import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    testTimeout: 30_000,
    setupFiles: ['../../tests/git-isolation.setup.ts'],
    globalSetup: ['./test/repo-template.global.ts'],
  },
});
