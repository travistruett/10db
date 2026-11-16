import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId, TRUST_DEFAULTS, YourMcpSource, yourMcpServerKey } from '@10db/contracts';
import { createTestStore } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir, type TempDir } from '../../test/fixtures';
import { approveMcpServer, setAppTrustSwitches, setProjectTrustOverrides } from '../permissions';
import { readYourMcpConfig } from './your-mcp-config';
import { yourMcpForSession } from './your-mcp-for-session';

let root: TempDir;
let home: string;
beforeEach(() => {
  root = tempDir('your-mcp-for-session');
  home = join(realpathSync(root.path), 'home');
  mkdirSync(home);
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'gh'], env: { TOKEN: 'sk-canary' } },
        waiting: { command: 'npx', args: ['-y', 'w'] },
      },
    }),
  );
});
afterEach(() => {
  root.cleanup();
});

const ignore = (): void => undefined;
const project = mintId('Project');

function planFor(
  test: ReturnType<typeof createTestStore>,
  plugins = [] as { id: string; installPath: string }[],
) {
  return yourMcpForSession({
    db: test.store.db,
    home,
    projectId: project,
    projectServerNames: [],
    loginEnv: { PATH: '/usr/bin:/bin' },
    laneWritable: [],
    localBinding: false,
    plugins,
    onInvalid: ignore,
  });
}

function approveGithub(test: ReturnType<typeof createTestStore>): void {
  const entry = readYourMcpConfig({ home, laneWritable: [], plugins: [] }).entries.find(
    (e) => e.name === 'github',
  );
  if (!entry?.configHash) throw new Error('no github entry');
  const hash = entry.configHash;
  test.store.write((ctx) => {
    approveMcpServer(ctx, yourMcpServerKey(YourMcpSource.ClaudeJson, 'github'), hash);
  });
}

describe('yourMcpForSession', () => {
  it('an approved server in ~/.claude.json is planned for the project, the one waiting is named, and a project override off drops it', () => {
    const test = createTestStore();
    approveGithub(test);
    const planned = planFor(test);
    expect(Object.keys(planned.stdio)).toEqual(['github']);
    expect(planned.leftOut.map((l) => [l.what, l.why])).toEqual([
      ['your MCP server waiting (~/.claude.json)', 'waiting for your approval in Settings › Trust'],
    ]);
    const key = yourMcpServerKey(YourMcpSource.ClaudeJson, 'github');
    test.store.write((ctx) => {
      setProjectTrustOverrides(ctx, project, { mcpServers: { [key]: false } });
    });
    expect(Object.keys(planFor(test).stdio)).toEqual([]);
    test.close();
  });

  it('the master switch off plans none and notes none, file problems included', () => {
    const test = createTestStore();
    writeFileSync(join(home, '.codex'), 'x');
    test.store.write((ctx) => {
      setAppTrustSwitches(ctx, { ...TRUST_DEFAULTS, yourMcpServers: false });
    });
    expect(planFor(test)).toEqual({ stdio: {}, remote: {}, leftOut: [], connectorsOn: false });
    test.close();
  });

  it('a file that leads nowhere is a left-out item and the rest still load', () => {
    const test = createTestStore();
    approveGithub(test);
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'config.toml'), 'not = [toml');
    const planned = planFor(test);
    expect(Object.keys(planned.stdio)).toEqual(['github']);
    expect(planned.leftOut.map((l) => l.what)).toContain('~/.codex/config.toml');
    test.close();
  });
});
