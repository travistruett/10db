import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createThrowawayRepo } from './fixtures';

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
