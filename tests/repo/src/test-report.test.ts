import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runWithFakeGh, type GhReply } from './fake-gh';
import { createThrowawayRepo } from './fixtures';
import {
  buildReport,
  classifyPath,
  COMMENT_MARKER,
  parseNumstat,
  renderReport,
  ShardTimings,
  type DiffEntry,
} from './test-report';
import { repoRoot } from './workspace';

const shard = (
  index: number,
  files: readonly (readonly [file: string, tests: number, seconds: number])[],
  count = 2,
): ShardTimings => ({
  shard: { index, count },
  files: files.map(([file, tests, seconds]) => ({ file, tests, seconds })),
});

const entry = (path: string, added: number, oldPath?: string): DiffEntry => ({
  path,
  added,
  ...(oldPath === undefined ? {} : { oldPath }),
});

describe('classifyPath', () => {
  it.each([
    ['a unit test', 'apps/daemon/src/runner/runner.test.ts', 'test'],
    ['a component test', 'apps/desktop/src/views/board/board-view.test.tsx', 'test'],
    ['an e2e spec', 'apps/desktop/e2e/loop.spec.ts', 'test'],
    ['a test helper', 'apps/daemon/test/fixtures.ts', 'test'],
    ['the repo tests', 'tests/repo/src/ci.test.ts', 'test'],
    ['a script of the repo tests', 'tests/repo/src/workflows.ts', 'test'],
    ['production TypeScript', 'apps/daemon/src/runner/runner.ts', 'code'],
    ['a shell script', 'scripts/gate.sh', 'code'],
    ['a hook', '.claude/hooks/git-guard.mjs', 'code'],
    ['Rust', 'apps/desktop/src-tauri/src/main.rs', 'code'],
    ['docs', 'docs/architecture/decisions/x.md', 'other'],
    ['the lockfile', 'pnpm-lock.yaml', 'other'],
    ['generated contracts', 'packages/contracts/generated/schema.ts', 'other'],
    ['generated migrations', 'packages/db/drizzle/0000_baseline.sql', 'other'],
    ['generated migration metadata', 'packages/db/drizzle/meta/_journal.json', 'other'],
    ['a workflow', '.github/workflows/ci.yml', 'other'],
  ])('%s', (_name, path, kind) => {
    expect(classifyPath(path)).toBe(kind);
  });
});

describe('parseNumstat', () => {
  it.each([
    ['nothing', '', []],
    ['a changed file', '3\t1\tsrc/a.ts\0', [entry('src/a.ts', 3)]],
    ['a binary file counts no lines', '-\t-\ticon.png\0', [entry('icon.png', 0)]],
    [
      'a rename keeps both paths',
      '2\t0\t\0src/old.test.ts\0src/new.test.ts\0',
      [entry('src/new.test.ts', 2, 'src/old.test.ts')],
    ],
    [
      'a rename among other files',
      '1\t0\ta.ts\0' + '0\t0\t\0b.ts\0c.ts\0' + '4\t2\td.ts\0',
      [entry('a.ts', 1), entry('c.ts', 0, 'b.ts'), entry('d.ts', 4)],
    ],
  ])('%s', (_name, output, expected) => {
    expect(parseNumstat(output)).toEqual(expected);
  });
});

