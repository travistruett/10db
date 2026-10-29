import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { FolderRefusalReason, type FolderInspectResult, type ProjectDto } from '@10db/contracts';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  githubOrigin,
  isolatedGitEnv,
  tempDir,
} from '../../test/fixtures';
import { createGit, type GitTrustError } from '../git';
import { inspectFolder } from './inspect';

const cleanups: (() => void)[] = [];
let closeStore: () => void = () => undefined;
let seed: ReturnType<typeof createTestStore>['store'];
beforeEach(() => {
  const test = createTestStore();
  closeStore = test.close;
  seed = test.store;
});
afterEach(() => {
  closeStore();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const track = <T extends { cleanup(): void }>(dir: T): T => {
  cleanups.push(() => {
    dir.cleanup();
  });
  return dir;
};

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const gitIn = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { env: isolatedGitEnv(), stdio: 'pipe' })
    .toString()
    .trim();

/** Everything inspection must leave alone, read without refreshing the index. */
function snapshot(root: string) {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${entry.name}`;
      files.push(rel);
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
    }
  };
  walk(join(root, '.git'), '.git/');
  return {
    // The test's own status must not run a configured fsmonitor, or it would fake the marker.
    status: execFileSync(
      'git',
      ['-C', root, '-c', 'core.fsmonitor=false', 'status', '--porcelain'],
      {
        env: { ...isolatedGitEnv(), GIT_OPTIONAL_LOCKS: '0' },
      },
    ).toString(),
    config: readFileSync(join(root, '.git', 'config')),
    files: files.sort(),
  };
}

let cards: GitTrustError[];
beforeEach(() => {
  cards = [];
});
const git = () =>
  createGit({
    onRefused: (error) => {
      cards.push(error);
    },
  });

const project = (repoPath: string, name: string): ProjectDto =>
  seedProject(seed, { repoPath, name });

/** Inspects `path`; a checkout there must come out byte for byte as it went in, with no card raised. */
async function inspect(
  path: string,
  projects: readonly ProjectDto[] = [],
  protectedRoots: string[] = [],
) {
  const isCheckout = isDirectory(join(path, '.git'));
  const before = isCheckout ? snapshot(path) : null;
  const result = await inspectFolder({ git: git(), projects, protectedRoots }, path);
  if (before) expect(snapshot(path)).toEqual(before);
  expect(cards).toEqual([]);
  return result;
}

const READ_ONLY_SUBCOMMANDS = [
  'hash-object',
  'rev-parse',
  'for-each-ref',
  'symbolic-ref',
  'config',
];

/** The git subcommand of an argv: the first word that is not a `-c <config>` or `-C <dir>` pair. */
function subcommandOf(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-c' || argv[i] === '-C') i += 1;
    else return argv[i];
  }
  return undefined;
}

/** A git whose binary logs each argv, then runs the real git; a child process the project doesn't own. */
function loggingGit() {
  const dir = track(tempDir('logging-git'));
  const log = join(dir.path, 'calls.log');
  const bin = join(dir.path, 'git');
  writeFileSync(
    bin,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\0' "$a" >> '${log}'; done\nprintf '\\n' >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return {
    git: createGit({ bin }),
    calls: (): string[][] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => line.split('\0').slice(0, -1))
        : [],
  };
}

function accepted(result: FolderInspectResult) {
  if (!result.ok) throw new Error(`refused: ${result.reason}: ${result.message}`);
  return result.inspection;
}

describe('inspectFolder on a repository', () => {
  it('answers a root with a GitHub origin', async () => {
    const fixture = track(createTempRepoWithOrigin());
    const config = track(githubOrigin(fixture.repo.path, fixture.origin.path));
    expect(config.global).toBeTruthy();
    gitIn(fixture.repo.path, 'branch', 'feature');
    const got = accepted(await inspect(fixture.repo.path));
    expect(got).toEqual({
      root: realpathSync(fixture.repo.path),
      suggestedName: basename(realpathSync(fixture.repo.path)),
      branches: [
        { name: 'main', remote: true },
        { name: 'feature', remote: false },
      ],
      defaultBranch: 'main',
      github: 'acme/widgets',
      gateCandidates: [],
    });
  });

  it('answers a subfolder with the root', async () => {
    const repo = track(createTempRepo());
    mkdirSync(join(repo.path, 'src', 'deep'), { recursive: true });
    const got = accepted(await inspect(join(repo.path, 'src', 'deep')));
    expect(got.root).toBe(realpathSync(repo.path));
  });

  it('answers a path through a link with the real root', async () => {
    const repo = track(createTempRepo());
    const links = track(tempDir('links'));
    const link = join(links.path, 'alias');
    symlinkSync(repo.path, link);
    const got = accepted(await inspect(link));
    expect(got.root).toBe(realpathSync(repo.path));
  });

  it('answers no branches and no default for a repository with no commits', async () => {
    const dir = track(tempDir('unborn'));
    gitIn(dir.path, 'init', '-q', '-b', 'main');
    const got = accepted(await inspect(dir.path));
    expect(got.branches).toEqual([]);
    expect(got.defaultBranch).toBeNull();
  });

  it('answers local branches and no GitHub name for a repository with no remote', async () => {
    const repo = track(createTempRepo());
    gitIn(repo.path, 'branch', 'topic');
    const got = accepted(await inspect(repo.path));
    expect(got.github).toBeNull();
    expect(got.branches).toEqual([
      { name: 'main', remote: false },
      { name: 'topic', remote: false },
    ]);
    expect(got.defaultBranch).toBe('main');
  });

  it('answers no GitHub name for another host', async () => {
    const repo = track(createTempRepo());
    gitIn(repo.path, 'remote', 'add', 'origin', 'https://gitlab.com/acme/widgets.git');
    expect(accepted(await inspect(repo.path)).github).toBeNull();
  });

  it('takes the default branch from origin/HEAD when it is set', async () => {
    const fixture = track(createTempRepoWithOrigin());
    gitIn(fixture.repo.path, 'push', '-q', 'origin', 'main:trunk');
    gitIn(fixture.repo.path, 'fetch', '-q', 'origin');
    gitIn(fixture.repo.path, 'remote', 'set-head', 'origin', 'trunk');
    expect(accepted(await inspect(fixture.repo.path)).defaultBranch).toBe('trunk');
  });

  it('takes the current branch as the default when origin has no HEAD', async () => {
    const fixture = track(createTempRepoWithOrigin());
    gitIn(fixture.repo.path, 'switch', '-q', '-c', 'work');
    expect(accepted(await inspect(fixture.repo.path)).defaultBranch).toBe('work');
  });
});

describe('inspectFolder reads the folder safely', () => {
  it('runs only read-only git subcommands, each with hooks and fsmonitor off', async () => {
    const repo = track(createTempRepo());
    const spy = loggingGit();
    accepted(await inspectFolder({ git: spy.git, projects: [], protectedRoots: [] }, repo.path));
    const calls = spy.calls();
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv.join(' ')).toContain('-c core.fsmonitor=false -c core.hooksPath=/dev/null');
      expect(READ_ONLY_SUBCOMMANDS).toContain(subcommandOf(argv));
    }
  });

  it('refuses a gitfile that points elsewhere, with no card', async () => {
    const dir = track(tempDir('gitfile'));
    writeFileSync(join(dir.path, '.git'), 'gitdir: /nonexistent/elsewhere\n');
    const got = await inspect(dir.path);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe(FolderRefusalReason.Unreadable);
      expect(got.message).toContain('/nonexistent/elsewhere');
    }
  });

  it('reads candidates from a Makefile and package.json', async () => {
    const repo = track(createTempRepo());
    writeFileSync(join(repo.path, 'Makefile'), 'check:\n\ttrue\n');
    writeFileSync(
      join(repo.path, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, packageManager: 'pnpm@9.0.0' }),
    );
    const got = accepted(await inspect(repo.path));
    expect(got.gateCandidates).toEqual([
      { command: 'make check', source: 'makefile' },
      { command: 'pnpm test', source: 'package_json' },
    ]);
  });

  it('does not read a package.json that is a link to a file outside', async () => {
    const repo = track(createTempRepo());
    const outside = track(tempDir('outside'));
    const target = join(outside.path, 'package.json');
    writeFileSync(target, JSON.stringify({ scripts: { test: 'vitest' } }));
    symlinkSync(target, join(repo.path, 'package.json'));
    expect(accepted(await inspect(repo.path)).gateCandidates).toEqual([]);
  });

  it('does not read a package.json over 256 KiB', async () => {
    const repo = track(createTempRepo());
    const padding = 'x'.repeat(256 * 1024);
    writeFileSync(
      join(repo.path, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest' }, padding }),
    );
    expect(accepted(await inspect(repo.path)).gateCandidates).toEqual([]);
  });
});

describe('inspectFolder refusals', () => {
  it.each([
    { name: 'a registered checkout', project: true },
    { name: 'a folder under one', project: true, sub: 'src' },
    { name: 'a protected root', project: false },
    { name: 'a folder under a protected root', project: false, sub: 'src' },
  ])('asks git nothing about $name', async ({ project: isProject, sub }) => {
    const repo = track(createTempRepo());
    const path = sub === undefined ? repo.path : join(repo.path, sub);
    if (sub !== undefined) mkdirSync(path);
    const spy = loggingGit();
    const got = await inspectFolder(
      {
        git: spy.git,
        projects: isProject ? [project(realpathSync(repo.path), 'Widgets')] : [],
        protectedRoots: isProject ? [] : [repo.path],
      },
      path,
    );
    expect(got.ok).toBe(false);
    expect(spy.calls()).toEqual([]);
  });

  it('refuses a path with nothing at it', async () => {
    const dir = track(tempDir('missing'));
    const got = await inspect(join(dir.path, 'nope'));
    expect(got).toEqual({
      ok: false,
      reason: 'not_found',
      message: 'Nothing is at this path.',
    });
  });

  it('refuses a file', async () => {
    const dir = track(tempDir('file'));
    const file = join(dir.path, 'a.txt');
    writeFileSync(file, 'a');
    expect(await inspect(file)).toEqual({
      ok: false,
      reason: 'not_a_directory',
      message: 'This is a file, not a folder.',
    });
  });

  it('refuses a folder that is no repository', async () => {
    const dir = track(tempDir('plain'));
    expect(await inspect(dir.path)).toEqual({
      ok: false,
      reason: 'not_a_repository',
      message: "This folder isn't a git repository.",
    });
  });

  it('refuses a bare repository', async () => {
    const fixture = track(createTempRepoWithOrigin());
    expect(await inspect(fixture.origin.path)).toEqual({
      ok: false,
      reason: 'bare_repository',
      message: 'This is a bare repository; choose a checkout.',
    });
  });

  it('refuses a checkout that is already a project, naming it', async () => {
    const repo = track(createTempRepo());
    const known = project(realpathSync(repo.path), 'Widgets');
    expect(await inspect(repo.path, [known])).toEqual({
      ok: false,
      reason: 'already_a_project',
      message: 'Widgets is already a project.',
    });
  });

  it('refuses a folder inside a project', async () => {
    const outer = track(createTempRepo());
    const inner = join(outer.path, 'vendor', 'lib');
    mkdirSync(inner, { recursive: true });
    gitIn(inner, 'init', '-q', '-b', 'main');
    const known = project(realpathSync(outer.path), 'Outer');
    expect(await inspect(inner, [known])).toEqual({
      ok: false,
      reason: 'inside_a_project',
      message: 'This folder is inside Outer, which is already a project.',
    });
  });

  it('refuses a folder that contains a project', async () => {
    const outer = track(createTempRepo());
    const inner = join(outer.path, 'vendor', 'lib');
    mkdirSync(inner, { recursive: true });
    gitIn(inner, 'init', '-q', '-b', 'main');
    const known = project(realpathSync(inner), 'Inner');
    expect(await inspect(outer.path, [known])).toEqual({
      ok: false,
      reason: 'inside_a_project',
      message: 'This folder contains Inner, which is already a project.',
    });
  });

  it('refuses a repository at or under a protected root', async () => {
    const data = track(tempDir('data'));
    const nested = join(data.path, 'repo');
    mkdirSync(nested);
    gitIn(nested, 'init', '-q', '-b', 'main');
    const refused = {
      ok: false,
      reason: 'protected_path',
      message: '10db keeps its own files here; choose another folder.',
    };
    expect(await inspect(nested, [], [data.path])).toEqual(refused);
    expect(await inspect(nested, [], [nested])).toEqual(refused);
  });
});
