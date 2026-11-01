import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createBareRepo,
  createThrowawayRepo,
  isolatedGitEnvironment,
  snapshotFiles,
  type BareRepo,
  type ThrowawayRepo,
} from './fixtures';
import { repoRoot } from './workspace';

// Git exports some of these to a hook so the hook's own git commands find the repository. Pushing
// from a linked worktree sets GIT_DIR to an absolute path, so any test or script the hook starts
// that runs `git -C <elsewhere>` acts on the contributor's checkout instead: one such run set
// core.bare=true and a fixture identity in the shared .git/config and moved a branch. Git's own
// list of the variables that tie it to one repository is the set no hook child may keep.
const REPO_VARIABLES = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  env: isolatedGitEnvironment(),
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const VITEST = resolve(repoRoot, 'node_modules/.bin/vitest');
const BIN = resolve(repoRoot, 'node_modules/.bin');
const SETUP = resolve(repoRoot, 'tests/git-isolation.setup.ts');

/** The part of a vitest project config this file checks. */
const ProjectTest = z.object({
  root: z.string().optional(),
  setupFiles: z.union([z.string(), z.array(z.string())]).default([]),
});
const InlineProject = z.object({ test: ProjectTest });
type InlineProject = z.infer<typeof InlineProject>;
const ProjectConfigModule = z.object({ default: InlineProject });
const RootConfigModule = z.object({
  default: z.object({
    test: z.object({ projects: z.array(z.union([z.string(), InlineProject])) }),
  }),
});

const ROOT_PROJECTS = RootConfigModule.parse(await import('../../../vitest.config')).default.test
  .projects;

function projectLabel(entry: string | InlineProject, index: number): string {
  return typeof entry === 'string' ? entry : `inline #${String(index)}`;
}

const asList = (files: string | string[]): string[] => (Array.isArray(files) ? files : [files]);

/** Setup files of an inline project, resolved like vitest: against its root, else the repo root. */
function inlineProject(entry: InlineProject): { setupFiles: string[]; root: string } {
  return {
    setupFiles: asList(entry.test.setupFiles),
    root: resolve(repoRoot, entry.test.root ?? '.'),
  };
}

/** Loads the config a path entry names: the file itself, or the vitest config in the directory. */
async function projectFromPath(entry: string): Promise<{ setupFiles: string[]; root: string }> {
  if (/[*?{[]/.test(entry)) throw new Error(`${entry} is a glob; list each project`);
  const target = resolve(repoRoot, entry);
  const file = statSync(target).isDirectory()
    ? globSync('{vitest,vite}.config.{ts,mts,cts,js,mjs,cjs}', { cwd: target })
        .sort((a, b) => Number(b.startsWith('vitest.')) - Number(a.startsWith('vitest.')))
        .map((name) => join(target, name))[0]
    : target;
  if (file === undefined) throw new Error(`${entry} has no vitest config`);
  const config = ProjectConfigModule.parse(await import(file)).default;
  return {
    setupFiles: asList(config.test.setupFiles),
    root: resolve(dirname(file), config.test.root ?? '.'),
  };
}

describe('git hook variables', () => {
  const cleanup: (ThrowawayRepo | BareRepo | string)[] = [];
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
    const origin = createBareRepo('10db-hook-env-origin');
    const worktree = mkdtempSync(join(tmpdir(), '10db-hook-env-worktree-'));
    const records = mkdtempSync(join(tmpdir(), '10db-hook-env-record-'));
    const record = join(records, 'env');
    cleanup.push(origin, worktree, records);
    cpSync(resolve(repoRoot, 'lefthook.yml'), join(repo.dir, 'lefthook.yml'));
    cpSync(resolve(repoRoot, 'scripts/hooks'), join(repo.dir, 'scripts/hooks'), {
      recursive: true,
    });
    // A stand-in make, first on PATH, that records the environment `make check` was given. It
    // needs no make installed, and the CI gate's container has none.
    const fakeMake = join(records, 'bin', 'make');
    mkdirSync(dirname(fakeMake));
    writeFileSync(fakeMake, '#!/bin/sh\n[ "$1" = check ] || exit 2\nenv > "$HOOK_ENV_RECORD"\n');
    chmodSync(fakeMake, 0o755);
    repo.git('add', 'lefthook.yml', 'scripts/hooks');
    repo.commit('chore(repo): init');
    repo.git('remote', 'add', 'origin', origin.dir);
    rmSync(worktree, { recursive: true });
    repo.git('worktree', 'add', '-q', '-b', 'feat/y', worktree);
    const env = {
      ...repo.env,
      PATH: [dirname(fakeMake), BIN, repo.env['PATH'] ?? ''].join(delimiter),
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
    // lefthook install and a real push through the hook: seconds of child processes, more under
    // the full suite's load than the 5s default allows.
  }, 60_000);

  it('cannot steer the daemon tests that create, commit to and configure repositories', () => {
    const { repo, variables } = decoy();
    const before = snapshotFiles(repo.dir);
    // Only the daemon tests that name git hook variables: the fixture helpers that create, commit
    // to and configure repositories, and the git module's own reads and writes. The rest of
    // git.test.ts and the watcher tests build a repository per case (about 1 s each, 80 s and
    // 26 s alone, 305 s for this test under the full gate's load) and say nothing about the
    // variables. This selection takes about 11 s.
    const run = spawnSync(
      VITEST,
      [
        'run',
        '--project',
        'daemon',
        'apps/daemon/test/fixtures.test.ts',
        'apps/daemon/src/git/git.test.ts',
        '-t',
        'git hook variables',
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

  // Every entry the root config runs, however it is written: a path to a directory or config file,
  // or an inline project. A glob is refused, since it could add a project nobody checked.
  it.each(ROOT_PROJECTS.map((entry, index) => ({ label: projectLabel(entry, index), entry })))(
    'project $label runs the git isolation setup before its own',
    async ({ entry }) => {
      const { setupFiles, root } =
        typeof entry === 'string' ? await projectFromPath(entry) : inlineProject(entry);
      expect(setupFiles.map((file) => resolve(root, file))[0]).toBe(SETUP);
    },
  );
});
