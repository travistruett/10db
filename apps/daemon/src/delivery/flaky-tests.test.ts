import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStatus } from '@10db/contracts';
import { createTestStore, listTasks, setTaskStatus } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { failedRepoCheck, seedWorkstream, tempDir } from '../../test/fixtures';
import type { GateResult } from '../verify';
import { fileFlakyTests, flakeNote, flakyTitle, rerunFlaky, type FlakyTest } from './flaky-tests';

const TIMEOUT_LOG = [
  ' FAIL  daemon  src/a.test.ts > suite > slow one',
  'Error: Test timed out in 30000ms.',
  'If this is a long-running test, pass a timeout value as the last argument.',
  ' ❯ src/a.test.ts:12:3',
  '',
  ' FAIL  daemon  src/b.test.ts > wrong',
  'AssertionError: expected 1 to be 2',
  ' FAIL  daemon  src/b.test.ts > other',
  '',
  'AssertionError: expected 3 to be 4',
].join('\n');

/** A checkout whose gate left `logs` in .gate/, and the tail 10db read from the gate. */
function checkoutWith(logs: Record<string, string>): { checkout: string; tail: string } {
  const checkout = tempDir('flaky-checkout').path;
  mkdirSync(join(checkout, '.gate'));
  for (const [name, text] of Object.entries(logs))
    writeFileSync(join(checkout, '.gate', `${name}.log`), text);
  const tail = Object.keys(logs)
    .map((name) => `FAILED ${name}: pnpm ${name} (log .gate/${name}.log)`)
    .join('\n');
  return { checkout, tail };
}

function result(exitCode: number, over: Partial<GateResult> = {}): GateResult {
  return {
    exitCode,
    durationMs: 5,
    tail: exitCode === 0 ? 'ok' : 'still failing',
    logPath: '/logs/rerun.log',
    timedOut: false,
    aborted: false,
    blockedHosts: [],
    ...over,
  };
}

describe('rerunFlaky', () => {
  it('reruns only the failing files, once, and names each test that passed on rerun with its first failure', async () => {
    const { checkout, tail } = checkoutWith({ test: TIMEOUT_LOG });
    const commands: string[] = [];
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: (command) => {
        commands.push(command);
        return Promise.resolve(result(0));
      },
    });
    expect(commands).toEqual(['pnpm exec vitest run src/a.test.ts src/b.test.ts']);
    expect(outcome).toEqual({
      kind: 'flaky',
      rerun: result(0),
      tests: [
        {
          file: 'src/a.test.ts',
          name: 'suite > slow one',
          failure: 'Error: Test timed out in 30000ms.',
          timedOut: true,
        },
        {
          file: 'src/b.test.ts',
          name: 'wrong',
          failure: 'AssertionError: expected 1 to be 2',
          timedOut: false,
        },
        {
          file: 'src/b.test.ts',
          name: 'other',
          failure: 'AssertionError: expected 3 to be 4',
          timedOut: false,
        },
      ],
    });
  });

  it.each([
    ['make check-changed', []],
    ['make precheck', ['--precheck']],
  ])("reads what the repository's own %s really leaves", async (_name, flags) => {
    // The output runs past what 10db keeps of it, so the end of it must name the step by itself.
    const log = `${'noise line\n'.repeat(1000)}${TIMEOUT_LOG}`;
    const { checkout, exitCode, tail } = failedRepoCheck(log, flags);
    expect(exitCode).not.toBe(0);
    const commands: string[] = [];
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: (command) => {
        commands.push(command);
        return Promise.resolve(result(0));
      },
    });
    expect(commands).toEqual(['pnpm exec vitest run src/a.test.ts src/b.test.ts']);
    expect(outcome.kind).toBe('flaky');
  });

  it('names a whole group of tests that share one error, each with that error', async () => {
    const { checkout, tail } = checkoutWith({
      test: [
        ' FAIL  daemon  src/a.test.ts > each > a',
        ' FAIL  daemon  src/a.test.ts > each > b',
        'Error: Test timed out in 30000ms.',
      ].join('\n'),
    });
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: () => Promise.resolve(result(0)),
    });
    expect(outcome).toMatchObject({
      kind: 'flaky',
      tests: [
        { name: 'each > a', failure: 'Error: Test timed out in 30000ms.', timedOut: true },
        { name: 'each > b', failure: 'Error: Test timed out in 30000ms.', timedOut: true },
      ],
    });
  });

  it('is a real failure when the rerun fails too', async () => {
    const { checkout, tail } = checkoutWith({ test: TIMEOUT_LOG });
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: () => Promise.resolve(result(1)),
    });
    expect(outcome).toEqual({ kind: 'failed', rerun: result(1) });
  });

  it('is a real failure when the rerun timed out', async () => {
    const { checkout, tail } = checkoutWith({ test: TIMEOUT_LOG });
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: () => Promise.resolve(result(0, { timedOut: true })),
    });
    expect(outcome.kind).toBe('failed');
  });

  it('records nothing when the rerun was stopped or did not run', async () => {
    const { checkout, tail } = checkoutWith({ test: TIMEOUT_LOG });
    for (const rerun of [result(130, { aborted: true }), null])
      expect(
        await rerunFlaky({ checkout, output: tail, run: () => Promise.resolve(rerun) }),
      ).toEqual({ kind: 'stopped' });
  });

  it.each([
    [
      'a failing step that names no test (lint)',
      { lint: 'error: no-unused-vars', test: TIMEOUT_LOG },
    ],
    ['a log that names no test', { test: 'Command failed with exit code 1' }],
    ['a file name a shell would read as more than a path', { test: ' FAIL  src/$(x).test.ts > t' }],
    ['a file name that leaves the checkout', { test: ' FAIL  ../../x.test.ts > t' }],
  ])('does not rerun %s', async (_name, logs) => {
    const { checkout, tail } = checkoutWith(logs);
    let ran = false;
    const outcome = await rerunFlaky({
      checkout,
      output: tail,
      run: () => {
        ran = true;
        return Promise.resolve(result(0));
      },
    });
    expect(outcome).toEqual({ kind: 'none' });
    expect(ran).toBe(false);
  });

  it('does not rerun output that names no failing step', async () => {
    const outcome = await rerunFlaky({
      checkout: tempDir('flaky-checkout').path,
      output: 'broken\n',
      run: () => Promise.reject(new Error('must not run')),
    });
    expect(outcome).toEqual({ kind: 'none' });
  });
});

