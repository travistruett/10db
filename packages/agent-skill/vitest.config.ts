import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'agent-skill',
    environment: 'node',
    setupFiles: ['../../tests/git-isolation.setup.ts'],
  },
});
