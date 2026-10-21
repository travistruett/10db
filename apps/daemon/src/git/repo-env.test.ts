import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GIT_REPO_ENV_VARS, withoutGitRepoEnv } from './index';

describe('GIT_REPO_ENV_VARS', () => {
  it('covers every variable the installed git ties to one repository', () => {
    const local = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    expect(local.length).toBeGreaterThan(0);
    expect(GIT_REPO_ENV_VARS).toEqual(expect.arrayContaining(local));
  });
});

describe('withoutGitRepoEnv', () => {
  it('drops the repository variables and keeps the rest of the environment', () => {
    expect(
      withoutGitRepoEnv({
        GIT_DIR: '/other/.git',
        GIT_INDEX_FILE: '/other/.git/index',
        GIT_SSH_COMMAND: 'ssh -i key',
        PATH: '/usr/bin',
      }),
    ).toEqual({ GIT_SSH_COMMAND: 'ssh -i key', PATH: '/usr/bin' });
  });
});
