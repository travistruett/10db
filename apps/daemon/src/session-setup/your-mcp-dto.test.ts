import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRUST_DEFAULTS,
  YourMcpServerState,
  YourMcpSource,
  yourMcpServerKey,
  type YourMcpServerKey,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { laneWritableRoots } from '../sandbox';
import { yourMcpServerDtos } from './your-mcp-dto';
import type { DeclaredYourServer, YourMcpEntry } from './your-mcp-entry';
import { yourMcpConfigHash } from './your-mcp-hash';

let root: TempDir;
let home: string;
let checkout: string;
beforeEach(() => {
  root = tempDir('your-mcp-dto');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  mkdirSync(home);
  mkdirSync(checkout);
});
afterEach(() => {
  root.cleanup();
});

const NONE = {
  enabledTools: null,
  disabledTools: [],
  startupTimeoutSec: null,
  toolTimeoutSec: null,
};

function entry(
  name: string,
  declared: DeclaredYourServer,
  over: Partial<YourMcpEntry> = {},
): YourMcpEntry {
  return {
    key: yourMcpServerKey(YourMcpSource.ClaudeJson, name),
    name,
    source: YourMcpSource.ClaudeJson,
    pluginId: null,
    declared,
    configHash: yourMcpConfigHash(YourMcpSource.ClaudeJson, declared),
    enabledInSource: true,
    refusal: null,
    ...over,
  };
}

const stdio = (
  over: Partial<Extract<DeclaredYourServer, { transport: 'stdio' }>> = {},
): DeclaredYourServer => ({
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg'],
  env: {},
  envVars: [],
  cwd: null,
  codex: NONE,
  ...over,
});

const roots = () =>
  laneWritableRoots({
    checkouts: [checkout],
    worktreeBase: join(root.path, 'worktrees'),
    sandboxTempRoots: [],
    systemTempRoots: [],
  });

const dtos = (
  entries: YourMcpEntry[],
  approvals: ReadonlyMap<YourMcpServerKey, string> = new Map(),
  switches = TRUST_DEFAULTS,
) =>
  yourMcpServerDtos({
    entries,
    switches,
    approvals,
    home,
    laneWritable: roots(),
  });

describe('yourMcpServerDtos', () => {
  it('a new server lists its hashed values and no secret', () => {
    const github = entry(
      'github',
      stdio({ env: { TOKEN: 'sk-canary', PATH: '/usr/bin' }, args: ['-y', 'gh'] }),
    );
    const [dto] = dtos([github]);
    expect(dto).toMatchObject({
      state: YourMcpServerState.New,
      on: false,
      envNames: ['PATH', 'TOKEN'],
      shownEnv: [{ name: 'PATH', value: '/usr/bin' }],
      configHash: github.configHash,
    });
    expect(JSON.stringify(dto)).not.toContain('sk-canary');
  });

  it('an approved server is on unless switched off here or off in its source', () => {
    const a = entry('a', stdio());
    const b = entry('b', stdio(), { enabledInSource: false });
    const approvals = new Map([a, b].map((e) => [e.key, e.configHash ?? '']));
    expect(dtos([a, b], approvals).map((d) => [d.state, d.on])).toEqual([
      ['approved', true],
      ['approved', false],
    ]);
    const off = { ...TRUST_DEFAULTS, mcpServers: { [a.key]: false, [b.key]: true } };
    expect(dtos([a, b], approvals, off).map((d) => d.on)).toEqual([false, true]);
  });

  it('a changed server shows Changed', () => {
    const a = entry('a', stdio());
    expect(dtos([a], new Map([[a.key, 'f'.repeat(64)]]))[0]?.state).toBe('changed');
  });

  it('an entry that did not parse is left out with its reason and no transport', () => {
    const [dto] = dtos([
      entry('broken', stdio(), {
        declared: null,
        configHash: null,
        refusal: 'It can’t be read: command',
      }),
    ]);
    expect(dto).toMatchObject({
      state: 'left_out',
      transport: null,
      configHash: null,
      reason: 'It can’t be read: command',
      on: false,
    });
  });

  it('a server whose command is in a checkout is left out with its reason', () => {
    const [dto] = dtos([entry('local', stdio({ command: join(checkout, 'server.js') }))]);
    expect(dto?.state).toBe('left_out');
    expect(dto?.reason).toContain("Its command points at a project's folder");
  });

  it('a remote server with no headers says so, and one with a bearer variable does not', () => {
    const plain: DeclaredYourServer = {
      transport: 'http',
      url: 'https://x.example/mcp',
      headers: {},
      envHeaders: {},
      bearerTokenVar: null,
      codex: NONE,
    };
    const [a, b] = dtos([
      entry('plain', plain),
      entry('auth', { ...plain, bearerTokenVar: 'TOKEN' }, { source: YourMcpSource.CodexConfig }),
    ]);
    expect([a?.sendsNoHeaders, b?.sendsNoHeaders]).toEqual([true, false]);
    expect(b?.headerNames).toEqual(['Authorization']);
  });

  it('names the keys only Codex applies, from config.toml', () => {
    const filtered = stdio({ codex: { ...NONE, enabledTools: ['a'], toolTimeoutSec: 5 } });
    const [dto] = dtos([entry('c', filtered, { source: YourMcpSource.CodexConfig })]);
    expect(dto?.codexOnly).toEqual(['enabled_tools', 'tool_timeout_sec']);
    expect([dto?.enabledTools, dto?.disabledTools]).toEqual([['a'], []]);
  });
});
