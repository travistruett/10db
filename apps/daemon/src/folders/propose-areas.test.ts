import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AreaProposalResult,
  AreaProposalSource,
  DEFAULT_HAZARDS,
  type ProposedArea,
} from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempRepo, isolatedGitEnv, tempDir, type TempDir } from '../../test/fixtures';
import { createGit } from '../git';
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

/** A repository with `commits`, each a list of files to write and commit together. */
function repoWith(commits: readonly (readonly string[])[]): TempDir {
  const repo = track(createTempRepo());
  commits.forEach((paths, n) => {
    for (const path of paths) {
      mkdirSync(dirname(join(repo.path, path)), { recursive: true });
      writeFileSync(join(repo.path, path), `${path} ${String(n)}\n`);
    }
    gitIn(repo.path, 'add', ...paths);
    gitIn(repo.path, 'commit', '-q', '-m', `commit ${String(n)}`);
  });
  return repo;
}

const WORKSPACE = [
  [
    'package.json',
    'apps/api/package.json',
    'apps/api/src/a.ts',
    'apps/api/src/b.ts',
    'apps/web/package.json',
    'apps/web/src/a.tsx',
    'packages/ui/package.json',
    'packages/ui/src/a.tsx',
    'packages/ui/src/b.tsx',
  ],
];

const noModel: AreaNamer = () => Promise.reject(new Error('no model'));

const proposal = async (path: string, namer: AreaNamer = noModel) => {
  const result = await proposeAreas({ git: createGit(), namer, protectedRoots: [] }, path);
  expect(AreaProposalResult.safeParse(result).success).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.proposal;
};

const namesOf = (areas: readonly ProposedArea[]) => areas.map((a) => a.name).sort();

describe('proposeAreas without a model', () => {
  it('proposes the repository as its structure gives it, each area with globs and a reason', async () => {
    const repo = repoWith(WORKSPACE);
    const { areas, namedBy } = await proposal(repo.path);
    expect(namedBy).toBe(AreaProposalSource.Structure);
    expect(namesOf(areas)).toEqual(['api', 'root', 'ui', 'web']);
    const api = areas.find((a) => a.name === 'api');
    expect(api?.globs).toEqual(['apps/api/**']);
    for (const area of areas) {
      expect(area.reason).not.toBe('');
      expect(area.reason).not.toContain('\n');
    }
  });

  it('answers with a single area that holds everything for a repository with one file', async () => {
    const repo = track(createTempRepo());
    const { areas } = await proposal(repo.path);
    expect(areas).toHaveLength(1);
    expect(areas[0]?.globs).toContain('*');
  });

  it('names no area like a default hazard', async () => {
    const repo = repoWith([
      [
        'package.json',
        'packages/harness/package.json',
        'packages/harness/a.md',
        'packages/b/package.json',
      ],
    ]);
    const { areas } = await proposal(repo.path);
    const hazards = DEFAULT_HAZARDS.map((h) => h.name);
    expect(areas.map((a) => a.name).filter((n) => hazards.includes(n))).toEqual([]);
    expect(areas.some((a) => a.globs.includes('packages/harness/**'))).toBe(true);
  });

  it('merges folders that change together in the history', async () => {
    const together = Array.from({ length: 5 }, (_, n) => [
      `one/f${String(n)}.ts`,
      `two/f${String(n)}.ts`,
    ]);
    const repo = repoWith([
      [
        'package.json',
        'one/a.ts',
        'one/b.ts',
        'one/c.ts',
        'two/a.ts',
        'two/b.ts',
        'two/c.ts',
        'three/a.ts',
        'three/b.ts',
        'three/c.ts',
      ],
      ...together,
      ['three/a.ts'],
    ]);
    const { areas } = await proposal(repo.path);
    expect(areas).toHaveLength(3);
    const pair = areas.find((a) => a.globs.includes('one/**'));
    expect(pair?.globs).toContain('two/**');
  });

  it('refuses a folder that is not a git repository', async () => {
    const folder = track(tempDir('plain'));
    const result = await proposeAreas(
      { git: createGit(), namer: noModel, protectedRoots: [] },
      folder.path,
    );
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('git repository');
  });

  it('refuses a folder 10db keeps its own files in', async () => {
    const repo = repoWith(WORKSPACE);
    const result = await proposeAreas(
      { git: createGit(), namer: noModel, protectedRoots: [repo.path] },
      repo.path,
    );
    expect(result.ok).toBe(false);
  });
});

