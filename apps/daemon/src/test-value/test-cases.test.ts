import { describe, expect, it } from 'vitest';
import {
  addedLines,
  isTestFile,
  localImportsOf,
  newTestCases,
  splitDiffByFile,
  testCasesIn,
  valueCardOf,
} from './test-cases';

const SOURCE = [
  "import { describe, expect, it } from 'vitest';",
  "import { parse } from './parse';",
  "import type { Shape } from '../shape/shape';",
  '',
  "describe('parse', () => {",
  "  it('reads a number', () => {",
  "    expect(parse('1')).toBe(1);",
  '  });',
  '',
  '  it.each([',
  "    ['one', 1],",
  "    ['two', 2],",
  "  ] as const)('reads %s', (text, n) => {",
  '    expect(parse(text)).toBe(n);',
  '  });',
  '',
  "  test(`reads a ${'template'} name`, () => {",
  '    expect(parse("x")).toBeNull();',
  '  });',
  '});',
].join('\n');

describe('isTestFile', () => {
  it.each([
    ['a/b.test.ts', true],
    ['a/b.test.tsx', true],
    ['a/b.spec.mjs', true],
    ['a/b.ts', false],
    ['a/test-cases.ts', false],
    ['a/b.test.ts.snap', false],
  ])('%s -> %s', (path, expected) => {
    expect(isTestFile(path)).toBe(expected);
  });
});

describe('testCasesIn', () => {
  it('finds each it, it.each and test call with its line and body', () => {
    const cases = testCasesIn(SOURCE);
    expect(cases.map((c) => [c.name, c.line])).toEqual([
      ['reads a number', 6],
      ['reads %s', 13],
      ["reads a ${'template'} name", 17],
    ]);
    expect(cases[0]?.body).toBe(
      ["  it('reads a number', () => {", "    expect(parse('1')).toBe(1);", '  });'].join('\n'),
    );
  });

  it('cuts a body at the line cap', () => {
    const long = [
      "it('long', () => {",
      ...Array.from({ length: 80 }, (_, i) => `  a(${String(i)});`),
      '});',
    ];
    const [only] = testCasesIn(long.join('\n'), { bodyLines: 5 });
    expect(only?.body.split('\n')).toHaveLength(5);
  });
});

describe('addedLines', () => {
  it('lists the new-file line numbers of added lines only', () => {
    const diff = [
      'diff --git a/x.test.ts b/x.test.ts',
      '--- a/x.test.ts',
      '+++ b/x.test.ts',
      '@@ -3,2 +3,4 @@',
      ' keep',
      '+one',
      '-gone',
      '+two',
      ' keep',
      '@@ -20 +22,2 @@',
      '+three',
      '+four',
    ].join('\n');
    expect([...addedLines(diff)]).toEqual([4, 5, 22, 23]);
  });
});

describe('splitDiffByFile', () => {
  it('keys each file diff by its new path', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '+x',
      'diff --git a/dir/b.test.ts b/dir/b.test.ts',
      '+++ b/dir/b.test.ts',
      '@@ -1 +1 @@',
      '+y',
    ].join('\n');
    const split = splitDiffByFile(diff);
    expect([...split.keys()]).toEqual(['a.ts', 'dir/b.test.ts']);
    expect(split.get('dir/b.test.ts')).toContain('+y');
    expect(split.get('dir/b.test.ts')).not.toContain('+x');
  });
});

describe('newTestCases', () => {
  it('keeps the cases whose first line a diff added, not a row added to a table', () => {
    const diff = [
      '+++ b/x.test.ts',
      '@@ -0,0 +17,3 @@',
      "+  test(`reads a ${'template'} name`, () => {",
      '+    x',
      '+  });',
    ].join('\n');
    expect(newTestCases(SOURCE, diff).map((c) => c.name)).toEqual(["reads a ${'template'} name"]);
    const rowOnly = ['+++ b/x.test.ts', '@@ -10,0 +12,1 @@', "+    ['two', 2],"].join('\n');
    expect(newTestCases(SOURCE, rowOnly)).toEqual([]);
  });
});

describe('valueCardOf', () => {
  it.each([
    ['none', 'feat: a\n\nbody', null],
    [
      'one line',
      'feat: a\n\nValue: protects=x; fails_when=y; why_new=z; no_claim=w',
      'Value: protects=x; fails_when=y; why_new=z; no_claim=w',
    ],
    [
      'wrapped, ends at a blank line',
      'feat: a\n\nValue: protects=x;\nfails_when=y;\n\nCo-Authored-By: Me',
      'Value: protects=x; fails_when=y;',
    ],
  ])('%s', (_name, message, expected) => {
    expect(valueCardOf(message)).toBe(expected);
  });
});

describe('localImportsOf', () => {
  it('lists relative import and export specifiers, not packages', () => {
    expect(localImportsOf(SOURCE)).toEqual(['./parse', '../shape/shape']);
    expect(
      localImportsOf("export * from './a.js';\nimport 'vitest';\nexport { b } from \"./b\";"),
    ).toEqual(['./a.js', './b']);
  });
});
