import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'desktop',
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
  },
});
