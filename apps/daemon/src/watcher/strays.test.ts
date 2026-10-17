import { DEFAULT_HAZARDS, mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { bulkFoldKey, findStrays, isAlwaysIgnored, strayFoldKey } from './strays';

const project = {
  areas: [
    { name: 'api', globs: ['src/api/**'] },
    { name: 'ui', globs: ['src/ui/**'] },
  ],
  hazards: [...DEFAULT_HAZARDS],
};

describe('isAlwaysIgnored', () => {
  it.each([
    ['.git/index', true],
    ['node_modules/react/index.js', true],
    ['apps/desktop/node_modules/x.js', true],
    ['src/git/index.ts', false],
    ['docs/node_modules.md', false],
  ])('%s → %s', (rel, expected) => {
    expect(isAlwaysIgnored(rel)).toBe(expected);
  });
});

describe('findStrays', () => {
  it.each([
    ['inside a held area', ['src/api/a.ts'], [{ kind: 'area' as const, name: 'api' }], []],
    [
      'in an area nobody holds',
      ['src/ui/a.tsx'],
      [{ kind: 'area' as const, name: 'api' }],
      ['src/ui/a.tsx'],
    ],
    ['outside every area', ['README.md'], [{ kind: 'area' as const, name: 'api' }], ['README.md']],
    [
      'a hazard file without the hazard claim',
      ['package.json'],
      [{ kind: 'area' as const, name: 'api' }],
      ['package.json'],
    ],
    [
      'a hazard file with the hazard claim',
      ['package.json'],
      [{ kind: 'hazard' as const, name: 'deps' }],
      [],
    ],
    ['no claims at all', ['src/api/a.ts'], [], ['src/api/a.ts']],
  ])('%s', (_name, paths, claims, expected) => {
    expect(findStrays(paths, project, claims)).toEqual(expected);
  });
});

describe('fold keys', () => {
  it('folds per path and per project', () => {
    const id = mintId('Project');
    expect(strayFoldKey(id, 'docs/a.md')).toBe(`stray-write:${id}:docs/a.md`);
    expect(bulkFoldKey(id)).toBe(`stray-write:${id}:bulk`);
  });
});
