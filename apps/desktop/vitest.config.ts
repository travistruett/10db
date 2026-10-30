import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'jsdom',
    setupFiles: ['../../tests/git-isolation.setup.ts', './src/test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**', 'scripts/**'],
    // A test and its hooks must outlast testing-library's 10 s query wait (src/test/setup.ts), or
    // vitest would cut a slow render short on a busy machine. Only a hung test waits this long.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
