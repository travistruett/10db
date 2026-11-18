import { configDefaults, defineConfig } from 'vitest/config';
import { WeightedShardSequencer } from './tests/repo/src/shard-sequencer';
import { TestTimingReporter } from './tests/repo/src/test-timing-reporter';
import { localWorkerCap } from './tests/max-workers';

// CI's test shards set this.
const timings = process.env['TENDB_TEST_TIMINGS'];

// Vitest's defaults stay listed, since setting `reporters` replaces them. The progress reporter prints
// a line as each test file starts, so a gate step that hangs or times out names the file it was
// running. A `--reporter` on the command line replaces this whole list.
const reporters = [
  ...configDefaults.reporters,
  './scripts/vitest-progress.mjs',
  ...(timings ? [new TestTimingReporter(timings)] : []),
];

// Each workspace package with tests is listed here. Every project's own config runs
// tests/git-isolation.setup.ts first; tests/repo checks that none is missing it.
export default defineConfig({
  test: {
    sequence: { sequencer: WeightedShardSequencer },
    reporters,
    ...localWorkerCap,
    projects: [
      'tests/repo',
      'packages/contracts',
      'packages/db',
      'packages/harness',
      'packages/agent-skill',
      'apps/daemon',
      'apps/daemon/vitest.delivery.config.ts',
      'apps/desktop',
      'apps/desktop/e2e',
      'apps/desktop/scripts',
    ],
  },
});
