import { YourMcpSource } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { DeclaredYourServer } from './your-mcp-config';
import { shownEnvOf, yourMcpConfigHash } from './your-mcp-hash';

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

const claude = (server: DeclaredYourServer): string =>
  yourMcpConfigHash(YourMcpSource.ClaudeJson, server);

describe('yourMcpConfigHash', () => {
  it.each<[string, DeclaredYourServer, DeclaredYourServer, boolean]>([
    [
      'the same config hashes the same, map order aside',
      stdio,
      {
        ...stdio,
        env: { npm_config_registry: 'a', NODE_OPTIONS: '', TOKEN: 'sk-one', PATH: '/usr/bin' },
      },
      true,
    ],
    [
      'a changed TOKEN value doesn’t change the hash',
      stdio,
      { ...stdio, env: { ...stdio.env, TOKEN: 'sk-two' } },
      true,
    ],
    [
      'a changed value of a name ending _KEY doesn’t change the hash',
      { ...stdio, env: { ...stdio.env, STRIPE_KEY: 'a' } },
      { ...stdio, env: { ...stdio.env, STRIPE_KEY: 'b' } },
      true,
    ],
    [
      'a changed value of a name holding AUTH doesn’t change the hash',
      { ...stdio, env: { ...stdio.env, BASIC_AUTH: 'a' } },
      { ...stdio, env: { ...stdio.env, BASIC_AUTH: 'b' } },
      true,
    ],
    [
      'a changed URL with userinfo doesn’t change the hash',
      { ...stdio, env: { ...stdio.env, DB_URL: 'postgres://u:one@h/db' } },
      { ...stdio, env: { ...stdio.env, DB_URL: 'postgres://u:two@h/db' } },
      true,
    ],
    ...['GIT_ASKPASS', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'SSH_AUTH_SOCK', 'DEPLOY_CMD'].map(
      (name): [string, DeclaredYourServer, DeclaredYourServer, boolean] => [
        `a changed ${name} value does`,
        { ...stdio, env: { ...stdio.env, [name]: '/a/prog' } },
        { ...stdio, env: { ...stdio.env, [name]: '/b/prog' } },
        false,
      ],
    ),
    [
      'an @ after a ? is not userinfo, so it does not hash like the host after it',
      { ...stdio, env: { ...stdio.env, DB_URL: 'http://a.example?x@evil.example/' } },
      { ...stdio, env: { ...stdio.env, DB_URL: 'http://evil.example/' } },
      false,
    ],
    ...[
      'AUTHORITY_URL',
      'PASS_THROUGH_HOST',
      'AUTH_ENDPOINT',
      'PASSWORD_URI',
      'SIGNING_KEY_FILE',
      'KEY_SERVER',
      'KEY_VAULT_NAME',
    ].map((name): [string, DeclaredYourServer, DeclaredYourServer, boolean] => [
      `a changed ${name} value does`,
      { ...stdio, env: { ...stdio.env, [name]: 'https://one.example' } },
      { ...stdio, env: { ...stdio.env, [name]: 'https://two.example' } },
      false,
    ]),
    ...[
      'DB_PASSWORD',
      'AUTH_TOKEN',
      'MY_AUTH',
      'STRIPE_API_KEY',
      'DEPLOY_PAT',
      'SENTRY_DSN',
      'AWS_ACCESS_KEY_ID',
    ].map((name): [string, DeclaredYourServer, DeclaredYourServer, boolean] => [
      `a changed ${name} value doesn’t change the hash`,
      { ...stdio, env: { ...stdio.env, [name]: 'one' } },
      { ...stdio, env: { ...stdio.env, [name]: 'two' } },
      true,
    ]),
    [
      'a changed host in a URL with userinfo does',
      { ...stdio, env: { ...stdio.env, DB_URL: 'postgres://u:one@h1/db' } },
      { ...stdio, env: { ...stdio.env, DB_URL: 'postgres://u:one@h2/db' } },
      false,
    ],
    [
      'a changed NODE_OPTIONS value does',
      stdio,
      { ...stdio, env: { ...stdio.env, NODE_OPTIONS: '--require x' } },
      false,
    ],
    [
      'a changed PATH value does',
      stdio,
      { ...stdio, env: { ...stdio.env, PATH: '/opt/bin' } },
      false,
    ],
    [
      'a changed npm_config_registry value does',
      stdio,
      { ...stdio, env: { ...stdio.env, npm_config_registry: 'b' } },
      false,
    ],
    ['a new env name does', stdio, { ...stdio, env: { ...stdio.env, MORE: '1' } }, false],
    ['a changed arg does', stdio, { ...stdio, args: ['-y', 'other'] }, false],
    [
      'a changed header value doesn’t',
      remote,
      { ...remote, headers: { Authorization: 'Bearer two' } },
      true,
    ],
    [
      'a new header name does',
      remote,
      { ...remote, headers: { ...remote.headers, 'X-More': '1' } },
      false,
    ],
    ['an oauth block does', remote, { ...remote, oauth: { clientId: 'x' } }, false],
    [
      'a changed oauth callbackPort does',
      { ...remote, oauth: { clientId: 'x', callbackPort: 8080 } },
      { ...remote, oauth: { clientId: 'x', callbackPort: 9090 } },
      false,
    ],
  ])('%s', (_name, one, two, same) => {
    expect(claude(one) === claude(two)).toBe(same);
  });

  it('the source is part of it', () => {
    expect(claude(stdio)).not.toBe(yourMcpConfigHash(YourMcpSource.CodexConfig, stdio));
  });

  it('a remote server with no oauth block keeps the hash it had before oauth was read', () => {
    expect(claude(remote)).toBe('ae792cc356c3d085b003c157f6897d6fd6bd7d20fb2e07d07314c05e69a14cc1');
  });

  it('is 64 hex characters', () => {
    expect(claude(stdio)).toMatch(/^[0-9a-f]{64}$/);
  });
});

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
