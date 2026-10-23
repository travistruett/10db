import { describe, expect, it } from 'vitest';
import { buildNetworkEnv } from './index';

describe('buildNetworkEnv', () => {
  it("keeps the login environment's credentials and paths, and drops 10db's own and nested-session variables", () => {
    expect(
      buildNetworkEnv({
        PATH: '/opt/homebrew/bin:/usr/bin',
        HOME: '/Users/me',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GH_TOKEN: 'secret',
        TENDB_DATA_DIR: '/x',
        CLAUDECODE: '1',
        CLAUDE_PROJECT_DIR: '/y',
      }),
    ).toEqual({
      PATH: '/opt/homebrew/bin:/usr/bin',
      HOME: '/Users/me',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      GH_TOKEN: 'secret',
    });
  });
});
