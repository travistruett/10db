import { AgentCopyState, SystemCheckDto, ToolName, type AgentCopy } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { fetchingAgents, systemCards, SystemCardKind } from './system-cards';

const agent = (over: Partial<AgentCopy>): AgentCopy => ({
  tool: ToolName.Codex,
  label: 'Codex',
  pinned: '0.167.0',
  state: AgentCopyState.Ready,
  problem: null,
  newerRelease: null,
  ...over,
});

function check(over: Partial<SystemCheckDto> = {}): SystemCheckDto {
  return SystemCheckDto.parse({
    loginEnv: { source: 'login_shell', warning: null },
    claudeCode: { verifiedOn: '2.1.302', warning: null },
    codex: { verifiedOn: '0.167.0', warning: null },
    tools: [],
    ...over,
  });
}

describe('systemCards', () => {
  it.each([
    { name: 'nothing found', check: check(), kinds: [] },
    {
      name: 'a missing required tool',
      check: check({
        tools: [{ name: 'git', path: null, version: null, required: true, signedIn: null }],
      }),
      kinds: [SystemCardKind.MissingTool],
    },
    {
      name: 'a missing optional tool',
      check: check({
        tools: [{ name: 'docker', path: null, version: null, required: false, signedIn: null }],
      }),
      kinds: [],
    },
    {
      // 10db fetches its own copy, so a missing install of a pinned agent is never the builder's to fix.
      name: 'a missing install of an agent 10db pins',
      check: check({
        tools: [
          { name: ToolName.Claude, path: null, version: null, required: true, signedIn: null },
        ],
        agents: [agent({ tool: ToolName.Claude, label: 'Claude Code', pinned: '2.1.302' })],
      }),
      kinds: [],
    },
    {
      name: 'a refused copy',
      check: check({
        agents: [agent({ state: AgentCopyState.Refused, problem: 'changed files' })],
      }),
      kinds: [SystemCardKind.RefusedCopy],
    },
    {
      name: 'a copy being downloaded',
      check: check({ agents: [agent({ state: AgentCopyState.Fetching })] }),
      kinds: [],
    },
    {
      name: 'a newer release',
      check: check({ agents: [agent({ newerRelease: '0.168.0' })] }),
      kinds: [],
    },
    {
      name: 'an unreadable login shell',
      check: check({ loginEnv: { source: 'inherited', warning: 'zsh exited 1' } }),
      kinds: [SystemCardKind.LoginShell],
    },
    {
      name: 'a refused Artificial Analysis key',
      check: check({
        benchmarkSync: { outcome: 'unauthorized', message: 'Artificial Analysis refused the key' },
      }),
      kinds: [SystemCardKind.BenchmarkKey],
    },
    {
      name: 'a used-up Artificial Analysis limit, which clears itself',
      check: check({ benchmarkSync: { outcome: 'rate_limited', message: 'limit used up' } }),
      kinds: [],
    },
    {
      name: 'an unreachable Artificial Analysis server, which clears itself',
      check: check({ benchmarkSync: { outcome: 'failed', message: 'answered 503' } }),
      kinds: [],
    },
    {
      name: 'a Claude Code version warning, which has nothing to do',
      check: check({ claudeCode: { verifiedOn: '2.1.302', warning: 'newer major' } }),
      kinds: [],
    },
    {
      name: 'a Codex version warning, which has nothing to do',
      check: check({ codex: { verifiedOn: '0.167.0', warning: 'differs' } }),
      kinds: [],
    },
  ])('$name', ({ check: found, kinds }) => {
    expect(systemCards(found).map((card) => card.kind)).toEqual(kinds);
  });

  it('has no cards before the check has loaded', () => {
    expect(systemCards(undefined)).toEqual([]);
  });
});

describe('fetchingAgents', () => {
  it('lists only the copies being downloaded', () => {
    const fetching = agent({
      tool: ToolName.Claude,
      label: 'Claude Code',
      state: AgentCopyState.Fetching,
    });
    expect(fetchingAgents(check({ agents: [fetching, agent({})] }))).toEqual([fetching]);
    expect(fetchingAgents(undefined)).toEqual([]);
  });
});
