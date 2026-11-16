import { describe, expect, it } from 'vitest';
import { changesTotals, parseChanges } from './changes-files';

const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -3,3 +3,3 @@ function f() {',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '@@ -20,1 +20,2 @@',
  ' x',
  '+y',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,1 @@',
  '+hello',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,1 +0,0 @@',
  '-bye',
  'diff --git a/old.ts b/moved.ts',
  'similarity index 90%',
  'rename from old.ts',
  'rename to moved.ts',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n');

describe('parseChanges', () => {
  const files = parseChanges(DIFF);
  it('reads each file with its status letter and path', () => {
    expect(files.map((f) => [f.status, f.path])).toEqual([
      ['M', 'src/a.ts'],
      ['A', 'src/new.ts'],
      ['D', 'src/gone.ts'],
      ['R', 'moved.ts'],
      ['M', 'logo.png'],
    ]);
  });
  it('rebuilds each hunk’s sides from its lines, with the starts the header gives', () => {
    expect(files[0]?.hunks).toEqual([
      {
        oldStart: 3,
        oldLines: 3,
        newStart: 3,
        newLines: 3,
        before: 'keep\nold\ntail\n',
        after: 'keep\nnew\ntail\n',
      },
      { oldStart: 20, oldLines: 1, newStart: 20, newLines: 2, before: 'x\n', after: 'x\ny\n' },
    ]);
    expect(files[1]?.hunks[0]).toMatchObject({ before: '', after: 'hello\n' });
    expect(files[3]?.hunks).toEqual([]);
  });
  it('is empty for an empty diff and ignores text before the first file', () => {
    expect(parseChanges('')).toEqual([]);
    expect(parseChanges('warning: junk\n')).toEqual([]);
  });
});

describe('parseChanges file headers', () => {
  const onePath = (header: string, extra: readonly string[] = []): string | undefined =>
    parseChanges(
      [header, ...extra, '--- a/x', '+++ b/x', '@@ -1,1 +1,1 @@', '-a', '+b', ''].join('\n'),
    )[0]?.path;
  it.each([
    {
      name: 'a quoted non-ASCII path (git quotes it as octal bytes)',
      header: 'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      path: 'café.ts',
    },
    {
      name: 'a quoted path with a tab and a quote',
      header: 'diff --git "a/a\\tb\\"c.ts" "b/a\\tb\\"c.ts"',
      path: 'a\tb"c.ts',
    },
    {
      name: 'a path that contains " b/"',
      header: 'diff --git a/dir b/file.ts b/dir b/file.ts',
      path: 'dir b/file.ts',
    },
    {
      name: 'a path with a space',
      header: 'diff --git a/my notes.md b/my notes.md',
      path: 'my notes.md',
    },
  ])('reads $name', ({ header, path }) => {
    expect(onePath(header)).toBe(path);
  });

  it('keeps a quoted file’s hunks with it, not with the file before', () => {
    const files = parseChanges(
      [
        'diff --git a/a.ts b/a.ts',
        '@@ -1,1 +1,1 @@',
        '-1',
        '+2',
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        '@@ -1,1 +1,1 @@',
        '-x',
        '+y',
        '',
      ].join('\n'),
    );
    expect(files.map((f) => [f.path, f.hunks.length])).toEqual([
      ['a.ts', 1],
      ['café.ts', 1],
    ]);
  });

  it('names a rename by its target, quoted or not', () => {
    expect(
      onePath('diff --git a/old.ts b/new.ts', ['rename from old.ts', 'rename to new.ts']),
    ).toBe('new.ts');
    expect(
      onePath('diff --git "a/o\\303\\251.ts" "b/n\\303\\251.ts"', [
        'rename from "o\\303\\251.ts"',
        'rename to "n\\303\\251.ts"',
      ]),
    ).toBe('né.ts');
  });
});

describe('changesTotals', () => {
  it('sums the files’ counts, ignoring a binary file’s missing ones', () => {
    expect(
      changesTotals([
        { path: 'a', added: 14, removed: 3 },
        { path: 'b', added: 25, removed: 0 },
        { path: 'c', added: null, removed: null },
      ]),
    ).toEqual({ files: 3, added: 39, removed: 3 });
  });
});
