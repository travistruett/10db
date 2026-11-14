import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    // The delivery tests are their own project (vitest.delivery.config.ts): capped in workers and
    // run after this one.
    exclude: [...configDefaults.exclude, 'src/delivery/**'],
    // The pass tests drive real git across worktrees and restart the daemon: up to 13 s each at load
    // average 15, and past 30 s at 55, where several Claude sessions share the Mac. Hooks build temp git
    // repos too. The delivery project has the same margin.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['../../tests/git-isolation.setup.ts'],
    globalSetup: ['./test/repo-template.global.ts'],
  },
});
