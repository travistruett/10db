import { defineProject } from 'vitest/config';
import { localWorkerCap } from '../../tests/max-workers';

export default defineProject({
  test: {
    ...localWorkerCap,
    name: 'contracts',
    environment: 'node',
    setupFiles: ['../../tests/git-isolation.setup.ts'],
  },
});
