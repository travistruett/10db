import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'repo',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['../git-isolation.setup.ts'],
    // These tests spawn real shell scripts and git; under the full gate's load one can pass
    // vitest's 5s default (install-app.sh's first test took 5.1s). The daemon uses the same cap.
    testTimeout: 30_000,
  },
});
