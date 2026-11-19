import { describe, expect, it } from 'vitest';
import type { DeclaredYourServer } from './your-mcp-entry';
import { shownEnvOf } from './your-mcp-hash';

const NO_EXTRAS = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
};

const stdio: DeclaredYourServer = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg'],
  env: { PATH: '/usr/bin', TOKEN: 'sk-one', NODE_OPTIONS: '', npm_config_registry: 'a' },
  envVars: [],
  cwd: null,
  codex: NO_EXTRAS,
};

const remote: DeclaredYourServer = {
  transport: 'http',
  url: 'https://mcp.example/mcp',
  headers: { Authorization: 'Bearer one' },
  envHeaders: {},
  bearerTokenVar: null,
  oauth: null,
  codex: NO_EXTRAS,
};

describe('shownEnvOf', () => {
  it('shownEnv holds PATH and not TOKEN', () => {
    expect(shownEnvOf(stdio)).toEqual([
      { name: 'NODE_OPTIONS', value: '' },
      { name: 'PATH', value: '/usr/bin' },
      { name: 'npm_config_registry', value: 'a' },
    ]);
    expect(shownEnvOf(remote)).toEqual([]);
  });
});