describe('flakeNote', () => {
  it('names each test, its first failure and that it passed on rerun', () => {
    const tests: FlakyTest[] = [
      {
        file: 'src/a.test.ts',
        name: 'slow',
        failure: 'Error: Test timed out in 30000ms.',
        timedOut: true,
      },
      { file: 'src/c.test.ts', name: null, failure: 'the file failed to run', timedOut: false },
    ];
    const note = flakeNote(tests);
    expect(note).toContain('src/a.test.ts > slow');
    expect(note).toContain('Test timed out in 30000ms');
    expect(note).toContain('src/c.test.ts');
    expect(note).toMatch(/passed when 10db ran/);
  });
});

describe('fileFlakyTests', () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  function setup() {
    const test = createTestStore();
    close = test.close;
    const seeded = seedWorkstream(test.store);
    const file = (tests: readonly FlakyTest[]) =>
      test.store.write((ctx) => fileFlakyTests(ctx, seeded.task.id, tests)).value;
    const filed = () =>
      listTasks(test.store.db, seeded.project.id).filter((t) => t.title.startsWith('Fix flaky'));
    return { ...test, ...seeded, file, filed };
  }

  const slow: FlakyTest = {
    file: 'src/a.test.ts',
    name: 'slow',
    failure: 'Error: Test timed out in 30000ms.',
    timedOut: true,
  };

  it('files one Icebox task per test file, naming the test and its first failure', () => {
    const s = setup();
    s.file([
      slow,
      { file: 'src/a.test.ts', name: 'also', failure: 'AssertionError: x', timedOut: false },
      { file: 'src/b.test.ts', name: 'wrong', failure: 'AssertionError: y', timedOut: false },
    ]);
    const tasks = s.filed();
    expect(tasks.map((t) => t.title).sort()).toEqual([
      flakyTitle('src/a.test.ts'),
      flakyTitle('src/b.test.ts'),
    ]);
    const a = tasks.find((t) => t.title === flakyTitle('src/a.test.ts'));
    expect(a?.boardColumnId).not.toBeNull();
    expect(a?.description).toContain('slow');
    expect(a?.description).toContain('Test timed out in 30000ms');
    expect(a?.description).toContain('also');
    expect(a?.description).toContain(s.task.title);
  });

  it('adds a second flake of the same file to the open task instead of filing another', () => {
    const s = setup();
    s.file([slow]);
    const second = s.file([
      { file: 'src/a.test.ts', name: 'later', failure: 'AssertionError: z', timedOut: false },
    ]);
    const tasks = s.filed();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.description).toContain('slow');
    expect(tasks[0]?.description).toContain('later');
    expect(tasks[0]?.description).toContain('AssertionError: z');
    expect(second.map((t) => t.id)).toEqual([tasks[0]?.id]);
  });

  it('files a new task once the earlier one is finished', () => {
    const s = setup();
    const [first] = s.file([slow]);
    if (!first) throw new Error('no task filed');
    s.store.write((ctx) => {
      setTaskStatus(ctx, first.id, TaskStatus.Done);
    });
    s.file([slow]);
    expect(s.filed()).toHaveLength(2);
  });
});