describe('buildReport', () => {
  const baseline = [shard(1, [['a.test.ts', 10, 2]]), shard(2, [['b.test.ts', 5, 8]])];

  it('counts only the test files the pull request touched', () => {
    const report = buildReport({
      current: [shard(1, [['a.test.ts', 12, 3.5]]), shard(2, [['b.test.ts', 7, 30]])],
      baseline,
      diff: [entry('a.test.ts', 40), entry('src/a.ts', 20)],
    });
    expect(report.tests).toEqual({ added: 2 });
    expect(report.seconds).toEqual({ added: 1.5 });
    expect(report.rows).toEqual([{ file: 'a.test.ts', tests: 2, seconds: 1.5 }]);
    expect(report.lines).toEqual({ test: 40, code: 20 });
  });

  it.each([
    [
      'a new file adds all of its tests and seconds',
      [shard(1, [['a.test.ts', 10, 2]]), shard(2, [['n.test.ts', 4, 1]])],
      [entry('n.test.ts', 30)],
      { tests: 4, seconds: 1 },
    ],
    [
      'a deleted file takes away all of its tests and seconds',
      [shard(1, []), shard(2, [['b.test.ts', 5, 8]])],
      [entry('a.test.ts', 0)],
      { tests: -10, seconds: -2 },
    ],
    [
      'a renamed file is compared with its old path',
      [shard(1, [['moved.test.ts', 11, 2.5]]), shard(2, [['b.test.ts', 5, 8]])],
      [entry('moved.test.ts', 3, 'a.test.ts')],
      { tests: 1, seconds: 0.5 },
    ],
  ])('%s', (_name, current, diff, expected) => {
    const report = buildReport({ current, baseline, diff });
    expect(report.tests).toEqual({ added: expected.tests });
    expect(report.seconds).toEqual({ added: expected.seconds });
  });

  it('adds up a file reported by two shards or projects', () => {
    const report = buildReport({
      current: [shard(1, [['a.test.ts', 10, 2]]), shard(2, [['a.test.ts', 3, 1]])],
      baseline,
      diff: [entry('a.test.ts', 1)],
    });
    expect(report.rows).toEqual([{ file: 'a.test.ts', tests: 3, seconds: 1 }]);
  });

  it('gives no comparison without a baseline, and still gives the line ratio', () => {
    const report = buildReport({
      current: [shard(1, [['a.test.ts', 10, 2]]), shard(2, [])],
      baseline: null,
      diff: [entry('a.test.ts', 9), entry('src/a.ts', 3)],
    });
    expect(report.tests).toBeNull();
    expect(report.seconds).toBeNull();
    expect(report.rows).toEqual([]);
    expect(report.lines).toEqual({ test: 9, code: 3 });
    expect(report.missing).toBe('baseline');
  });

  it('gives no comparison when a shard is missing, so a file it ran never reads as deleted', () => {
    const report = buildReport({
      current: [shard(1, [['a.test.ts', 10, 2]])],
      baseline,
      diff: [entry('b.test.ts', 1)],
    });
    expect(report.tests).toBeNull();
    expect(report.rows).toEqual([]);
    expect(report.missing).toEqual({ reported: 1, expected: 2 });
  });

  it('gives no comparison when no shard reported at all', () => {
    const report = buildReport({ current: [], baseline, diff: [] });
    expect(report.tests).toBeNull();
    expect(report.missing).toEqual({ reported: 0, expected: null });
  });
});

describe('renderReport', () => {
  const report = buildReport({
    current: [shard(1, [['a.test.ts', 12, 3.5]], 1)],
    baseline: [shard(1, [['a.test.ts', 10, 2]], 1)],
    diff: [entry('a.test.ts', 40), entry('src/a.ts', 20)],
  });

  it('starts with the marker the comment is found by', () => {
    expect(renderReport(report, 'abc1234').startsWith(COMMENT_MARKER)).toBe(true);
  });

  it('gives the three numbers and names the commit it compared with', () => {
    const body = renderReport(report, 'abc1234');
    expect(body).toContain('| Tests added | +2 |');
    expect(body).toContain('| Seconds added | +1.5 s |');
    expect(body).toContain('| Test lines per code line | 2.00 (40 test, 20 code) |');
    expect(body).toContain('`abc1234`');
  });

  it('shows the slowest changes first and says how many it left out', () => {
    const files = Array.from(
      { length: 12 },
      (_, index) => [`f${String(index)}.test.ts`, 1, index + 1] as const,
    );
    const body = renderReport(
      buildReport({
        current: [shard(1, files, 1)],
        baseline: [shard(1, [], 1)],
        diff: files.map(([file]) => entry(file, 1)),
      }),
      'abc1234',
    );
    expect(body.indexOf('`f11.test.ts`')).toBeLessThan(body.indexOf('`f10.test.ts`'));
    expect(body).not.toContain('`f0.test.ts`');
    expect(body).toContain('2 more files');
  });

  it.each([
    ['no code lines', [entry('a.test.ts', 7)], '| Test lines per code line | 7 test, 0 code |'],
    ['no lines at all', [], '| Test lines per code line | none |'],
  ])('words the ratio with %s', (_name, diff, line) => {
    const body = renderReport(buildReport({ current: [], baseline: null, diff }), null);
    expect(body).toContain(line);
  });

  it.each([
    ['a missing baseline', null, 1, 'No timings from `main` yet'],
    ['a missing shard', [shard(1, [], 3)], 3, 'Only 1 of 3 test shards reported'],
  ])('says why the comparison is absent with %s', (_name, baseline, count, text) => {
    const body = renderReport(
      buildReport({ current: [shard(1, [], count)], baseline, diff: [] }),
      null,
    );
    expect(body).toContain(text);
    expect(body).toContain('| Tests added | not compared |');
  });

  it('cannot break out of a code span with a file name', () => {
    const name = 'a`b|c\nd.test.ts';
    const body = renderReport(
      buildReport({
        current: [shard(1, [[name, 1, 1]], 1)],
        baseline: [shard(1, [], 1)],
        diff: [entry(name, 1)],
      }),
      null,
    );
    expect(body).toContain("`a'b/c d.test.ts`");
  });
});

