import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import type { Reporter, TestModule, Vitest } from 'vitest/node';
import type { ShardTimings } from './test-report';

/**
 * A file's seconds with its imports, setup and `beforeAll`. Vitest's JSON reporter measures from the
 * first test's start to the last test's end, which leaves out what a shared fixture costs.
 */
function moduleTiming(root: string, module: TestModule): ShardTimings['files'][number] {
  const { environmentSetupDuration, prepareDuration, collectDuration, setupDuration, duration } =
    module.diagnostic();
  const milliseconds =
    environmentSetupDuration + prepareDuration + collectDuration + setupDuration + duration;
  return {
    file: relative(root, module.moduleId),
    tests: [...module.children.allTests()].length,
    seconds: milliseconds / 1000,
  };
}

/** Writes each test file's count and seconds to `path`, for the pull request's test report. */
export class TestTimingReporter implements Reporter {
  private readonly path: string;
  private vitest: Vitest | undefined;

  constructor(path: string) {
    this.path = path;
  }

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunEnd(modules: readonly TestModule[]): void {
    const root = this.vitest?.config.root ?? process.cwd();
    const shard = this.vitest?.config.shard ?? { index: 1, count: 1 };
    const timings: ShardTimings = {
      shard,
      files: modules.map((module) => moduleTiming(root, module)),
    };
    // A reporter's error fails the run, and this runs inside a required check for a number that
    // is only informational. No file reads as a shard that didn't report.
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(timings));
    } catch (error) {
      process.stderr.write(`test timings not written: ${String(error)}\n`);
    }
  }
}
