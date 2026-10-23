import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThrowawayRepo, isolatedGitEnvironment, snapshotFiles } from './fixtures';

describe('createThrowawayRepo', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ignores the contributor global git config, so signing and hooksPath never apply', () => {
    // A contributor following CONTRIBUTING sets commit.gpgsign globally; a signing program that
    // always fails turns any inherited setting into a failed commit. A global core.hooksPath
    // would run foreign hooks in every throwaway commit.
    const home = mkdtempSync(join(tmpdir(), '10db-fixture-home-'));
    cleanup.push(home);
    writeFileSync(
      join(home, '.gitconfig'),
      '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /usr/bin/false\n[core]\n\thooksPath = /nonexistent\n',
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'));
    const repo = createThrowawayRepo('10db-fixture');
    try {
      repo.stage('a.txt', 'a\n');
      repo.commit('chore(repo): first');
      expect(repo.gitOutput('log', '-1', '--format=%an <%ae>')).toBe('t <t@example.com>');
    } finally {
      repo.remove();
    }
  });

  it('builds its repository and a bare origin in place when git hook variables point elsewhere', () => {
    const decoy = createThrowawayRepo('10db-decoy');
    const origin = mkdtempSync(join(tmpdir(), '10db-fixture-origin-'));
    cleanup.push(decoy.dir, origin);
    // Its own identity, so a fixture that wrote its identity here would change the bytes.
    decoy.git('config', 'user.name', 'decoy owner');
    decoy.git('config', 'user.email', 'owner@decoy.invalid');
    decoy.stage('decoy.txt', 'the real repository\n');
    decoy.commit('chore(repo): decoy');
    const before = snapshotFiles(decoy.dir);
    const gitDir = join(decoy.dir, '.git');
    vi.stubEnv('GIT_DIR', gitDir);
    vi.stubEnv('GIT_WORK_TREE', decoy.dir);
    vi.stubEnv('GIT_INDEX_FILE', join(gitDir, 'index'));
    vi.stubEnv('GIT_COMMON_DIR', gitDir);
    let failure: unknown;
    let repo: ReturnType<typeof createThrowawayRepo> | undefined;
    try {
      repo = createThrowawayRepo('10db-fixture');
      cleanup.push(repo.dir);
      execFileSync('git', ['init', '-q', '--bare', origin], { env: repo.env });
      repo.stage('a.txt', 'a\n');
      repo.commit('chore(repo): first');
      repo.git('remote', 'add', 'origin', origin);
      repo.git('push', '-q', 'origin', 'feat/x');
    } catch (error) {
      failure = error;
    }
    vi.unstubAllEnvs();

    expect(snapshotFiles(decoy.dir)).toEqual(before);
    expect(failure).toBeUndefined();
    expect(repo?.gitOutput('config', 'core.bare')).toBe('false');
    const originLog = execFileSync('git', ['--git-dir', origin, 'log', '--format=%s', 'feat/x'], {
      env: isolatedGitEnvironment(),
      encoding: 'utf8',
    });
    expect(originLog.trim()).toBe('chore(repo): first');
  });

  it('lets a bare git commit work, with a local identity and no global one', () => {
    const repo = createThrowawayRepo('10db-fixture');
    try {
      repo.stage('a.txt', 'a\n');
      execFileSync('git', ['commit', '-q', '-m', 'chore(repo): bare'], {
        cwd: repo.dir,
        env: repo.env,
      });
      expect(repo.gitOutput('rev-list', '--count', 'HEAD')).toBe('1');
    } finally {
      repo.remove();
    }
  });
});
