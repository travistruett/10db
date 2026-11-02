import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AreaProposal, ProjectInput, type ProposedArea } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
import { classifyPath } from '../guard';
import { proposeAreas, type AreaNamer } from './propose-areas';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const track = (dir: TempDir): TempDir => {
  cleanups.push(() => {
    dir.cleanup();
  });
  return dir;
};

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** A repository with one commit holding `paths`. */
function repoWith(paths: readonly string[]): TempDir {
  const repo = track(createTempRepo());
  for (const path of paths) {
    mkdirSync(dirname(join(repo.path, path)), { recursive: true });
    writeFileSync(join(repo.path, path), `${path}\n`);
  }
  gitIn(repo.path, 'add', ...paths);
  gitIn(repo.path, 'commit', '-q', '-m', 'files');
  return repo;
}

const WORKSPACE = [
  'package.json',
  'apps/api/package.json',
  'apps/api/src/a.ts',
  'apps/api/src/b.ts',
  'apps/web/package.json',
  'apps/web/src/a.tsx',
  'packages/ui/package.json',
  'packages/ui/src/a.tsx',
  'packages/ui/src/b.tsx',
];
const NO_TOP = [
  'packages/a/package.json',
  'packages/a/x.ts',
  'packages/b/package.json',
  'packages/b/y.ts',
];

/** Files a task could add that no file of the proposal's repository stands for. */
const NEW_FILES = [
  'packages/newpkg/src/index.ts',
  'apps/newapp/src/main.ts',
  'tests/e2e/x.test.ts',
  'tools/release.ts',
  'apps/api/.env.example',
  'apps/newapp/.env.example',
  '.github/actions/x/.eslintrc.json',
  '.editorconfig',
  'CHANGELOG.md',
  'docs/a/b/c.md',
];

const noModel: AreaNamer = () => Promise.reject(new Error('no model'));

async function proposed(path: string, namer: AreaNamer = noModel): Promise<ProposedArea[]> {
  const result = await proposeAreas({ git: createGit(), namer, protectedRoots: [] }, path);
  if (!result.ok) throw new Error(result.message);
  expect(AreaProposal.safeParse(result.proposal).success).toBe(true);
  return result.proposal.areas;
}

const areasOf = (path: string, areas: readonly ProposedArea[]) =>
  classifyPath(path, areas, []).areas;

describe('the catch-all of a proposal', () => {
  it.each([
    ['a workspace', WORKSPACE],
    ['a repository with no file at its top', NO_TOP],
    ['a repository of one file', ['README.md']],
  ])('marks exactly one area in %s', async (_, paths) => {
    const areas = await proposed(repoWith(paths).path);
    expect(areas.filter((a) => a.catchAll === true)).toHaveLength(1);
  });

  it('marks the area that holds the top of the repository', async () => {
    const areas = await proposed(repoWith(WORKSPACE).path);
    const rest = areas.find((a) => a.catchAll === true);
    expect(rest?.name).toBe('root');
    expect(rest?.globs).toContain('*');
    expect(areas.filter((a) => a.name !== 'root').every((a) => a.catchAll !== true)).toBe(true);
  });

  it.each([
    ['a workspace', WORKSPACE],
    ['a repository with no file at its top', NO_TOP],
    ['a repository of one file', ['README.md']],
  ])('puts a file added later in exactly one area of %s', async (_, paths) => {
    const areas = await proposed(repoWith(paths).path);
    for (const file of NEW_FILES) expect(areasOf(file, areas), file).toHaveLength(1);
  });

  it('puts a file in a new package in the catch-all, and one in an existing package in its area', async () => {
    const areas = await proposed(repoWith(WORKSPACE).path);
    const rest = areas.find((a) => a.catchAll === true)?.name;
    expect(areasOf('packages/newpkg/src/index.ts', areas)).toEqual([rest]);
    expect(areasOf('apps/api/src/new.ts', areas)).toEqual(['api']);
    expect(areasOf('apps/api/src/.env', areas)).toEqual(['api']);
  });

  it('never puts a tracked file another area matches in the catch-all', async () => {
    const areas = await proposed(repoWith(WORKSPACE).path);
    for (const file of WORKSPACE) {
      const owners = areasOf(file, areas);
      expect(owners, file).toHaveLength(1);
    }
    expect(areasOf('apps/web/src/a.tsx', areas)).toEqual(['web']);
    expect(areasOf('packages/ui/src/b.tsx', areas)).toEqual(['ui']);
  });

  it('marks the area a model merges the rest into, and only that one', async () => {
    const namer: AreaNamer = () =>
      Promise.resolve(
        JSON.stringify({
          areas: [
            { name: 'backend', reason: 'The API.', candidates: [1] },
            { name: 'frontend', reason: 'The web app.', candidates: [2] },
            { name: 'shared', reason: 'Shared components and the top.', candidates: [3, 4] },
          ],
        }),
      );
    const areas = await proposed(repoWith(WORKSPACE).path, namer);
    expect(areas.filter((a) => a.catchAll === true).map((a) => a.name)).toEqual(['shared']);
    expect(areasOf('tools/release.ts', areas)).toEqual(['shared']);
    expect(areasOf('apps/api/src/a.ts', areas)).toEqual(['backend']);
  });

  it('is accepted whole by a project', async () => {
    const areas = await proposed(repoWith(WORKSPACE).path);
    const project = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas,
    });
    expect(project.success).toBe(true);
  });

  it('is not marked in the one area a repository with no commit gets, which already holds every file', async () => {
    const repo = track(tempDir('empty'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo.path], {
      env: isolatedGitEnv(),
      stdio: 'pipe',
    });
    const areas = await proposed(repo.path);
    expect(areas).toHaveLength(1);
    expect(areas[0]).not.toHaveProperty('catchAll');
  });
});
