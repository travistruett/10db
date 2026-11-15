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
  return { connect, codex };
}

const remote = (codex: CodexServerExtras = NONE): YourSessionServer => ({
  connect: { type: 'http', url: 'https://docs.example/mcp', headers: { 'X-Key': 'k' } },
  codex,
});

describe('codexYourServers', () => {
  it('adds your stdio server as its launch, with no env block', () => {
    const mine = stdioServer();
    const { servers } = codexYourServers({ yourMcpServers: { mine } }, { stdio: true });
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
    expect(codexYourServers({ yourMcpServers: { docs } }, { stdio: true }).servers['docs']).toEqual(
      {
        url: 'https://docs.example/mcp',
        http_headers: { 'X-Key': 'k' },
        default_tools_approval_mode: 'approve',
        enabled_tools: ['read'],
        disabled_tools: ['write'],
        startup_timeout_sec: 30,
        tool_timeout_sec: 120,
      },
    );
  });

  it('leaves out filters and timeouts that are not set, and headers that are null', () => {
    const plain: YourSessionServer = {
      connect: { type: 'sse', url: 'https://p.example/sse', headers: null },
      codex: NONE,
    };
    expect(
      codexYourServers({ yourMcpServers: { plain } }, { stdio: true }).servers['plain'],
    ).toEqual({ url: 'https://p.example/sse', default_tools_approval_mode: 'approve' });
  });

  it('with stdio off, leaves stdio servers out and names them', () => {
    const result = codexYourServers(
      { yourMcpServers: { mine: stdioServer(), docs: remote() } },
      { stdio: false },
    );
    expect(Object.keys(result.servers)).toEqual(['docs']);
    expect(result.leftOutStdio).toEqual(['mine']);
  });
});
