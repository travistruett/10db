import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { launchYourMcpServers, YourMcpServer } from '../sandbox';
import { claudeTakeoverMcp, codexTakeoverServers } from './takeover-servers';
import type { CodexServerExtras, YourSessionServer } from './types';

// Sessions spec §7.5: the servers a chat had, as each agent's terminal takes them. A header value goes to
// the sealed file, never into a command or a config entry.

const NONE: CodexServerExtras = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
};

let dir: TempDir | null = null;
let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dir?.cleanup();
  dir = null;
  dispose = null;
});

function stdio(): YourSessionServer {
  dir = tempDir('takeover-servers');
  const launched = launchYourMcpServers({
    home: dir.path,
    filesRoot: dir.path,
    laneWritable: [],
    servers: {
      mine: {
        command: 'npx',
        args: ['-y', 'pkg'],
        cwd: null,
        env: { PATH: '/usr/bin:/bin', TOKEN: 'sk-canary' },
        declaredEnv: ['TOKEN'],
      },
    },
  });
  dispose = () => {
    launched.dispose();
  };
  const connect = launched.servers['mine'];
  if (!(connect instanceof YourMcpServer)) throw new Error('the probe server was refused');
  return { connect, claudeOAuth: null, codex: NONE };
}

const remote = (headers: Record<string, string> | null): YourSessionServer => ({
  connect: { type: 'http', url: 'https://docs.example/mcp', headers },
  claudeOAuth: null,
  codex: { ...NONE, toolTimeoutSec: 30 },
});

describe('claudeTakeoverMcp', () => {
  it('lists the project servers, then the builder’s, and leaves out a name Claude Code would refuse', () => {
    const { servers, leftOut } = claudeTakeoverMcp({
      projectMcpServers: { docs: { type: 'http', url: 'https://p.example/mcp', headers: null } },
      yourMcpServers: { mine: stdio(), 'bad name; rm': remote(null) },
    });
    expect(Object.keys(servers)).toEqual(['docs', 'mine']);
    expect(servers['mine']).toMatchObject({ type: 'stdio', command: '/usr/bin/env' });
    expect(leftOut).toEqual(['bad name; rm']);
  });
});

describe('codexTakeoverServers', () => {
  it('turns a stdio server into its launch, and a remote one into header variables with the values sealed', () => {
    const { servers, sealed, leftOut } = codexTakeoverServers({
      projectMcpServers: {},
      yourMcpServers: { mine: stdio(), docs: remote({ 'X-Key': 'k-canary', Authorization: 'b' }) },
    });
    expect(leftOut).toEqual([]);
    expect(servers).toMatchObject([
      { kind: 'stdio', name: 'mine', command: '/usr/bin/env' },
      {
        kind: 'remote',
        name: 'docs',
        url: 'https://docs.example/mcp',
        headerVariables: [
          { header: 'X-Key', variable: 'TENDB_MCP_TOKEN_1_0' },
          { header: 'Authorization', variable: 'TENDB_MCP_TOKEN_1_1' },
        ],
        extras: { tool_timeout_sec: 30 },
      },
    ]);
    expect(sealed).toEqual([
      "export TENDB_MCP_TOKEN_1_0='k-canary'",
      "export TENDB_MCP_TOKEN_1_1='b'",
    ]);
    expect(JSON.stringify(servers)).not.toContain('k-canary');
  });

  it('leaves out a server whose header value could not be sealed', () => {
    const { servers, sealed, leftOut } = codexTakeoverServers({
      projectMcpServers: {},
      yourMcpServers: { docs: remote({ 'X-Key': 'a\0b' }) },
    });
    expect(servers).toEqual([]);
    expect(sealed).toEqual([]);
    expect(leftOut).toEqual(['docs']);
  });
});
