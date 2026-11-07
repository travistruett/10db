import { defineConfig } from 'vitest/config';
import { WeightedShardSequencer } from './tests/repo/src/shard-sequencer';

// Each workspace package with tests is listed here. Every project's own config runs
// tests/git-isolation.setup.ts first; tests/repo checks that none is missing it.
export default defineConfig({
  test: {
    sequence: { sequencer: WeightedShardSequencer },
    projects: [
      'tests/repo',
      'packages/contracts',
      'packages/db',
      'packages/harness',
      'apps/daemon',
      'apps/daemon/vitest.delivery.config.ts',
      'apps/desktop',
      'apps/desktop/e2e',
      'apps/desktop/scripts',
    ],
  },
});
