import { describe, expect, it } from 'vitest';
import { SECRET_VARIABLES } from '../environment';
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

  it('keeps the version-manager, toolchain and lane variables on the allowlist', () => {
    const kept = [
      // Version managers.
      'NVM_DIR',
      'NVM_BIN',
      'NVM_INC',
      'VOLTA_HOME',
      'CARGO_HOME',
      'RUSTUP_HOME',
      'COREPACK_HOME',
      'npm_config_devdir',
      // Allowed prefixes whose names look like no secret.
      'MISE_SHELL',
      'pnpm_config_store_dir',
      'LC_ALL',
      // What a lane sets for its tools.
      'CLAUDE_CODE_TMPDIR',
      'GIT_CONFIG_GLOBAL',
      'GIT_OPTIONAL_LOCKS',
      'npm_config_cache',
      'UV_CACHE_DIR',
      'UV_TOOL_DIR',
      'UV_PYTHON_INSTALL_DIR',
      'TMPDIR',
      'GOPATH',
      'TENDB_SANDBOX',
      'xcrun_db',
    ];
    for (const name of kept) expect.soft(deniedEnvNames({ [name]: '/h/x' }), name).toEqual([]);
  });

  it('denies a secret-looking name even under an allowed prefix', () => {
    for (const name of [
      'MISE_GITHUB_TOKEN',
      'pnpm_config__authToken',
      'MISE_SECRET',
      'LC_PASSWORD',
      'pnpm_config_registry_cookie',
    ]) {
      expect.soft(deniedEnvNames({ [name]: 'v' }), name).toEqual([name]);
    }
  });

  it('denies the account variables to a sandboxed command', () => {
    for (const name of [
      ...SECRET_VARIABLES,
      'AWS_ACCESS_KEY_ID',
      'AWS_PROFILE',
      'AWS_SECRET_ACCESS_KEY',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect.soft(deniedEnvNames({ [name]: 'x' }), name).toEqual([name]);
    }
  });
});