describe('ShardTimings', () => {
  it.each([
    ['a file with no seconds', { shard: { index: 1, count: 2 }, files: [{ file: 'a', tests: 1 }] }],
    ['no files list', { shard: { index: 1, count: 2 } }],
    ['a shard out of range', { shard: { index: 0, count: 2 }, files: [] }],
  ])('refuses %s', (_name, value) => {
    expect(ShardTimings.safeParse(value).success).toBe(false);
  });
});

describe('scripts/test-report.mjs', () => {
  const script = join(repoRoot, 'scripts/test-report.mjs');
  const repository = 'owner/repo';
  const runs = `api repos/${repository}/actions/workflows/ci.yml/runs`;
  const artifacts = (id: number) => `api repos/${repository}/actions/runs/${String(id)}/artifacts`;

  /** Runs the script in a two-commit repository, whose first commit stands for the base. */
  function report(replies: (base: string, head: string) => GhReply[], timings = true) {
    const repo = createThrowawayRepo('test-report');
    const dir = mkdtempSync(join(tmpdir(), 'test-report-timings-'));
    try {
      repo.stage('src/a.ts', 'one\n');
      repo.commit('base');
      const base = repo.gitOutput('rev-parse', 'HEAD');
      repo.stage('src/a.ts', 'one\ntwo\n');
      repo.stage('src/a.test.ts', 'one\ntwo\nthree\nfour\n');
      repo.commit('pull request');
      const head = repo.gitOutput('rev-parse', 'HEAD');
      if (timings) {
        mkdirSync(join(dir, 'test-timings-1'));
        const file = join(dir, 'test-timings-1', 'test-timings.json');
        writeFileSync(file, JSON.stringify(shard(1, [['src/a.test.ts', 4, 1]], 1)));
      }
      const env = Object.fromEntries(
        Object.entries(repo.env).flatMap(([key, value]) =>
          key === 'PATH' || value === undefined ? [] : [[key, value]],
        ),
      );
      return runWithFakeGh(
        script,
        replies(base, head),
        { ...env, REPOSITORY: repository, TIMINGS_DIR: timings ? dir : join(dir, 'missing') },
        repo.dir,
      );
    } finally {
      repo.remove();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('downloads the newest ancestor of the base that has every shard unexpired', () => {
    const result = report((base, head) => [
      {
        args: runs,
        stdout: JSON.stringify({
          workflow_runs: [
            { id: 4, head_sha: head },
            { id: 3, head_sha: 'not-a-commit' },
            { id: 2, head_sha: base },
            { id: 1, head_sha: base },
          ],
        }),
      },
      {
        args: artifacts(2),
        stdout: JSON.stringify({ artifacts: [{ name: 'test-timings-1', expired: true }] }),
      },
      {
        args: artifacts(1),
        stdout: JSON.stringify({ artifacts: [{ name: 'test-timings-1', expired: false }] }),
      },
      { args: 'run download 1' },
    ]);
    expect(result.status).toBe(0);
    const calls = result.calls.map(({ args }) => args);
    expect(calls.filter((args) => args.startsWith('run download'))).toEqual([
      expect.stringContaining('run download 1 -R owner/repo -p test-timings-*'),
    ]);
    expect(calls.some((args) => args.startsWith(artifacts(4)))).toBe(false);
  });

  it('still reports the lines when GitHub cannot be reached, and leaves the rest out', () => {
    const result = report(() => [{ args: 'api', stderr: 'down', status: 1 }]);
    expect(result.status).toBe(0);
    expect(result.stdout.startsWith(COMMENT_MARKER)).toBe(true);
    expect(result.stdout).toContain('| Test lines per code line | 4.00 (4 test, 1 code) |');
    expect(result.stdout).toContain('No timings from `main` yet');
  });

  it('reports without asking GitHub when no shard left its timings', () => {
    const result = report(() => [], false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No test shard reported');
    expect(result.calls).toEqual([]);
  });
});
