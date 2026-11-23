import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountKind,
  ConnectNext,
  YourMcpServerState,
  type StartMcpSignIn,
  type YourMcpServerDto,
} from '@10db/contracts';
import { createTestStore, seedAccount, seedProject } from '@10db/db';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentState, AgentTool } from '../environment';
import { createEventBus, createStateStore } from '../events';
import { silentLogger } from '../log';
import { FakeAdapter } from '../sessions';
import { createServiceConnector, type RunCli } from './connect-service';
import { createTrustServices } from './trust-services';

const ClaudeJson = z.object({ mcpServers: z.record(z.string(), z.unknown()) });

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** A builder's home with `servers` in `~/.claude.json`, and a connector over it; only the agent CLI is replaced. */
function world(opts: { readonly codex: boolean; readonly servers: Record<string, unknown> }) {
  const { store, close } = createTestStore();
  closers.push(close);
  const bus = createEventBus();
  const state = createStateStore(store, bus);
  const account = opts.codex
    ? seedAccount(store, { kind: AccountKind.CodexSignin, label: 'codex' })
    : null;
  const project = seedProject(store, account === null ? {} : { accountId: account.id });
  // Not under the system temp dir: a lane can write there, so Trust refuses a config file that lies in it.
  const home = mkdtempSync(join(import.meta.dirname, '.connect-home-'));
  closers.push(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const claudeJson = join(home, '.claude.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: opts.servers }));
  mkdirSync(join(home, '.codex'), { recursive: true });

  const calls: string[][] = [];
  const started: StartMcpSignIn[] = [];
  // The CLI writes the entry the real `claude mcp add` writes.
  const run: RunCli = (_file, args) => {
    calls.push([...args]);
    const json = ClaudeJson.parse(JSON.parse(readFileSync(claudeJson, 'utf8')));
    json.mcpServers['linear'] = { type: 'http', url: args.at(-1) };
    writeFileSync(claudeJson, JSON.stringify(json));
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  const trust = createTrustServices({
    state,
    builderHome: home,
    laneWritableRoots: [],
    worktreeBase: join(home, 'worktrees'),
    login: { configDir: () => null, codexHome: () => null },
    laneSandbox: null,
    adapter: new FakeAdapter({}),
    judge: { ready: () => Promise.resolve(false) },
    log: silentLogger,
    loginEnv: () => ({}),
  });
  const connector = createServiceConnector({
    state,
    mcp: trust.projectMcpServers,
    bus,
    approve: (input) => trust.approveYourMcpServer(input),
    mcpSignIns: {
      list: () => Promise.resolve({ rows: [], terminal: [], candidates: [], ownClaudeCode: [] }),
      start: (input) => {
        started.push(input);
        return Promise.resolve({ rows: [], terminal: [], candidates: [], ownClaudeCode: [] });
      },
    },
    agents: () => ({
      statuses: () => [
        {
          tool: opts.codex ? AgentTool.Codex : AgentTool.Claude,
          label: 'Agent',
          pinned: '0',
          state: AgentState.Ready,
          path: '/pinned/agent',
          version: '0',
          problem: null,
          newerRelease: null,
        },
      ],
      retry: () => Promise.resolve(),
    }),
    loginEnv: () => ({}),
    builderHome: home,
    run,
  });
  const stateOf = (name: string): YourMcpServerDto['state'] | undefined =>
    trust.projectMcpServers(project.id).servers.find((s) => s.name === name)?.state;
  return { connector, project, calls, started, stateOf };
}

/** Connect Linear approves the server it added and no other, and a repeat adds and approves nothing. */
it('approves only the Linear server it added, and a repeat does nothing', async () => {
  const { connector, project, calls, stateOf } = world({
    codex: false,
    servers: { other: { type: 'http', url: 'https://other.example/mcp' } },
  });

  const first = await connector.connect('linear', project.id);
  const again = await connector.connect('linear', project.id);

  expect(first).toEqual({ next: ConnectNext.ClaudeCode });
  expect(again).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(stateOf('linear')).toBe(YourMcpServerState.Approved);
  expect(stateOf('other')).toBe(YourMcpServerState.New);
});

/** Every session gets Claude Code's servers, so a Codex account signs in the Linear one already there. */
it('signs a Codex account in to the Linear server Claude Code already has, adding none', async () => {
  const { connector, project, calls, started } = world({
    codex: true,
    servers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } },
  });

  const result = await connector.connect('linear', project.id);

  expect(result).toEqual({ next: ConnectNext.SigningIn });
  expect(calls).toHaveLength(0);
  expect(started).toHaveLength(1);
  expect(started[0]?.key).toMatch(/^claude_json:linear$/);
});
