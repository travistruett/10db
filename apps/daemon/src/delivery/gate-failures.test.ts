import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { failingTests, readGateFailures, touchedBy } from './gate-failures';

/** A vitest run's failure lines as the gate's test log holds them, colours and all. */
const VITEST_LOG = [
  ' \u001b[31m❯\u001b[39m \u001b[30m\u001b[45m daemon \u001b[49m\u001b[39m src/zz/probe.test.ts (3 tests | 2 failed)',
  '\u001b[31m     \u001b[31m×\u001b[31m fails here\u001b[39m',
  '',
  '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[45m daemon \u001b[49m\u001b[39m src/zz/probe.test.ts\u001b[2m > \u001b[22mouter\u001b[2m > \u001b[22mfails here',
  'AssertionError: expected 1 to be 2',
  '\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[30m\u001b[45m daemon \u001b[49m\u001b[39m src/zz/probe.test.ts\u001b[2m > \u001b[22mtop fails',
  ' FAIL  src/plain.spec.tsx > renders',
  ' FAIL  repo  src/broken.test.ts [ src/broken.test.ts ]',
  // The same failure printed twice (vitest's summary repeats a line) is listed once.
  ' FAIL  src/plain.spec.tsx > renders',
].join('\n');

describe('failingTests', () => {
  it('reads every failing test from a vitest log, its file and its name, once each', () => {
    expect(failingTests(VITEST_LOG)).toEqual([
      { file: 'src/zz/probe.test.ts', name: 'outer > fails here' },
      { file: 'src/zz/probe.test.ts', name: 'top fails' },
      { file: 'src/plain.spec.tsx', name: 'renders' },
      { file: 'src/broken.test.ts', name: null },
    ]);
  });

  it('finds none in a log that names no failing test file', () => {
    expect(failingTests('error: lint failed\n FAIL  something else')).toEqual([]);
  });
});

describe('readGateFailures', () => {
  it("names each failing step from the gate's FAILED lines, with its log in the checkout and its tests", async () => {
    const checkout = tempDir('gate-checkout').path;
    mkdirSync(join(checkout, '.gate'));
    writeFileSync(join(checkout, '.gate', 'test.log'), VITEST_LOG);
    const tail = [
      'FAILED lint: pnpm lint (log .gate/lint.log)',
      'FAILED test: pnpm test (log .gate/test.log)',
      'GATE FAIL: lint test — logs in .gate/; lint 3s · test 40s (43s)',
    ].join('\n');
    const steps = await readGateFailures(checkout, tail);
    expect(steps.map((s) => [s.name, s.command, s.logPath, s.tests.length])).toEqual([
      ['lint', 'pnpm lint', join(checkout, '.gate', 'lint.log'), 0],
      ['test', 'pnpm test', join(checkout, '.gate', 'test.log'), 4],
    ]);
  });

  it('falls back on the summary line when the output holds no FAILED lines', async () => {
    const checkout = tempDir('gate-checkout').path;
    const steps = await readGateFailures(
      checkout,
      'GATE FAIL: test — logs in .gate/; test 40s (40s)',
    );
    expect(steps).toEqual([
      { name: 'test', command: null, logPath: join(checkout, '.gate', 'test.log'), tests: [] },
    ]);
  });

  it('never reads a log outside the checkout', async () => {
    const checkout = tempDir('gate-checkout').path;
    const steps = await readGateFailures(
      checkout,
      'FAILED test: pnpm test (log ../../etc/passwd)\nFAILED lint: pnpm lint (log /etc/hosts)',
    );
    expect(steps.map((s) => s.logPath)).toEqual([null, null]);
  });

  it('finds no step in output from a gate that is not 10db-shaped', async () => {
    expect(await readGateFailures(tempDir('gate-checkout').path, 'broken\n')).toEqual([]);
  });
});

describe('touchedBy', () => {
  it('matches a test file to a changed path, repo-relative or as the project prints it', () => {
    const changed = ['apps/daemon/src/zz/probe.test.ts', 'README.md'];
    expect(touchedBy('src/zz/probe.test.ts', changed)).toBe(true);
    expect(touchedBy('apps/daemon/src/zz/probe.test.ts', changed)).toBe(true);
    expect(touchedBy('src/other.test.ts', changed)).toBe(false);
    expect(touchedBy('probe.test.ts', ['src/zz/xprobe.test.ts'])).toBe(false);
  });
});
