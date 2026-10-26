import { describe, expect, it } from 'vitest';
import { deniedEnvNames } from './index';

describe('deniedEnvNames', () => {
  it('denies every name off the allowlist, sorted', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/h',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      GH_TOKEN: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      SSH_AUTH_SOCK: '/s',
      TENDB_X: '1',
      MISE_SHELL: 'zsh',
    };
    expect(deniedEnvNames(env)).toEqual([
      'AWS_SECRET_ACCESS_KEY',
      'GH_TOKEN',
      'SSH_AUTH_SOCK',
      'TENDB_X',
    ]);
  });

  it.each([
    'MISE_GITHUB_TOKEN',
    'pnpm_config__authToken',
    'MISE_SECRET',
    'LC_PASSWORD',
    'pnpm_config_registry_cookie',
  ])('denies %s: a secret-looking name is denied even under an allowed prefix', (name) => {
    expect(deniedEnvNames({ [name]: 'v' })).toEqual([name]);
  });

  it.each(['MISE_SHELL', 'pnpm_config_store_dir', 'LC_ALL'])('keeps %s', (name) => {
    expect(deniedEnvNames({ [name]: 'v' })).toEqual([]);
  });

  it.each([
    'CLAUDE_CODE_TMPDIR',
    'GIT_CONFIG_GLOBAL',
    'npm_config_cache',
    'pnpm_config_store_dir',
    'TMPDIR',
    'GOPATH',
  ])('keeps %s', (name) => {
    expect(deniedEnvNames({ [name]: 'v' })).toEqual([]);
  });
});
