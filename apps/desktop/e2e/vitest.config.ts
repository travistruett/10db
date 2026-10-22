import { defineProject } from 'vitest/config';

// Unit tests for the E2E harness itself; they run in node, apart from the jsdom UI tests.
export default defineProject({
  test: {
    name: 'desktop-e2e',
    environment: 'node',
    include: ['*.test.ts'],
  },
});
