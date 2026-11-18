import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { JudgeDecision, mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import type { Judge, JudgeAnswer, JudgeRequest } from '../judge';
import { judgeNewTests } from './judge-new-tests';
import { TestValueVerdict } from './test-value-ask';

const git = createGit();
let repo: TempDir;
beforeEach(() => {
  repo = createTempRepo();
});
afterEach(() => {
  repo.cleanup();
});

const raw = (...args: string[]): string =>
  execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

function commitFiles(files: Record<string, string>, message: string): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.path, path)), { recursive: true });
    writeFileSync(join(repo.path, path), text);
  }
  raw('add', ...Object.keys(files));
  raw('commit', '-q', '-m', message);
  return raw('rev-parse', 'HEAD');
}

const PARSE_TEST = [
  "import { parse } from './parse';",
  "import { it, expect } from 'vitest';",
  '',
  "it('reads a number', () => {",
  "  expect(parse('1')).toBe(1);",
  '});',
  '',
].join('\n');

const WITH_NEW = `${PARSE_TEST}\nit('reads a number once more', () => {\n  expect(parse('1')).toBe(1);\n});\n`;

function judgeThat(
  choose: (req: JudgeRequest) => JudgeAnswer,
  over: Partial<Judge> = {},
): { judge: Judge; asked: JudgeRequest[] } {
  const asked: JudgeRequest[] = [];
  const judge: Judge = {
    off: false,
    ready: () => Promise.resolve(true),
    choose: (req) => {
      asked.push(req);
      return Promise.resolve(choose(req));
    },
    ...over,
  };
  return { judge, asked };
}

const answered = (choice: string, confidence: number): JudgeAnswer => ({
  kind: 'answered',
  choice,
  confidence,
  model: 'm',
  latencyMs: 1,
  costUsd: null,
  callId: mintId('JudgeCall'),
});

const quietLogger = { warn: () => undefined } as const;

const input = (base: string) => ({
  checkout: repo.path,
  base,
  head: raw('rev-parse', 'HEAD'),
  taskId: mintId('Task'),
});

