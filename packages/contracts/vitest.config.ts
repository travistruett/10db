import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'contracts',
    environment: 'node',
    setupFiles: ['../../tests/git-isolation.setup.ts'],
  },
});
