import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HAZARDS, type AreaDef } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { classifyPath, judgeToolUse, protectedPaths } from './index';

const repo = tempDir('catch-all-repo');
beforeAll(() => {
  mkdirSync(join(repo.path, 'apps/api'), { recursive: true });
});
afterAll(() => {
  repo.cleanup();
});

// What a proposal makes of a repository: two units, and the rest of the top level.
const API: AreaDef = { name: 'api', globs: ['apps/api/**', 'apps/api/.*'] };
const WEB: AreaDef = { name: 'web', globs: ['apps/web/**'] };
const ROOT: AreaDef = { name: 'root', globs: ['*', '.*', 'docs/**'], catchAll: true };
const PROPOSED = [API, WEB, ROOT];

const areasOf = (path: string, areas: readonly AreaDef[] = PROPOSED) =>
  classifyPath(path, areas, []).areas;

describe('classifyPath with a catch-all area', () => {
  // The paths an ordinary area already holds are unchanged.
  it.each([
    ['apps/api/src/a.ts', ['api']],
    ['apps/api/.env', ['api']],
    ['apps/web/src/main.tsx', ['web']],
    ['apps/web/.env.example', ['web']],
    ['apps/api/.config/deep/.x', ['api']],
    ['README.md', ['root']],
    ['.gitignore', ['root']],
    ['docs/guide/a.md', ['root']],
  ])('keeps %s in %j', (path, expected) => {
    expect(areasOf(path)).toEqual(expected);
  });

  // The paths no area holds are the catch-all's.
  it.each([
    'packages/newpkg/src/index.ts',
    'apps/newapp/src/main.ts',
    'apps/newapp/.env.example',
    'tests/e2e/x.test.ts',
    'tools/release.ts',
    '.github/actions/x/.eslintrc.json',
    'a/.b/.c/d',
  ])('puts %s, which no other area holds, in the catch-all', (path) => {
    expect(areasOf(path)).toEqual(['root']);
  });

  it.each(['.git/config', '.git/hooks/pre-commit', '.git', 'sub/.git', 'a/.git/b'])(
    'keeps %s in no area, as the catch-all does not reach git internals',
    (path) => {
      expect(areasOf(path)).toEqual([]);
    },
  );

  it('never puts a path another area matches in a catch-all whose own globs match it', () => {
    const wide: AreaDef = {
      name: 'everything',
      globs: ['**', '**/.*', '**/.*/**'],
      catchAll: true,
    };
    const areas = [API, WEB, wide];
    expect(areasOf('apps/api/src/a.ts', areas)).toEqual(['api']);
    expect(areasOf('apps/web/x/.env', areas)).toEqual(['web']);
    expect(areasOf('apps/new/a.ts', areas)).toEqual(['everything']);
    expect(areasOf('.github/x.yml', areas)).toEqual(['everything']);
  });

  it('still lists every non-catch-all area that matches, and not the catch-all', () => {
    const overlap: AreaDef = { name: 'tests', globs: ['apps/api/test/**'] };
    expect(areasOf('apps/api/test/a.ts', [API, overlap, ROOT]).sort()).toEqual(['api', 'tests']);
  });

  it('puts every path in exactly one area when the other areas are disjoint', () => {
    const paths = [
      'apps/api/a.ts',
      'apps/web/a.ts',
      'apps/other/a.ts',
      'README.md',
      '.eslintrc',
      'x/y/z/.q',
      'docs/a.md',
      '.github/workflows/ci.yml',
    ];
    for (const path of paths) expect(areasOf(path), path).toHaveLength(1);
  });

  it('leaves hazards alone', () => {
    expect(classifyPath('tools/package.json', PROPOSED, DEFAULT_HAZARDS)).toEqual({
      areas: ['root'],
      hazards: ['deps'],
    });
    expect(classifyPath('apps/api/package.json', PROPOSED, DEFAULT_HAZARDS)).toEqual({
      areas: ['api'],
      hazards: ['deps'],
    });
  });

  it('treats catchAll: false as an ordinary area', () => {
    const plain: AreaDef = { ...ROOT, catchAll: false };
    expect(areasOf('tools/release.ts', [API, plain])).toEqual([]);
    expect(areasOf('README.md', [API, plain])).toEqual(['root']);
  });
});

describe('classifyPath with no catch-all', () => {
  const NONE = [API, WEB, { ...ROOT, catchAll: undefined }];

  it.each([
    ['apps/api/src/a.ts', ['api']],
    ['README.md', ['root']],
    ['tools/release.ts', []],
    ['packages/newpkg/src/index.ts', []],
    ['apps/web/.env.example', ['web']],
    ['.git/config', []],
  ])('classifies %s as %j, as it always did', (path, expected) => {
    expect(areasOf(path, NONE)).toEqual(expected);
    expect(areasOf(path, [API, WEB, { name: 'root', globs: ROOT.globs }])).toEqual(expected);
  });

  it('gives a project of one area over ** the same answers', () => {
    const one: AreaDef[] = [{ name: 'repo', globs: ['**', '**/.*', '**/.*/**'] }];
    expect(areasOf('tools/release.ts', one)).toEqual(['repo']);
    expect(areasOf('.git/config', one)).toEqual([]);
  });
});

describe('the guard in a project with a catch-all area', () => {
  const reasonOf = (verdict: ReturnType<typeof judgeToolUse>): string =>
    verdict.decision === 'deny' ? verdict.reason : '';

  const edit = (path: string, held: string[]) =>
    judgeToolUse({
      toolName: 'Edit',
      toolInput: { file_path: join(repo.path, path) },
      repoPath: repo.path,
      areas: PROPOSED,
      hazards: [],
      claims: held.map((name) => ({ kind: 'area' as const, name })),
      readOnly: false,
      protectedPaths: protectedPaths({
        dataDir: join(repo.path, '..', 'data'),
        home: homedir(),
        loginConfigDir: join(repo.path, '..', 'login'),
      }),
    });

  it.each(['packages/newpkg/src/index.ts', 'tools/release.ts', 'apps/newapp/.env.example'])(
    'lets a lane holding only the catch-all edit new %s',
    (path) => {
      expect(edit(path, ['root']).decision).toBe('allow');
    },
  );

  it.each(['packages/newpkg/src/index.ts', 'tools/release.ts', '.github/x/.eslintrc.json'])(
    'refuses new %s to a lane holding only another area',
    (path) => {
      const verdict = edit(path, ['api']);
      expect(verdict.decision).toBe('deny');
      expect(reasonOf(verdict)).toContain('it is in area "root"');
    },
  );

  it.each([
    ['apps/api/src/a.ts', 'api'],
    ['apps/web/src/main.tsx', 'web'],
    ['apps/api/.env', 'api'],
  ])('refuses %s to a lane holding only the catch-all, as %s holds it', (path, owner) => {
    const verdict = edit(path, ['root']);
    expect(verdict.decision).toBe('deny');
    expect(reasonOf(verdict)).toContain(`it is in area "${owner}"`);
  });

  it('lets a lane edit a file in the area it holds', () => {
    expect(edit('apps/api/src/a.ts', ['api']).decision).toBe('allow');
  });

  it('still refuses .git to a lane holding the catch-all', () => {
    expect(edit('.git/hooks/pre-commit', ['root', 'api', 'web']).decision).toBe('deny');
  });
});