describe('judgeNewTests', () => {
  it('asks once for a test a commit added, with its value card, its neighbour and its imports, and flags a duplicate', async () => {
    commitFiles(
      { 'src/parse.ts': 'export const parse = Number;\n', 'src/parse.test.ts': PARSE_TEST },
      'feat: parse',
    );
    const base = raw('rev-parse', 'HEAD');
    commitFiles(
      { 'src/parse.test.ts': WITH_NEW },
      'test: once more\n\nValue: protects=parse; fails_when=parse breaks; why_new=none; no_claim=none',
    );
    const { judge, asked } = judgeThat(() => answered('duplicate_of_1', 0.93));
    const flags = await judgeNewTests({ git, judge, floor: 0.8, logger: quietLogger }, input(base));
    expect(asked).toHaveLength(1);
    const request = asked[0];
    expect(request?.decision).toBe(JudgeDecision.TestValue);
    expect(request?.state).toContain('reads a number once more');
    expect(request?.state).toContain('Value: protects=parse; fails_when=parse breaks');
    expect(request?.state).toContain('src/parse.test.ts:4 "reads a number"');
    expect(request?.state).toContain('src/parse.ts');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      verdict: TestValueVerdict.DuplicateOf,
      confidence: 0.93,
      existing: { file: 'src/parse.test.ts', name: 'reads a number', line: 4 },
      test: { name: 'reads a number once more', file: 'src/parse.test.ts' },
    });
  });

  it('shows a sibling test file that imports the same module as a neighbour', async () => {
    commitFiles(
      {
        'src/parse.ts': 'export const parse = Number;\n',
        'src/parse.test.ts': PARSE_TEST,
        'src/parse-more.test.ts':
          "import { parse } from './parse';\nit('reads a float', () => {\n  parse('1.5');\n});\n",
        'src/other.test.ts': "import { x } from './x';\nit('is unrelated', () => {\n  x();\n});\n",
      },
      'feat: parse',
    );
    const base = raw('rev-parse', 'HEAD');
    commitFiles({ 'src/parse.test.ts': WITH_NEW }, 'test: once more');
    const { judge, asked } = judgeThat(() => answered('keep', 0.99));
    await judgeNewTests({ git, judge, floor: 0.8, logger: quietLogger }, input(base));
    const state = asked[0]?.state ?? '';
    expect(state).toContain('src/parse-more.test.ts');
    expect(state).toContain('reads a float');
    expect(state).not.toContain('is unrelated');
  });

  it.each([
    ['keep', answered('keep', 0.99)],
    ['an answer below its floor', answered('move_cheaper', 0.5)],
    [
      'a fallback',
      { kind: 'fallback', reason: 'timeout', detail: 'slow', callId: mintId('JudgeCall') } as const,
    ],
  ])('flags nothing for %s', async (_name, answer) => {
    commitFiles({ 'src/parse.test.ts': PARSE_TEST }, 'feat: parse');
    const base = raw('rev-parse', 'HEAD');
    commitFiles({ 'src/parse.test.ts': WITH_NEW }, 'test: once more');
    const { judge } = judgeThat(() => answer);
    expect(
      await judgeNewTests({ git, judge, floor: 0.8, logger: quietLogger }, input(base)),
    ).toEqual([]);
  });

  it('asks nothing when the decision is not ready, for a commit with no new test, or for a table row', async () => {
    const table = "it.each([\n  ['a', 1],\n])('reads %s', (t, n) => {\n  expect(t).toBe(n);\n});\n";
    commitFiles({ 'src/t.test.ts': table }, 'feat: table');
    const base = raw('rev-parse', 'HEAD');
    commitFiles(
      {
        'src/t.test.ts': table.replace("  ['a', 1],\n", "  ['a', 1],\n  ['b', 2],\n"),
        'src/code.ts': 'export {};\n',
      },
      'test: a row',
    );
    const ready = judgeThat(() => answered('keep', 0.99));
    expect(
      await judgeNewTests(
        { git, judge: ready.judge, floor: 0.8, logger: quietLogger },
        input(base),
      ),
    ).toEqual([]);
    expect(ready.asked).toEqual([]);

    commitFiles(
      { 'src/t.test.ts': `${table}\nit('new', () => {\n  expect(1).toBe(1);\n});\n` },
      'test: new',
    );
    const off = judgeThat(() => answered('keep', 0.99), { ready: () => Promise.resolve(false) });
    await judgeNewTests({ git, judge: off.judge, floor: 0.8, logger: quietLogger }, input(base));
    expect(off.asked).toEqual([]);
  });

  it('skips a merge commit, which brings tests other work added', async () => {
    commitFiles({ 'src/parse.test.ts': PARSE_TEST }, 'feat: parse');
    const base = raw('rev-parse', 'HEAD');
    raw('checkout', '-q', '-b', 'other');
    commitFiles({ 'src/parse.test.ts': WITH_NEW }, 'test: on another branch');
    raw('checkout', '-q', 'main');
    commitFiles({ 'src/code.ts': 'export {};\n' }, 'feat: code');
    raw('merge', '-q', '--no-ff', '-m', 'merge other', 'other');
    const { judge, asked } = judgeThat(() => answered('keep', 0.99));
    await judgeNewTests({ git, judge, floor: 0.8, logger: quietLogger }, input(base));
    expect(asked).toEqual([]);
  });

  it('never throws: a judge that throws yields no flags', async () => {
    commitFiles({ 'src/parse.test.ts': PARSE_TEST }, 'feat: parse');
    const base = raw('rev-parse', 'HEAD');
    commitFiles({ 'src/parse.test.ts': WITH_NEW }, 'test: once more');
    const { judge } = judgeThat(() => {
      throw new Error('boom');
    });
    expect(
      await judgeNewTests({ git, judge, floor: 0.8, logger: quietLogger }, input(base)),
    ).toEqual([]);
  });
});
