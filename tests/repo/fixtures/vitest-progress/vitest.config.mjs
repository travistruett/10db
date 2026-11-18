import { defineConfig } from 'vitest/config';

// Only *.check.mjs, so the repo's own vitest projects never collect this fixture's file.
export default defineConfig({
  test: { include: ['*.check.mjs'] },
});
