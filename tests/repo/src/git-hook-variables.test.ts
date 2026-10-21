import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createThrowawayRepo,
  isolatedGitEnvironment,
  snapshotFiles,
  type ThrowawayRepo,
} from './fixtures';
import { repoRoot } from './workspace';

// Git exports some of these to a hook so the hook's own git commands find the repository. Pushing
// from a linked worktree sets GIT_DIR to an absolute path, so any test or script the hook starts
// that runs `git -C <elsewhere>` acts on the contributor's checkout instead: one such run set
// core.bare=true and a fixture identity in the shared .git/config and moved a branch. Git's own
// list of the variables that tie it to one repository is the set no hook child may keep.
const REPO_VARIABLES = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const VITEST = resolve(repoRoot, 'node_modules/.bin/vitest');
const BIN = resolve(repoRoot, 'node_modules/.bin');
const SETUP = resolve(repoRoot, 'tests/git-isolation.setup.ts');

/** The part of a project's vitest config module this file checks. */
const ProjectConfigModule = z.object({
  default: z.object({ test: z.object({ setupFiles: z.array(z.string()).default([]) }) }),
});

describe('git hook variables', () => {
  const cleanup: (ThrowawayRepo | string)[] = [];
  afterEach(() => {
    for (const item of cleanup.splice(0)) {
      if (typeof item === 'string') rmSync(item, { recursive: true, force: true });
      else item.remove();
    }
  });

  /** A committed repository standing in for the contributor's checkout. */
  function decoy(): { repo: ThrowawayRepo; variables: Record<string, string> } {
    const repo = createThrowawayRepo('10db-decoy');
    cleanup.push(repo);
    repo.git('config', 'user.name', 'decoy owner');
    repo.git('config', 'user.email', 'owner@decoy.invalid');
    repo.stage('decoy.txt', 'the real repository\n');
    repo.commit('chore(repo): decoy');
    const gitDir = join(repo.dir, '.git');
    return {
      repo,
      variables: {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: repo.dir,
        GIT_INDEX_FILE: join(gitDir, 'index'),
        GIT_COMMON_DIR: gitDir,
      },
    };
  }

  it('never reach make check when pre-push runs from a linked worktree', () => {
    const repo = createThrowawayRepo('10db-hook-env');
    cleanup.push(repo);
    const origin = mkdtempSync(join(tmpdir(), '10db-hook-env-origin-'));
    const worktree = mkdtempSync(join(tmpdir(), '10db-hook-env-worktree-'));
    const records = mkdtempSync(join(tmpdir(), '10db-hook-env-record-'));
    const record = join(records, 'env');
    cleanup.push(origin, worktree, records);
    cpSync(resolve(repoRoot, 'lefthook.yml'), join(repo.dir, 'lefthook.yml'));
    cpSync(resolve(repoRoot, 'scripts/hooks'), join(repo.dir, 'scripts/hooks'), {
      recursive: true,
    });
    // A stand-in for make check that records the environment it was given.
    repo.stage('Makefile', 'check:\n\t@env > "$$HOOK_ENV_RECORD"\n');
    repo.git('add', 'lefthook.yml', 'scripts/hooks');
    repo.commit('chore(repo): init');
    repo.git('init', '-q', '--bare', origin);
    repo.git('remote', 'add', 'origin', origin);
    rmSync(worktree, { recursive: true });
    repo.git('worktree', 'add', '-q', '-b', 'feat/y', worktree);
    const env = {
      ...repo.env,
      PATH: `${BIN}${delimiter}${repo.env['PATH'] ?? ''}`,
      LEFTHOOK: '1',
      HOOK_ENV_RECORD: record,
    };
    const install = spawnSync(join(BIN, 'lefthook'), ['install', '--force'], {
      cwd: repo.dir,
      env,
      encoding: 'utf8',
    });
    expect(install.status, `${install.stdout}${install.stderr}`).toBe(0);

    // `-c` makes git export GIT_CONFIG_PARAMETERS to the hook as well.
    const push = spawnSync('git', ['-c', 'push.default=simple', 'push', '-q', 'origin', 'feat/y'], {
      cwd: worktree,
      env,
      encoding: 'utf8',
    });

    expect(push.status, `${push.stdout}${push.stderr}`).toBe(0);
    const names = readFileSync(record, 'utf8')
      .split('\n')
      .map((line) => line.split('=')[0]);
    expect(names).toContain('HOOK_ENV_RECORD');
    expect(names.filter((name) => REPO_VARIABLES.includes(name ?? ''))).toEqual([]);
  });

  it('cannot steer the daemon tests that create, commit to and configure repositories', () => {
    const { repo, variables } = decoy();
    const before = snapshotFiles(repo.dir);
    // The fixture helpers, the daemon's git module and a test that runs git with only a cwd.
    const run = spawnSync(
      VITEST,
      [
        'run',
        '--project',
        'daemon',
        'apps/daemon/test/fixtures.test.ts',
        'apps/daemon/src/git/git.test.ts',
        'apps/daemon/src/watcher/watcher.test.ts',
      ],
      {
        cwd: repoRoot,
        env: { ...isolatedGitEnvironment(), ...variables, NO_COLOR: '1' },
        encoding: 'utf8',
      },
    );
    expect(snapshotFiles(repo.dir)).toEqual(before);
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  }, 120_000);
});

describe('the test process environment', () => {
  it('holds no inherited GIT_* variable, and git reads neither system nor global config', () => {
    const names = Object.keys(process.env).filter((name) => name.startsWith('GIT_'));
    expect(names.sort()).toEqual(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']);
    expect(process.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect(readFileSync(process.env['GIT_CONFIG_GLOBAL'] ?? '', 'utf8')).toBe('');
  });

  it.each(globSync('{apps,packages,tests}/*/vitest.config.ts', { cwd: repoRoot }).sort())(
    '%s runs the git isolation setup before its own',
    async (path) => {
      const config = ProjectConfigModule.parse(await import(resolve(repoRoot, path))).default;
      const setupFiles = config.test.setupFiles.map((file) =>
        resolve(repoRoot, dirname(path), file),
      );
      expect(setupFiles[0]).toBe(SETUP);
    },
  );
});
