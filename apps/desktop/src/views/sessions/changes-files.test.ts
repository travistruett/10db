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
