import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isolatedGitEnv } from '../../test/fixtures';
import { GIT_REPO_ENV_VARS, withoutGitRepoEnv } from './index';

/** Git's local variables that carry config rather than name a repository. */
const CONFIG_VARS = ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];

describe('GIT_REPO_ENV_VARS', () => {
  it('covers every variable the installed git ties to one repository, except config', () => {
    const local = execFileSync('git', ['rev-parse', '--local-env-vars'], {
      encoding: 'utf8',
      env: isolatedGitEnv(),
    })
      .split('\n')
      .filter(Boolean);
    expect(local).toEqual(expect.arrayContaining(CONFIG_VARS));
    expect([...GIT_REPO_ENV_VARS].sort()).toEqual(
      local.filter((name) => !CONFIG_VARS.includes(name)).sort(),
    );
  });
});

describe('withoutGitRepoEnv', () => {
  it('drops the variables that name a repository and keeps git config and everything else', () => {
    expect(
      withoutGitRepoEnv({
        GIT_DIR: '/other/.git',
        GIT_INDEX_FILE: '/other/.git/index',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
        GIT_SSH_COMMAND: 'ssh -i key',
        PATH: '/usr/bin',
      }),
    ).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.git@github.com:.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_SSH_COMMAND: 'ssh -i key',
      PATH: '/usr/bin',
    });
  });
});
