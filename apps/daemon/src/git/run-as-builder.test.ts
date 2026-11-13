import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepo, createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import { passGitCall } from '../guard';
import { runPassGit } from './run-as-builder';

// A pass's commit, push or merge runs outside the sandbox once the builder allows it, so nothing a
// lane could plant in the checkout (a repository of its own, a remote that is a path) may ride along.
const env = { ...isolatedGitEnv(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' } as Record<
  string,
  string
>;
const signal = new AbortController().signal;
const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { env: isolatedGitEnv(), encoding: 'utf8' }).trim();

function callOf(command: string) {
  const call = passGitCall(command, 'main');
  if (call?.kind !== 'run') throw new Error(`${command} is not a call a pass runs`);
  return call;
}

const runIn = (checkout: string, command: string, extraEnv: Record<string, string> = {}) =>
  runPassGit(callOf(command), {
    checkout,
    baseBranch: 'main',
    env: { ...env, ...extraEnv },
    signal,
  });

describe('runPassGit', () => {
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
});
