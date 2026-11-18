import { DEFAULT_HAZARDS, mintId, WHOLE_PROJECT_PAGE } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  bulkFoldKey,
  findClaimed,
  findForeignClaimWrites,
  findStrays,
  isAlwaysIgnored,
  isLefthookChecksum,
  isSensitivePath,
  changedConfigKeys,
  strayFoldKey,
} from './strays';

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
    ['.git/objects/ab/cdef', true],
    ['.git/refs/heads/main', true],
    ['.git/COMMIT_EDITMSG', true],
    ['.git/config', false],
    ['.git/hooks', false],
    ['.git/hooks/pre-commit', false],
    ['.git/info/exclude', false],
    ['.DS_Store', true],
    ['docs/.DS_Store', true],
    ['node_modules/react/index.js', false],
    ['src/node_modules/index.js', false],
    ['docs/.git/payload', false],
    ['src/git/index.ts', false],
    ['docs/node_modules.md', false],
  ])('%s → %s', (rel, expected) => {
    expect(isAlwaysIgnored(rel)).toBe(expected);
  });
});

describe('isSensitivePath', () => {
  it.each([
    ['.env', true],
    ['.env.local', true],
    ['apps/daemon/.env', true],
    ['.mcp.json', true],
    ['.claude/settings.local.json', true],
    ['.codex/config.toml', true],
    ['.git/config', true],
    ['.git/hooks/pre-commit', true],
    ['.git/info/exclude', true],
    ['.git/index', false],
    ['dist/x.js', false],
    ['docs/environment.md', false],
    ['.claude', true],
    ['.codex', true],
    ['.git/hooks', true],
    ['.git/info', true],
    ['.claudex', false],
    ['.git/information', false],
    ['.claude/.cc-writes', true],
    ['.claude/.cc-writes/settings.local.json.tmp', false],
    ['.claude/.cc-writesx', true],
    ['.claude/x/.cc-writes', true],
    ['.codex/.cc-writes', true],
    ['.claude/hooks/.claude/.cc-writes', true],
    ['.claude/hooks/.claude/.cc-writes/settings.local.json.tmp', false],
    ['.claude/hooks/.claude/settings.json', true],
    ['.claude/hooks/.claude/.cc-writesx', true],
  ])('%s → %s', (rel, expected) => {
    expect(isSensitivePath(rel)).toBe(expected);
  });
});

