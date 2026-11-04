import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { failedSteps } from '../briefing';

/** A test a gate step's log says failed; `name` is null when the whole file failed to run. */
export interface FailingTest {
  readonly file: string;
  readonly name: string | null;
}

/** A gate step that failed: its rerun command when the gate named one, its log in the checkout, its failing tests. */
export interface GateStepFailure {
  readonly name: string;
  readonly command: string | null;
  /** Absolute; null when the gate named a log outside the checkout. */
  readonly logPath: string | null;
  readonly tests: readonly FailingTest[];
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are what this strips.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function plain(text: string): string {
  return text.replace(ANSI, '');
}

const TEST_FILE = /^\S+\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The failing tests a vitest log names, in order and once each: its ` FAIL  <project>  <file> > <suite> > <test>`
 * lines, and ` FAIL  <file> [ <file> ]` for a file that failed to run.
 */
export function failingTests(log: string): FailingTest[] {
  const found = new Map<string, FailingTest>();
  for (const line of plain(log).split('\n')) {
    const match = /^\s*FAIL\s+(.+)$/.exec(line);
    if (!match?.[1]) continue;
    const words = match[1].split(/\s+/);
    const at = words.findIndex((w) => TEST_FILE.test(w));
    const file = words[at];
    if (at < 0 || file === undefined) continue;
    const rest = words.slice(at + 1).join(' ');
    const name = rest.startsWith('> ') ? rest.slice(2).trim() : null;
    const key = `${file}\0${name ?? ''}`;
    if (!found.has(key)) found.set(key, { file, name });
  }
  return [...found.values()];
}

/** The key a failing test has in `failureReasons`. */
export function failureKey(test: FailingTest): string {
  return `${test.file}\0${test.name ?? ''}`;
}

const REASON_MAX = 300;

/**
 * What a vitest log says of each failing test, keyed by `failureKey`: the first line after its first
 * ` FAIL ` line that is not blank and not another ` FAIL ` line (`Error: Test timed out in 30000ms.`,
 * `AssertionError: expected 1 to be 2`). A test with no such line has no entry.
 */
export function failureReasons(log: string): Map<string, string> {
  const lines = plain(log).split('\n');
  const reasons = new Map<string, string>();
  lines.forEach((line, at) => {
    const [test] = failingTests(line);
    if (!test || reasons.has(failureKey(test))) return;
    const reason = lines.slice(at + 1).find((next) => next.trim() !== '');
    if (reason === undefined || /^\s*FAIL\s/.test(reason)) return;
    reasons.set(failureKey(test), reason.trim().slice(0, REASON_MAX));
  });
  return reasons;
}

/** The steps the gate's summary line names (`GATE FAIL: lint test — logs in .gate/; …`), each log at `<dir>/<step>.log`. */
function summarySteps(output: string): { name: string; log: string }[] {
  const match = /^GATE FAIL: (.+?) — logs in (\S+?)\/?(?:;|\s|$)/m.exec(output);
  if (!match?.[1] || !match[2]) return [];
  const dir = match[2];
  return match[1]
    .split(/\s+/)
    .filter((name) => /^[\w-]+$/.test(name))
    .map((name) => ({ name, log: `${dir}/${name}.log` }));
}

/** `log` resolved in `checkout`, or null when it is absolute or leaves the checkout. */
function inCheckout(checkout: string, log: string): string | null {
  if (isAbsolute(log)) return null;
  const relative = normalize(log);
  if (relative === '..' || relative.startsWith(`..${sep}`)) return null;
  return join(checkout, relative);
}

/**
 * The failing steps a gate's output names, from its `FAILED <step>: <command> (log <path>)` lines or else
 * its summary line, each with the failing tests its log in `checkout` names. None for a gate that prints
 * neither; a log that can't be read names no tests.
 */
export async function readGateFailures(
  checkout: string,
  output: string,
): Promise<GateStepFailure[]> {
  const text = plain(output);
  const named = failedSteps(text);
  const steps =
    named.length > 0
      ? named.map((s) => ({ name: s.name, command: s.command, log: s.log }))
      : summarySteps(text).map((s) => ({ ...s, command: null }));
  return Promise.all(
    steps.map(async (step) => {
      const logPath = inCheckout(checkout, step.log);
      const log = logPath === null ? '' : await readFile(logPath, 'utf8').catch(() => '');
      return { name: step.name, command: step.command, logPath, tests: failingTests(log) };
    }),
  );
}

/**
 * Whether `file`, as a test runner printed it (relative to the repository or to its own package), is
 * one of the `changed` repo-relative paths.
 */
export function touchedBy(file: string, changed: readonly string[]): boolean {
  return changed.some((path) => path === file || path.endsWith(`/${file}`));
}
