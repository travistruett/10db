import { readFile } from 'node:fs/promises';
import { TaskStatus, type TaskDto, type TaskId } from '@10db/contracts';
import { getTask, insertFollowUpTask, listTasks, patchTask, type WriteContext } from '@10db/db';
import type { GateResult } from '../verify';
import { failureKey, failureReasons, readGateFailures } from './gate-failures';

/** A test that failed in a check and passed when 10db ran its file again. */
export interface FlakyTest {
  readonly file: string;
  /** Null when the whole file failed to run. */
  readonly name: string | null;
  /** The first line the log gave for the failure. */
  readonly failure: string;
  /** Whether the failure was the test hitting its timeout. */
  readonly timedOut: boolean;
}

/** What the one rerun of a failed check's failing test files made of it. */
export type FlakyOutcome =
  /** The failure isn't one only test files explain, so nothing was rerun. */
  | { readonly kind: 'none' }
  /** The rerun was stopped (shutdown) or never started: nothing to record. */
  | { readonly kind: 'stopped' }
  /** The rerun failed too, or timed out: the failure is real. */
  | { readonly kind: 'failed'; readonly rerun: GateResult }
  /** The rerun passed: these tests failed once and passed. */
  | { readonly kind: 'flaky'; readonly tests: readonly FlakyTest[]; readonly rerun: GateResult };

const TIMED_OUT = /timed out in \d+\s*ms/i;

/**
 * A test file path safe to put on a shell command line, inside the checkout: the log is written by
 * code a lane wrote, and the rerun command is made from it.
 */
const SAFE_PATH = /^(?!-)[\w@+.-]+(?:\/[\w@+.-]+)*$/;

function safeTestFile(file: string): boolean {
  return SAFE_PATH.test(file) && !file.split('/').some((part) => part === '..' || part === '.');
}

/**
 * The failing tests of a failed check, when test files alone explain it: every failing step the
 * output names has a log that names failing tests, and each test file has a path the rerun command can
 * carry. Null otherwise (a lint, typecheck or drift failure, a log 10db can't read, an odd path), and
 * then the failure is as it ever was.
 */
async function failedTestsOf(checkout: string, output: string): Promise<FlakyTest[] | null> {
  const steps = await readGateFailures(checkout, output);
  if (steps.length === 0) return null;
  const found: FlakyTest[] = [];
  for (const step of steps) {
    if (step.logPath === null || step.tests.length === 0) return null;
    const log = await readFile(step.logPath, 'utf8').catch(() => null);
    if (log === null) return null;
    const reasons = failureReasons(log);
    for (const test of step.tests) {
      if (!safeTestFile(test.file)) return null;
      const failure = reasons.get(failureKey(test)) ?? 'failed with no message in the log';
      found.push({ file: test.file, name: test.name, failure, timedOut: TIMED_OUT.test(failure) });
    }
  }
  return found;
}

/**
 * When a check fails only in tests (including ones that hit the test timeout), runs just the failing
 * test files once through `run` and says whether they pass. The caller decides what a pass means: the
 * step went on, with the flakes on its record. It reads the logs before the rerun, which overwrites
 * them. `run` answers null for a rerun that did not start.
 */
export async function rerunFlaky(input: {
  readonly checkout: string;
  /** The check's output: its `FAILED <step>` lines or summary line. */
  readonly output: string;
  readonly run: (command: string) => Promise<GateResult | null>;
}): Promise<FlakyOutcome> {
  const tests = await failedTestsOf(input.checkout, input.output);
  if (tests === null) return { kind: 'none' };
  const files = [...new Set(tests.map((t) => t.file))];
  const rerun = await input.run(`pnpm exec vitest run ${files.join(' ')}`);
  if (rerun === null || rerun.aborted) return { kind: 'stopped' };
  if (rerun.timedOut || rerun.exitCode !== 0) return { kind: 'failed', rerun };
  return { kind: 'flaky', tests, rerun };
}

function testLine(test: FlakyTest): string {
  const named = test.name === null ? test.file : `${test.file} > ${test.name}`;
  return `${named}: ${test.failure}`;
}

/** The step's record of the flakes: each test that failed once, its first failure, and that it then passed. */
export function flakeNote(tests: readonly FlakyTest[]): string {
  const timeouts = tests.filter((t) => t.timedOut).length;
  const why = timeouts > 0 ? ` (${String(timeouts)} hit the test timeout)` : '';
  const lines = tests.map((t) => `- ${testLine(t)}`).join('\n');
  return `The check failed, then passed when 10db ran just the failing test files again${why}, so the step went on. These tests failed once and passed on rerun:\n${lines}`;
}

/** The title of the Icebox task for a flaky test file; its open task is how a second flake finds it. */
export function flakyTitle(file: string): string {
  return `Fix flaky test file ${file}`;
}

function flakeEntries(tests: readonly FlakyTest[], source: TaskDto): string {
  return tests
    .map((t) => `- ${testLine(t)} (first failure, found while checking "${source.title}")`)
    .join('\n');
}

/**
 * Files one Icebox task per flaky test file, naming each test and its first failure, in the caller's
 * write. A file that already has an open task gets the new flakes added to that task's description
 * instead of another task. `sourceId` is the task whose check flaked. Answers the task of each file.
 */
export function fileFlakyTests(
  ctx: WriteContext,
  sourceId: TaskId,
  tests: readonly FlakyTest[],
): TaskDto[] {
  const byFile = new Map<string, FlakyTest[]>();
  for (const test of tests) byFile.set(test.file, [...(byFile.get(test.file) ?? []), test]);
  const source = getTask(ctx.tx, sourceId);
  const open = listTasks(ctx.tx, source.projectId).filter((t) => t.status === TaskStatus.Open);
  return [...byFile].map(([file, flakes]) => {
    const existing = open.find((t) => t.title === flakyTitle(file));
    if (existing)
      return patchTask(ctx, existing.id, {
        description: `${existing.description}\n\nFlaked again:\n${flakeEntries(flakes, source)}`,
      });
    return insertFollowUpTask(ctx, sourceId, {
      title: flakyTitle(file),
      description: `A test in ${file} failed in a check and passed when 10db ran the file again, so the check went on. First failure:\n${flakeEntries(flakes, source)}\n\n10db files one task per test file: a later flake of this file is added here while this task is open.`,
      acceptanceCriteria: [`${file} passes on its first run, under load too, with no rerun`],
    });
  });
}