describe('findForeignClaimWrites', () => {
  const a = mintId('Workstream');
  const b = mintId('Workstream');
  const api = { kind: 'area' as const, name: 'api' };
  const ui = { kind: 'area' as const, name: 'ui' };
  it.each([
    [
      'inside an idle holder claim',
      ['src/ui/a.tsx'],
      [
        { id: a, running: true, claims: [api] },
        { id: b, running: false, claims: [ui] },
      ],
      [{ path: 'src/ui/a.tsx', holders: [b] }],
    ],
    [
      'inside a running holder claim',
      ['src/api/a.ts'],
      [
        { id: a, running: true, claims: [api] },
        { id: b, running: true, claims: [ui] },
      ],
      [],
    ],
    [
      'inside the only running claim',
      ['src/api/a.ts'],
      [{ id: a, running: true, claims: [api] }],
      [],
    ],
    ['inside an unclaimed area', ['README.md'], [{ id: a, running: true, claims: [api] }], []],
  ])('%s', (_name, paths, holders, expected) => {
    expect(findForeignClaimWrites(paths, project, holders)).toEqual(expected);
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

describe('findStrays in a pass of one', () => {
  const whole = { areas: [WHOLE_PROJECT_PAGE], hazards: [...DEFAULT_HAZARDS] };
  const page = [{ kind: 'area' as const, name: WHOLE_PROJECT_PAGE.name }];
  it.each([
    ['a source file with the whole page held', ['src/a.ts'], page, []],
    ['an unclaimed hazard’s file', ['package.json'], page, ['package.json']],
    [
      'a hazard file with its claim',
      ['package.json'],
      [...page, { kind: 'hazard' as const, name: 'deps' }],
      [],
    ],
  ])('%s', (_name, paths, claims, expected) => {
    expect(findStrays(paths, whole, claims)).toEqual(expected);
  });
});

describe('findClaimed', () => {
  it.each([
    [
      'inside a held area',
      ['src/api/a.ts', 'src/ui/a.tsx'],
      [{ kind: 'area' as const, name: 'api' }],
      ['src/api/a.ts'],
    ],
    ['in an area nobody holds', ['src/ui/a.tsx'], [{ kind: 'area' as const, name: 'api' }], []],
    ['outside every area', ['README.md'], [{ kind: 'area' as const, name: 'api' }], []],
    [
      'a hazard file with the hazard claim',
      ['package.json'],
      [{ kind: 'hazard' as const, name: 'deps' }],
      ['package.json'],
    ],
    [
      'a hazard file without the hazard claim',
      ['package.json'],
      [{ kind: 'area' as const, name: 'api' }],
      [],
    ],
    ['no claims at all', ['src/api/a.ts'], [], []],
  ])('%s', (_name, paths, claims, expected) => {
    expect(findClaimed(paths, project, claims)).toEqual(expected);
  });

  it('partitions the paths with findStrays, so no path is both or neither', () => {
    const paths = ['src/api/a.ts', 'src/ui/a.tsx', 'package.json', 'README.md'];
    const claims = [{ kind: 'area' as const, name: 'api' }];
    const claimed = findClaimed(paths, project, claims);
    const strays = findStrays(paths, project, claims);
    expect([...claimed, ...strays].sort()).toEqual([...paths].sort());
  });
});

describe('fold keys', () => {
  it('folds per path and per project', () => {
    const id = mintId('Project');
    expect(strayFoldKey(id, 'docs/a.md')).toBe(`stray-write:${id}:docs/a.md`);
    expect(bulkFoldKey(id)).toBe(`stray-write:${id}:bulk`);
  });
});

describe('isLefthookChecksum', () => {
  const sum = 'a'.repeat(32);
  it.each([
    [
      'the exact path with a hash and a timestamp',
      '.git/info/lefthook.checksum',
      `${sum} 1763400000\n`,
      true,
    ],
    ['no trailing newline', '.git/info/lefthook.checksum', `${sum} 1763400000`, true],
    ['another file in .git/info', '.git/info/exclude', `${sum} 1763400000\n`, false],
    [
      'the checksum name deeper down',
      '.git/info/x/lefthook.checksum',
      `${sum} 1763400000\n`,
      false,
    ],
    [
      'content that is a hook script',
      '.git/info/lefthook.checksum',
      '#!/bin/sh\nrm -rf ~\n',
      false,
    ],
    ['a 31 character hash', '.git/info/lefthook.checksum', `${'a'.repeat(31)} 1763400000\n`, false],
    ['an uppercase hash', '.git/info/lefthook.checksum', `${'A'.repeat(32)} 1763400000\n`, false],
    ['a second line', '.git/info/lefthook.checksum', `${sum} 1763400000\nmore\n`, false],
  ])('%s', (_name, rel, content, expected) => {
    expect(isLefthookChecksum(rel, content)).toBe(expected);
  });
});

describe('changedConfigKeys', () => {
  const config = (...pairs: [string, string][]) =>
    new Map(pairs.map(([k, v]) => [k, [v]] as const));
  const BASE: [string, string][] = [
    ['core.bare', 'false'],
    ['remote.origin.url', 'git@x:y.git'],
  ];
  const before = config(...BASE);
  it.each([
    [
      'a push -u',
      config(...BASE, ['branch.main.remote', 'origin'], ['branch.main.merge', 'refs/heads/main']),
      [],
    ],
    [
      'a worktree add',
      config(...BASE, ['extensions.worktreeconfig', 'true'], ['worktree.guessremote', 'true']),
      [],
    ],
    ['a branch name with dots', config(...BASE, ['branch.feat/a.b.remote', 'origin']), []],
    ['a hooks path', config(...BASE, ['core.hookspath', 'x']), ['core.hookspath']],
    [
      'a changed remote url',
      config(['core.bare', 'false'], ['remote.origin.url', 'evil']),
      ['remote.origin.url'],
    ],
    ['a removed key', config(['core.bare', 'false']), ['remote.origin.url']],
    [
      'a key branch has no name for',
      config(...BASE, ['branch.autosetupmerge', 'always']),
      ['branch.autosetupmerge'],
    ],
    [
      'bookkeeping beside a real change',
      config(...BASE, ['branch.m.remote', 'o'], ['alias.x', '!sh']),
      ['alias.x'],
    ],
  ])('%s', (_name, after, expected) => {
    expect(changedConfigKeys(before, after)).toEqual(expected);
  });
});
