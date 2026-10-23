import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'harness',
    environment: 'node',
    setupFiles: ['../../tests/git-isolation.setup.ts'],
  },
});
