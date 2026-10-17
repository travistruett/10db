import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
