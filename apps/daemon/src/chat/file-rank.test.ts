import { describe, expect, it } from 'vitest';
import { rankFiles } from './file-rank';

// Sessions spec §11: the `@` list matches the query as text, in order and case-insensitively, a file
// name before a folder, one run before a scattered match, the shorter path, then the alphabet.

const PATHS = [
  'src/blog/x.ts',
  'docs/catalog.md',
  'src/login.ts',
  'docs/a b.md',
  'src/[id].tsx',
  'src/é.ts',
  'README.md',
];

describe('rankFiles', () => {
  it.each([
    {
      name: 'a name match before a folder match, the shorter path first',
      query: 'log',
      paths: ['src/login.ts', 'docs/catalog.md', 'src/blog/x.ts'],
      matches: [[[4, 7]], [[9, 12]], [[5, 8]]],
    },
    {
      name: 'the same in capitals',
      query: 'LOG',
      paths: ['src/login.ts', 'docs/catalog.md', 'src/blog/x.ts'],
      matches: [[[4, 7]], [[9, 12]], [[5, 8]]],
    },
    { name: 'a space is text', query: 'a b', paths: ['docs/a b.md'], matches: [[[5, 8]]] },
    {
      name: 'brackets are text, not a pattern',
      query: '[id]',
      paths: ['src/[id].tsx'],
      matches: [[[4, 8]]],
    },
    { name: 'an accented letter', query: 'é', paths: ['src/é.ts'], matches: [[[4, 5]]] },
    { name: 'nothing matches', query: 'zzz', paths: [], matches: [] },
  ])('$name', ({ query, paths, matches }) => {
    const ranked = rankFiles(PATHS, query);
    expect(ranked.map((m) => m.path)).toEqual(paths);
    expect(ranked.map((m) => m.matches)).toEqual(matches);
  });

  it('an empty query lists the first 50 alphabetically', () => {
    const many = Array.from(
      { length: 60 },
      (_, i) => `f${String(i).padStart(2, '0')}.ts`,
    ).reverse();
    const ranked = rankFiles(many, '');
    expect(ranked).toHaveLength(50);
    expect(ranked[0]).toEqual({ path: 'f00.ts', matches: [] });
  });

  it('answers at most 50 matches', () => {
    const many = Array.from({ length: 60 }, (_, i) => `src/login${String(i)}.ts`);
    expect(rankFiles(many, 'login')).toHaveLength(50);
  });

  it('matches scattered letters in order, after one run', () => {
    expect(rankFiles(['src/lxoxg.ts', 'src/log.ts'], 'log').map((m) => m.path)).toEqual([
      'src/log.ts',
      'src/lxoxg.ts',
    ]);
    expect(rankFiles(['src/lxoxg.ts'], 'log')[0]?.matches).toEqual([
      [4, 5],
      [6, 7],
      [8, 9],
    ]);
  });
});
