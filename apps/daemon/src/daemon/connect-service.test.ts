import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectNext, YourMcpServerState, type YourMcpServerDto } from '@10db/contracts';
import { createTestStore, seedProject } from '@10db/db';
import { afterEach, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { AgentState, AgentTool } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { createServiceConnector, type RunCli } from './connect-service';
import { createTrustServices } from './trust-services';

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/**
 * Connect Linear approves the server it added and no other, and a repeat adds and approves nothing.
 * Only the agent CLI is replaced: it writes the entry the real `claude mcp add` writes.
 */
it('approves only the Linear server it added, and a repeat does nothing', async () => {
  const { store, close } = createTestStore();
  closers.push(close);
  const state = createStateStore(store, createEventBus());
  const project = seedProject(store);
  const home = tempDir('connect-home');
  closers.push(() => {
    home.cleanup();
  });
  const claudeJson = join(home.path, '.claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({ mcpServers: { other: { type: 'http', url: 'https://other.example/mcp' } } }),
  );
  mkdirSync(join(home.path, '.codex'), { recursive: true });

  const calls: string[][] = [];
  const run: RunCli = (_file, args) => {
    calls.push([...args]);
    const json = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    json.mcpServers['linear'] = { type: 'http', url: args.at(-1) };
    writeFileSync(claudeJson, JSON.stringify(json));
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const trust = createTrustServices({
    state,
    builderHome: home.path,
    laneWritableRoots: [],
    worktreeBase: join(home.path, '..', 'worktrees-none'),
    login: { configDir: () => null, codexHome: () => null },
    laneSandbox: null,
    adapter: { capabilities: () => ({}) as never },
    judge: { ready: () => Promise.resolve(false) },
    log: silentLogger,
    loginEnv: () => ({}),
  });
  const connector = createServiceConnector({
    state,
    servers: trust.appMcpServers,
    approve: (input) => trust.approveYourMcpServer(input),
    mcpSignIns: {
      list: () => Promise.reject(new Error('a Claude account has no sign-in to read')),
      start: () => Promise.reject(new Error('a Claude account has no sign-in to start')),
    },
    agents: () => ({
      statuses: () => [
        {
          tool: AgentTool.Claude,
          label: 'Claude Code',
          pinned: '0',
          state: AgentState.Ready,
          path: '/pinned/claude',
          version: '0',
          problem: null,
          newerRelease: null,
        },
      ],
      retry: () => Promise.resolve(),
    }),
    loginEnv: () => ({}),
    builderHome: home.path,
    run,
  });

  const first = await connector.connect('linear', project.id);
  const again = await connector.connect('linear', project.id);

  expect(first).toEqual({ next: ConnectNext.ClaudeCode });
  expect(again).toEqual(first);
  expect(calls).toHaveLength(1);
  const stateOf = (name: string): YourMcpServerDto['state'] | undefined =>
    trust.appMcpServers().find((s) => s.name === name)?.state;
  expect(stateOf('linear')).toBe(YourMcpServerState.Approved);
  expect(stateOf('other')).toBe(YourMcpServerState.New);
});
