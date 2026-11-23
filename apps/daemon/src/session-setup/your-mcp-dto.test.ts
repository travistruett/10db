import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRUST_DEFAULTS,
  YourMcpServerState,
  YourMcpSource,
  yourMcpServerKey,
} from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homeOutsideTemp, type TempDir } from '../../test/fixtures';
import { laneWritableRoots } from '../sandbox';
import { yourMcpServerDtos } from './your-mcp-dto';
import type { DeclaredYourServer, YourMcpEntry } from './your-mcp-entry';
import { yourMcpConfigHash } from './your-mcp-hash';

let root: TempDir;
let home: string;
let checkout: string;
beforeEach(() => {
  root = homeOutsideTemp('your-mcp-dto');
  const base = realpathSync(root.path);
  home = join(base, 'home');
  checkout = join(base, 'checkout');
  mkdirSync(home);
  mkdirSync(checkout);
});
afterEach(() => {
  root.cleanup();
});

const declared: DeclaredYourServer = {
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'gh'],
  env: { TOKEN: 'sk-canary', PATH: '/usr/bin' },
  envVars: [],
  cwd: null,
  codex: { enabledTools: null, disabledTools: [], startupTimeoutSec: null, toolTimeoutSec: null },
};

describe('yourMcpServerDtos', () => {
  it('a new server lists its hashed values and no secret', () => {
    const github: YourMcpEntry = {
      key: yourMcpServerKey(YourMcpSource.ClaudeJson, 'github'),
      name: 'github',
      claudeName: null,
      source: YourMcpSource.ClaudeJson,
      pluginId: null,
      declared,
      configHash: yourMcpConfigHash(YourMcpSource.ClaudeJson, declared),
      enabledInSource: true,
      refusal: null,
    };
    const [dto] = yourMcpServerDtos({
      entries: [github],
      switches: TRUST_DEFAULTS,
      approvals: new Map(),
      home,
      laneWritable: laneWritableRoots({
        checkouts: [checkout],
        worktreeBase: join(root.path, 'worktrees'),
        sandboxTempRoots: [],
        systemTempRoots: [],
      }),
    });
    expect(dto).toMatchObject({
      state: YourMcpServerState.New,
      on: false,
      envNames: ['PATH', 'TOKEN'],
      shownEnv: [{ name: 'PATH', value: '/usr/bin' }],
      configHash: github.configHash,
    });
    expect(JSON.stringify(dto)).not.toContain('sk-canary');
  });
});
