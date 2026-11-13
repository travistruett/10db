import { describe, expect, it } from 'vitest';
import { EDIT_LINES_CAP, hunksOfPatch, hunksOfTexts, type EditHunks } from './hunks';

/** `count` lines named `<prefix><n>` from 1, each ending in a newline. */
const lines = (prefix: string, count: number, from = 1): string =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(from + i)}\n`).join('');

const ten = lines('l', 10);
const tenChanged = ten.replace('l5\n', 'L5\n');

const oneChange: EditHunks = {
  hunks: [
    {
      oldStart: 2,
      oldLines: 7,
      newStart: 2,
      newLines: 7,
      before: 'l2\nl3\nl4\nl5\nl6\nl7\nl8',
      after: 'l2\nl3\nl4\nL5\nl6\nl7\nl8',
    },
  ],
  addedLines: 1,
  removedLines: 1,
  truncated: false,
};

describe('hunksOfTexts', () => {
  it('one line changed in the middle of ten', () => {
    expect(hunksOfTexts(ten, tenChanged)).toEqual(oneChange);
  });

  it('the same with the text starting at line 41', () => {
    const [hunk] = hunksOfTexts(ten, tenChanged, 41).hunks;
    expect(hunk).toMatchObject({ oldStart: 42, newStart: 42, oldLines: 7, newLines: 7 });
  });

  it('a new file', () => {
    expect(hunksOfTexts('', 'a\nb\nc\n')).toEqual({
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, before: '', after: 'a\nb\nc' }],
      addedLines: 3,
      removedLines: 0,
      truncated: false,
    });
  });

  it('no change', () => {
    expect(hunksOfTexts(ten, ten)).toEqual({
      hunks: [],
      addedLines: 0,
      removedLines: 0,
      truncated: false,
    });
  });

  it('1,600 added lines keep 1,500', () => {
    const result = hunksOfTexts('', lines('a', 1600));
    expect(result.addedLines).toBe(1600);
    expect(result.truncated).toBe(true);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.newLines).toBe(EDIT_LINES_CAP);
    expect(result.hunks[0]?.after.split('\n')).toHaveLength(EDIT_LINES_CAP);
  });

  it('two far-apart edits that cross the cap in the second', () => {
    const before = lines('l', 40);
    const after =
      lines('l', 9) +
      lines('n', 10, 10) +
      lines('l', 10, 20) +
      lines('m', 1600) +
      lines('l', 11, 30);
    const result = hunksOfTexts(before, after);
    expect(result.addedLines).toBe(1610);
    expect(result.removedLines).toBe(10);
    expect(result.truncated).toBe(true);
    expect(
      result.hunks.map(({ oldStart, oldLines, newStart, newLines }) => ({
        oldStart,
        oldLines,
        newStart,
        newLines,
      })),
    ).toEqual([
      { oldStart: 7, oldLines: 16, newStart: 7, newLines: 16 },
      // Three lines of context, then the added lines the cap leaves: 1,500 - 20.
      { oldStart: 27, oldLines: 3, newStart: 27, newLines: 1483 },
    ]);
    // The second hunk ends at its last kept change, with no trailing context.
    expect(result.hunks[1]?.after.split('\n').at(-1)).toBe('m1480');
  });

  it('two texts with no line in common, past the edit bound, show the new text as added', () => {
    const started = performance.now();
    const result = hunksOfTexts(lines('a', 6000), lines('b', 6000));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(result.truncated).toBe(true);
    expect(result.removedLines).toBe(6000);
    expect(result.addedLines).toBe(6000);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 0,
      newStart: 1,
      newLines: EDIT_LINES_CAP,
      before: '',
    });
    expect(result.hunks[0]?.after.split('\n').at(-1)).toBe('b1500');
  });
});

const TWO_HUNKS = [
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '@@ -10,3 +10,4 @@',
  ' j',
  ' k',
  '+k2',
  ' l',
  '',
].join('\n');

const twoHunks: EditHunks = {
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, before: 'a\nb\nc', after: 'a\nB\nc' },
    {
      oldStart: 10,
      oldLines: 3,
      newStart: 10,
      newLines: 4,
      before: 'j\nk\nl',
      after: 'j\nk\nk2\nl',
    },
  ],
  addedLines: 2,
  removedLines: 1,
  truncated: false,
};

describe('hunksOfPatch', () => {
  it.each<[string, string, EditHunks | null]>([
    ['a two-hunk diff with headers', `--- a/f.ts\n+++ b/f.ts\n${TWO_HUNKS}`, twoHunks],
    ['the same diff without headers', TWO_HUNKS, twoHunks],
    [
      'a diff ending with no newline at end of file',
      '@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n',
      {
        hunks: [
          { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, before: 'a\nb', after: 'a\nB' },
        ],
        addedLines: 1,
        removedLines: 1,
        truncated: false,
      },
    ],
    [
      'a line before the first hunk that no header explains',
      `rm -rf ~\n${TWO_HUNKS}`,
      { ...twoHunks, truncated: true },
    ],
    ['text that is no diff', 'export const a = 1;\n', null],
    ['a hunk header with nothing parseable after it', '@@ -x +y @@\n', null],
  ])('%s', (_name, patch, expected) => {
    expect(hunksOfPatch(patch)).toEqual(expected);
  });
});