describe('proposeAreas with a model', () => {
  const answer =
    (value: unknown): AreaNamer =>
    () =>
      Promise.resolve(JSON.stringify(value));

  it('hands the model the candidates and uses its names, merges and reasons', async () => {
    const repo = repoWith(WORKSPACE);
    let prompt = '';
    const namer: AreaNamer = (text) => {
      prompt = text;
      return Promise.resolve(
        JSON.stringify({
          areas: [
            { name: 'backend', reason: 'The API service.', candidates: [1] },
            { name: 'frontend', reason: 'The web app.', candidates: [2] },
            { name: 'design-system', reason: 'Shared components.', candidates: [3] },
            { name: 'repo-config', reason: 'Top-level files.', candidates: [4] },
          ],
        }),
      );
    };
    const fromStructure = await proposal(repo.path);
    const { areas, namedBy } = await proposal(repo.path, namer);
    expect(namedBy).toBe(AreaProposalSource.Model);
    expect(prompt).toContain('apps/api');
    expect(prompt).toContain('packages/ui');
    expect(namesOf(areas)).toEqual(['backend', 'design-system', 'frontend', 'repo-config']);
    expect(areas.find((a) => a.name === 'backend')).toEqual({
      name: 'backend',
      reason: 'The API service.',
      globs: ['apps/api/**'],
    });
    expect(areas.flatMap((a) => a.globs).sort()).toEqual(
      fromStructure.areas.flatMap((a) => a.globs).sort(),
    );
  });

  it.each([
    ['text that is not JSON', () => Promise.resolve('Sure! Here are the areas.')],
    ['an answer of another shape', answer({ areas: 'none' })],
    ['a model that fails', () => Promise.reject(new Error('rate limited'))],
    [
      'a candidate left out',
      answer({ areas: [{ name: 'only', reason: 'One.', candidates: [1, 2, 3] }] }),
    ],
    [
      'a candidate in two areas',
      answer({
        areas: [
          { name: 'a', reason: 'A.', candidates: [1, 2, 3, 4] },
          { name: 'b', reason: 'B.', candidates: [4] },
        ],
      }),
    ],
    [
      'two packages merged',
      answer({ areas: [{ name: 'all', reason: 'Everything.', candidates: [1, 2, 3, 4] }] }),
    ],
    [
      'a name that is not lowercase words',
      answer({
        areas: [
          { name: 'The API', reason: 'A.', candidates: [1] },
          { name: 'web', reason: 'B.', candidates: [2] },
          { name: 'ui', reason: 'C.', candidates: [3] },
          { name: 'root', reason: 'D.', candidates: [4] },
        ],
      }),
    ],
    [
      'the same name twice',
      answer({
        areas: [
          { name: 'x', reason: 'A.', candidates: [1] },
          { name: 'x', reason: 'B.', candidates: [2] },
          { name: 'ui', reason: 'C.', candidates: [3] },
          { name: 'root', reason: 'D.', candidates: [4] },
        ],
      }),
    ],
  ])('falls back to the structure on %s', async (_, namer) => {
    const repo = repoWith(WORKSPACE);
    const { areas, namedBy } = await proposal(repo.path, namer);
    expect(namedBy).toBe(AreaProposalSource.Structure);
    expect(namesOf(areas)).toEqual(['api', 'root', 'ui', 'web']);
  });

  it('keeps a model area from taking a default hazard name', async () => {
    const repo = repoWith(WORKSPACE);
    const { areas } = await proposal(
      repo.path,
      answer({
        areas: [
          { name: 'harness', reason: 'A.', candidates: [1] },
          { name: 'web', reason: 'B.', candidates: [2] },
          { name: 'ui', reason: 'C.', candidates: [3] },
          { name: 'root', reason: 'D.', candidates: [4] },
        ],
      }),
    );
    expect(areas.map((a) => a.name)).not.toContain('harness');
    expect(areas.map((a) => a.name)).toContain('harness-area');
  });

  it('cuts a reason to one line', async () => {
    const repo = repoWith(WORKSPACE);
    const { areas } = await proposal(
      repo.path,
      answer({
        areas: [
          { name: 'api', reason: 'First line.\nSecond line.', candidates: [1] },
          { name: 'web', reason: 'B.', candidates: [2] },
          { name: 'ui', reason: 'C.', candidates: [3] },
          { name: 'root', reason: 'D.', candidates: [4] },
        ],
      }),
    );
    expect(areas.find((a) => a.name === 'api')?.reason).toBe('First line. Second line.');
  });
});

describe('proposeAreas runs nothing from the repository', () => {
  it('runs no hook, filter, pager, external diff or fsmonitor the repository configures', async () => {
    const repo = repoWith(WORKSPACE);
    writeFileSync(join(repo.path, '.gitattributes'), '* diff=evil filter=evil\n');
    gitIn(repo.path, 'add', '.gitattributes');
    gitIn(repo.path, 'commit', '-q', '-m', 'attributes');
    const marker = join(repo.path, '..', `ran-${String(Date.now())}`);
    const script = `sh -c 'touch ${marker}'`;
    // Configured last: the test's own git calls above must not trip the marker.
    for (const [key, value] of [
      ['core.fsmonitor', script],
      ['core.pager', script],
      ['core.hooksPath', '/nonexistent'],
      ['diff.external', script],
      ['core.sshCommand', script],
      ['log.showSignature', 'true'],
      ['gpg.program', script],
      ['alias.log', `!${script}`],
    ] as const)
      gitIn(repo.path, 'config', key, value);
    gitIn(repo.path, 'config', 'diff.evil.textconv', script);
    gitIn(repo.path, 'config', 'filter.evil.clean', script);
    expect(existsSync(marker)).toBe(false);
    await proposal(repo.path);
    expect(existsSync(marker)).toBe(false);
  });

  it('leaves the repository as it found it', async () => {
    const repo = repoWith(WORKSPACE);
    const before = gitIn(repo.path, '-c', 'core.fsmonitor=false', 'status', '--porcelain');
    const head = gitIn(repo.path, 'rev-parse', 'HEAD');
    await proposal(repo.path);
    expect(gitIn(repo.path, '-c', 'core.fsmonitor=false', 'status', '--porcelain')).toBe(before);
    expect(gitIn(repo.path, 'rev-parse', 'HEAD')).toBe(head);
  });
});
