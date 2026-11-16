import { afterEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { launchYourMcpServers, YourMcpServer } from '../sandbox';
import { codexYourServers } from './codex-your-servers';
import type { CodexServerExtras, YourSessionServer } from './types';

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

function stdioServer(codex: CodexServerExtras = NONE): YourSessionServer {
  dir = tempDir('codex-your-servers');
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
  return { connect, claudeOAuth: null, codex };
}

const remote = (codex: CodexServerExtras = NONE): YourSessionServer => ({
  connect: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
  claudeOAuth: null,
  codex,
});

describe('codexYourServers', () => {
  it('adds your stdio server as its launch, with no env block', () => {
    const mine = stdioServer();
    const servers = codexYourServers({ yourMcpServers: { mine } });
    expect(servers['mine']).toMatchObject({
      command: '/usr/bin/env',
      default_tools_approval_mode: 'approve',
    });
    expect(servers['mine']).not.toHaveProperty('env');
    expect(JSON.stringify(servers)).not.toContain('sk-canary');
  });

  it('adds your http server with its headers and filters', () => {
    const docs = remote({
      enabledTools: ['read'],
      disabledTools: ['write'],
      startupTimeoutSec: 30,
      toolTimeoutSec: 120,
    });
    expect(codexYourServers({ yourMcpServers: { docs } })['docs']).toEqual({
      url: 'https://docs.example/mcp',
      http_headers: { 'X-Key': 'k' },
      default_tools_approval_mode: 'approve',
      enabled_tools: ['read'],
      disabled_tools: ['write'],
      startup_timeout_sec: 30,
      tool_timeout_sec: 120,
    });
  });

  it.each<{
    name: string;
    oauth: NonNullable<YourSessionServer['claudeOAuth']>;
    expected: Record<string, unknown>;
  }>([
    {
      name: 'client id, callback port and scopes map to Codex keys, and xaa is left out',
      oauth: { clientId: 'x', callbackPort: 9000, scopes: 'read write', xaa: true },
      expected: { oauth: { client_id: 'x', callback_port: 9000 }, scopes: ['read', 'write'] },
    },
    {
      name: 'scopes alone give no oauth block, and authServerMetadataUrl is left out',
      oauth: { scopes: ' read  write ', authServerMetadataUrl: 'https://idp.example/.well-known' },
      expected: { scopes: ['read', 'write'] },
    },
  ])('an oauth block: $name', ({ oauth, expected }) => {
    const server: YourSessionServer = {
      connect: { type: 'http', url: 'https://o.example/mcp', headers: null },
      claudeOAuth: oauth,
      codex: NONE,
    };
    expect(codexYourServers({ yourMcpServers: { o: server } })['o']).toEqual({
      url: 'https://o.example/mcp',
      default_tools_approval_mode: 'approve',
      ...expected,
    });
  });

  it('leaves out filters and timeouts that are not set, and headers that are null', () => {
    const plain: YourSessionServer = {
      connect: { type: 'sse', url: 'https://p.example/sse', headers: null },
      claudeOAuth: null,
      codex: NONE,
    };
    expect(codexYourServers({ yourMcpServers: { plain } })['plain']).toEqual({
      url: 'https://p.example/sse',
      default_tools_approval_mode: 'approve',
    });
  });
});
