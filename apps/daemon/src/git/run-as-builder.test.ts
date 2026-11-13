import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTempRepo,
  createTempRepoWithOrigin,
  FAKE_SRT,
  isolatedGitEnv,
  SANDBOXED,
} from '../../test/fixtures';
import { passGitCall } from '../guard';
import { silentLogger } from '../log';
import { createGateSandbox } from '../sandbox';
import { createGit } from './git';
import { runPassGit, type PassGitSandbox } from './run-as-builder';
import { resolveGit } from './version';

// A pass's commit, push or merge runs once the builder allows it, so nothing a lane could plant in
// the checkout (a repository of its own, a remote that is a path, a hook runner's config) may ride
// along outside the sandbox.
const env = {
  ...isolatedGitEnv(),
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  ANTHROPIC_API_KEY: 'sk-canary',
  AWS_BEARER_TOKEN_BEDROCK: 'bedrock-canary',
} as Record<string, string>;
const signal = new AbortController().signal;
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { env: isolatedGitEnv(), encoding: 'utf8' }).trim();

function callOf(command: string) {
  const call = passGitCall(command, 'main');
  if (call?.kind !== 'run') throw new Error(`${command} is not a call a pass runs`);
  return call;
}

// The daemon's own git, as `startDaemon` resolves it.
let bins = { git: 'git', gh: 'gh' };
/** The gate's sandbox, with srt's stand-in: what runs inside, never Seatbelt itself. */
let root: string;
let home: string;
beforeAll(async () => {
  bins = { git: await resolveGit(), gh: 'gh' };
  root = realpathSync(mkdtempSync('/tmp/sbp-'));
  home = join(root, 'home');
  for (const dir of ['home', 't', 'r', 'l']) mkdirSync(join(root, dir));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandboxFor(checkout: string): PassGitSandbox {
  const gitDirs = createGit();
  return {
    gate: createGateSandbox({
      home,
      dataDir: join(home, 'data'),
      loginConfigDir: null,
      tmpRoot: join(root, 't'),
      filesRoot: join(root, 'r'),
      codexLaneTempRoot: join(root, 'l'),
      gitDirs: (path) => gitDirs.gitDirs(path),
      systemPrefixes: [],
      runtime: FAKE_SRT,
      log: silentLogger,
    }),
    input: {
      project: { repoPath: checkout, sandboxLoopback: false, sandboxDocker: false },
      env,
      rules: [],
      checkouts: [checkout],
    },
    home,
  };
}

const runIn = (checkout: string, command: string, extraEnv: Record<string, string> = {}) =>
  runPassGit(callOf(command), {
    checkout,
    baseBranch: 'main',
    env: { ...env, ...extraEnv },
    signal,
    bins,
    sandbox: sandboxFor(checkout),
  });

describe.skipIf(SANDBOXED)('runPassGit', () => {
  it('runs no filter or diff driver a .gitattributes in the checkout names', async () => {
    const repo = createTempRepo();
    try {
      const marker = join(repo.path, '..', `filter-ran-${String(process.pid)}`);
      // The builder's config names a driver; the attributes file a lane wrote selects it.
      git(repo.path, 'config', 'filter.planted.clean', `sh -c 'touch "${marker}"; cat'`);
      git(repo.path, 'config', 'diff.planted.textconv', `sh -c 'touch "${marker}"; cat'`);
      writeFileSync(join(repo.path, '.gitattributes'), '* filter=planted diff=planted\n');
      writeFileSync(join(repo.path, 'README.md'), '# changed\n');
      const ran = await runIn(repo.path, 'git commit -am x');
      expect(ran).toMatchObject({ exitCode: 0 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it("commits in the checkout's own repository, whatever GIT_DIR the session carries", async () => {
    const repo = createTempRepo();
    const other = createTempRepo();
    try {
      writeFileSync(join(repo.path, 'page.ts'), 'export {};\n');
      git(repo.path, 'add', 'page.ts');
      const before = git(other.path, 'rev-parse', 'HEAD');
      const ran = await runIn(repo.path, "git commit -m 'Add the page'", {
        GIT_DIR: join(other.path, '.git'),
      });
      expect(ran).toMatchObject({ exitCode: 0 });
      expect(git(repo.path, 'log', '-1', '--format=%s')).toBe('Add the page');
      expect(git(other.path, 'rev-parse', 'HEAD')).toBe(before);
    } finally {
      repo.cleanup();
      other.cleanup();
    }
  });

  it('runs with fsmonitor off, so no program config names starts', async () => {
    const repo = createTempRepo();
    try {
      const marker = join(repo.path, '..', `fsmonitor-ran-${String(process.pid)}`);
      const script = join(repo.path, '.git', 'fsmonitor.sh');
      writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      git(repo.path, 'config', 'core.fsmonitor', script);
      const ran = await runIn(repo.path, 'git commit --allow-empty -m x');
      expect(ran).toMatchObject({ exitCode: 0 });
      expect(existsSync(marker)).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a checkout whose git dir names a common dir elsewhere', async () => {
    const repo = createTempRepo();
    const other = createTempRepo();
    try {
      writeFileSync(join(repo.path, '.git', 'commondir'), join(other.path, '.git'));
      const ran = await runIn(repo.path, 'git commit --allow-empty -m x');
      expect(ran).toEqual({
        refused:
          "This checkout's git dir shares its history with another one, so 10db won't run it.",
      });
    } finally {
      repo.cleanup();
      other.cleanup();
    }
  });

  it('refuses a checkout whose .git is a file naming a git dir elsewhere', async () => {
    const repo = createTempRepo();
    const other = createTempRepo();
    try {
      execFileSync('rm', ['-rf', join(repo.path, '.git')]);
      writeFileSync(join(repo.path, '.git'), `gitdir: ${join(other.path, '.git')}\n`);
      expect(await runIn(repo.path, 'git commit --allow-empty -m x')).toHaveProperty('refused');
      expect(git(other.path, 'log', '--format=%s')).toBe('Initial commit');
    } finally {
      repo.cleanup();
      other.cleanup();
    }
  });

  it('pushes a branch of its own to a listed remote', async () => {
    const remote = createTempRepoWithOrigin();
    try {
      git(remote.repo.path, 'switch', '-q', '-c', 'feat/page');
      git(remote.repo.path, 'commit', '--allow-empty', '-q', '-m', 'page');
      expect(await runIn(remote.repo.path, 'git push origin feat/page')).toMatchObject({
        exitCode: 0,
      });
      expect(git(remote.origin.path, 'rev-parse', 'feat/page')).toBe(
        git(remote.repo.path, 'rev-parse', 'HEAD'),
      );
    } finally {
      remote.cleanup();
    }
  });

  it('refuses a remote the checkout does not list, though a folder of that name is a repository', async () => {
    const remote = createTempRepoWithOrigin();
    try {
      const planted = join(remote.repo.path, 'evil');
      mkdirSync(planted);
      execFileSync('git', ['init', '-q', '--bare', planted], { env: isolatedGitEnv() });
      git(remote.repo.path, 'switch', '-q', '-c', 'feat/page');
      const ran = await runIn(remote.repo.path, 'git push evil feat/page');
      expect(ran).toHaveProperty('refused');
      expect(
        execFileSync('git', ['-C', planted, 'for-each-ref'], {
          env: isolatedGitEnv(),
          encoding: 'utf8',
        }),
      ).toBe('');
    } finally {
      remote.cleanup();
    }
  });

  it('refuses a push of HEAD while the current branch is main', async () => {
    const remote = createTempRepoWithOrigin();
    try {
      git(remote.repo.path, 'commit', '--allow-empty', '-q', '-m', 'local');
      const ran = await runIn(remote.repo.path, 'git push origin HEAD');
      expect(ran).toHaveProperty('refused');
      expect(git(remote.repo.path, 'rev-parse', 'origin/main')).not.toBe(
        git(remote.repo.path, 'rev-parse', 'HEAD'),
      );
    } finally {
      remote.cleanup();
    }
  });
  it('runs a commit inside the sandbox, its hooks with no account credential', async () => {
    const repo = createTempRepo();
    try {
      const seen = join(repo.path, 'hook-env.txt');
      writeFileSync(
        join(repo.path, '.git', 'hooks', 'pre-commit'),
        `#!/bin/sh\nenv > '${seen}'\n`,
        {
          mode: 0o755,
        },
      );
      const ran = await runIn(repo.path, 'git commit --allow-empty -m x');
      expect(ran).toMatchObject({ exitCode: 0 });
      // srt's stand-in says it ran the call: the commit went through the gate's sandbox.
      expect('output' in ran ? ran.output : '').toContain('fake srt');
      const hookEnv = readFileSync(seen, 'utf8');
      expect(hookEnv).not.toContain('sk-canary');
      expect(hookEnv).not.toContain('bedrock-canary');
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a commit where no sandbox can contain its hooks', async () => {
    const repo = createTempRepo();
    try {
      const before = git(repo.path, 'rev-parse', 'HEAD');
      const ran = await runPassGit(callOf('git commit --allow-empty -m x'), {
        checkout: repo.path,
        baseBranch: 'main',
        env,
        signal,
        bins,
        sandbox: null,
      });
      expect(ran).toHaveProperty('refused');
      expect(git(repo.path, 'rev-parse', 'HEAD')).toBe(before);
    } finally {
      repo.cleanup();
    }
  });

  it("runs none of the repository's hooks for a push, and hands git no account credential", async () => {
    const remote = createTempRepoWithOrigin();
    try {
      const hookRan = join(remote.repo.path, '..', `pre-push-ran-${String(process.pid)}`);
      writeFileSync(
        join(remote.repo.path, '.git', 'hooks', 'pre-push'),
        `#!/bin/sh\ntouch '${hookRan}'\n`,
        { mode: 0o755 },
      );
      git(remote.repo.path, 'switch', '-q', '-c', 'feat/page');
      expect(await runIn(remote.repo.path, 'git push origin feat/page')).toMatchObject({
        exitCode: 0,
      });
      expect(existsSync(hookRan)).toBe(false);
      // The builder's own config names a transport command; it sees the push's environment.
      const seen = join(remote.repo.path, '..', `push-env-${String(process.pid)}`);
      git(remote.repo.path, 'remote', 'add', 'far', 'ssh://example.invalid/x.git');
      git(remote.repo.path, 'config', 'core.sshCommand', `sh -c 'env > "${seen}"; exit 1' --`);
      await runIn(remote.repo.path, 'git push far feat/page');
      const pushEnv = readFileSync(seen, 'utf8');
      expect(pushEnv).toContain('GIT_TERMINAL_PROMPT=0');
      expect(pushEnv).not.toContain('sk-canary');
      expect(pushEnv).not.toContain('bedrock-canary');
    } finally {
      remote.cleanup();
    }
  });
});
