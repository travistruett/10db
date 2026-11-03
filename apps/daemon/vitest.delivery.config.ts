import { defineProject } from 'vitest/config';

// The delivery tests each build real git repositories and drive worktrees, pushes and gates: 7 to
// 10 s alone, 3 to 8 times that under the full gate with other lanes running, where seven passed the
// 30 s limit in one run. They run apart from the rest of the daemon's tests so that they can be
// capped: at most four files at a time, and only after every other project has finished, so they
// don't compete with the suites that start together. `tests/repo/src/daemon-test-projects.test.ts`
// checks that the two daemon projects between them run each file once.
export default defineProject({
  test: {
    name: 'daemon-delivery',
    environment: 'node',
    include: ['src/delivery/**/*.test.ts'],
    maxWorkers: 4,
    sequence: { groupOrder: 1 },
    // The margin for a loaded machine, which the cap above only narrows.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['../../tests/git-isolation.setup.ts'],
    globalSetup: ['./test/repo-template.global.ts'],
  },
});
