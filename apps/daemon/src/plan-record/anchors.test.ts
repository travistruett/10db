import { describe, expect, it } from 'vitest';
import { locateAnchor } from './anchors';

/** A file of `n` numbered filler lines. */
const filler = (n: number, from = 1): string[] =>
  Array.from({ length: n }, (_, i) => `filler ${String(from + i)}`);

const EXCERPT = 'const pack = build();\nemit(pack);';

/** A file with the excerpt's two lines starting at `at` (1-based) among `total` lines. */
function fileWith(at: number, total: number): string {
  const out = filler(total);
  out.splice(at - 1, 2, 'const pack = build();', 'emit(pack);');
  return out.join('\n');
}

describe('locateAnchor', () => {
  it.each([
    ['found at its line is current', fileWith(18, 40), 18, { result: 'current', line: 18 }],
    [
      'three lines inserted above is moved to line+3',
      fileWith(21, 40),
      18,
      { result: 'moved', line: 21 },
    ],
    ['found 200 lines away is moved', fileWith(218, 300), 18, { result: 'moved', line: 218 }],
    ['found 201 lines away is changed', fileWith(219, 300), 18, { result: 'changed', line: null }],
    [
      'an edited excerpt line is changed',
      fileWith(18, 40).replace('emit(pack);', 'emit(pack, now);'),
      18,
      { result: 'changed', line: null },
    ],
    [
      "trailing spaces don't matter",
      fileWith(18, 40).replace('emit(pack);', 'emit(pack);  \r'),
      18,
      { result: 'current', line: 18 },
    ],
    ['an empty file is changed', '', 18, { result: 'changed', line: null }],
  ] as const)('%s', (_, file, line, expected) => {
    expect(locateAnchor(file, { line, excerpt: EXCERPT })).toEqual(expected);
  });

  it('an excerpt ending in a newline is current at its line', () => {
    expect(locateAnchor(fileWith(18, 40), { line: 18, excerpt: `${EXCERPT}\n` })).toEqual({
      result: 'current',
      line: 18,
    });
  });

  it('two matches pick the nearest', () => {
    const out = filler(100);
    out.splice(9, 2, 'const pack = build();', 'emit(pack);');
    out.splice(59, 2, 'const pack = build();', 'emit(pack);');
    expect(locateAnchor(out.join('\n'), { line: 50, excerpt: EXCERPT })).toEqual({
      result: 'moved',
      line: 60,
    });
  });

  it('an equal tie picks the earlier', () => {
    const out = filler(100);
    out.splice(39, 2, 'const pack = build();', 'emit(pack);');
    out.splice(59, 2, 'const pack = build();', 'emit(pack);');
    expect(locateAnchor(out.join('\n'), { line: 50, excerpt: EXCERPT })).toEqual({
      result: 'moved',
      line: 40,
    });
  });

  it('a 3-line excerpt must match all three lines in order', () => {
    const excerpt = 'a();\nb();\nc();';
    const inOrder = [...filler(17), 'a();', 'b();', 'c();', ...filler(5, 21)].join('\n');
    const swapped = [...filler(17), 'a();', 'c();', 'b();', ...filler(5, 21)].join('\n');
    const twoOfThree = [...filler(17), 'a();', 'b();', ...filler(5, 20)].join('\n');
    expect(locateAnchor(inOrder, { line: 18, excerpt })).toEqual({ result: 'current', line: 18 });
    expect(locateAnchor(swapped, { line: 18, excerpt })).toEqual({ result: 'changed', line: null });
    expect(locateAnchor(twoOfThree, { line: 18, excerpt })).toEqual({
      result: 'changed',
      line: null,
    });
  });
});
