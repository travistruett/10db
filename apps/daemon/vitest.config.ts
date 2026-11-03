import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    // The delivery tests are their own project (vitest.delivery.config.ts): capped in workers and
    // run after this one.
    exclude: [...configDefaults.exclude, 'src/delivery/**'],
    testTimeout: 30_000,
    // Hooks build temp git repos too; under the full gate's load they can pass the 10 s default.
    hookTimeout: 30_000,
    setupFiles: ['../../tests/git-isolation.setup.ts'],
    globalSetup: ['./test/repo-template.global.ts'],
  },
});
