import {
  AccountKind,
  mintId,
  providerOf,
  AGENT_ACCOUNT_KINDS,
  type AgentAccountKind,
} from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { codexCapabilities } from './capabilities';
import { createChannel } from './channel';
import { createRoutedAdapter } from './routed-adapter';
import type {
  AgentAdapter,
  ExploreSessionSpec,
  LaneSessionSpec,
  SessionEvent,
  SessionHandle,
} from './types';

const ended = () => {
  const events = createChannel<SessionEvent>();
  events.end();
  return events;
};

/** Records which of its methods ran, in order, and answers each with its own name. */
function recording(name: string): AgentAdapter & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    capabilities: () => {
      calls.push('capabilities');
      return { ...codexCapabilities('codex_signin'), label: name };
    },
    complete: () => {
      calls.push('complete');
      return Promise.resolve(name);
    },
    probeAccount: () => {
      calls.push('probeAccount');
      return Promise.resolve({
        email: name,
        organization: undefined,
        subscriptionType: undefined,
        tokenSource: undefined,
        apiKeySource: undefined,
        apiProvider: undefined,
      });
    },
    startLogin: () => {
      calls.push('startLogin');
      return Promise.resolve({
        authUrl: `https://auth.openai.com/${name}`,
        outcome: new Promise<never>(() => undefined),
        cancel: () => Promise.resolve(),
      });
    },
    open: () => {
      calls.push('open');
      return {
        events: ended(),
        send: () => undefined,
        interrupt: () => Promise.resolve(null),
        stop: () => Promise.resolve(),
        setModel: () => Promise.resolve(),
      } satisfies SessionHandle;
    },
    readClientUuids: () => {
      calls.push('readClientUuids');
      return Promise.resolve([name]);
    },
    startMcpSignIn: () => {
      calls.push('startMcpSignIn');
      return Promise.resolve({
        outcome: new Promise<never>(() => undefined),
        reopen: () => Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
    mcpAuthStatus: () => {
      calls.push('mcpAuthStatus');
      return Promise.resolve({});
    },
    takeoverCommand: (spec) => {
      calls.push('takeoverCommand');
      return {
        cwd: spec.cwd,
        unset: [],
        unsetPrefixes: [],
        set: {},
        keychain: [],
        sources: [],
        argv: [name],
      };
    },
    takeoverNotes: () => {
      calls.push('takeoverNotes');
      return [name];
    },
  };
}

const account = (kind: AgentAccountKind) => ({
  accountId: mintId('Account'),
  label: 'A',
  kind,
  identity: null,
});

/** Only the account matters to routing; the rest of a spec is the adapter's. */
const asSession = (kind: AgentAccountKind) => ({ account: account(kind) }) as LaneSessionSpec; // routing reads only `account`
const asShape = (kind: AgentAccountKind) => ({ account: account(kind) }) as ExploreSessionSpec; // routing reads only `account`

const CLAUDE_KINDS = [
  AccountKind.ClaudeSubscription,
  AccountKind.Bedrock,
  AccountKind.Gateway,
  AccountKind.AnthropicApiKey,
] as const;

const METHODS = [
  'open',
  'open',
  'capabilities',
  'complete',
  'probeAccount',
  'startLogin',
  'readClientUuids',
  'startMcpSignIn',
  'mcpAuthStatus',
  'takeoverCommand',
  'takeoverNotes',
] as const;

async function callAll(adapter: AgentAdapter, kind: AgentAccountKind): Promise<void> {
  adapter.open(asSession(kind));
  adapter.open(asShape(kind));
  adapter.capabilities({ kind }, null);
  await adapter.complete({ cwd: '/d', prompt: 'q', model: 'm', env: {}, account: account(kind) });
  await adapter.probeAccount({ cwd: '/d', env: {}, kind });
  await adapter.startLogin({ cwd: '/d', env: {}, kind });
  const server = {
    connect: { type: 'http' as const, url: 'https://s.example/mcp', headers: null },
    claudeOAuth: null,
    codex: { enabledTools: null, disabledTools: [], startupTimeoutSec: null, toolTimeoutSec: null },
  };
  await adapter.startMcpSignIn({ kind, env: {}, name: 's', server });
  await adapter.mcpAuthStatus({ kind, env: {}, servers: { s: server } });
  await adapter.readClientUuids({
    account: account(kind),
    env: {},
    cwd: '/d',
    providerSessionId: 'thr-1',
    wanted: ['u1'],
    since: '2026-11-11T00:00:00.000Z',
  });
  adapter.takeoverCommand({
    kind,
    cwd: '/d',
    providerSessionId: 'thr-1',
    model: 'm',
    effort: 'high',
    launch: {
      set: {},
      unset: [],
      unsetPrefixes: [],
      keychain: [],
      apiKeyHelperAccount: null,
      scrub: false,
      model: 'm',
    },
    pluginDirs: [],
    instructionsFile: null,
    mcpConfigFile: null,
    codexServers: [],
    sealedEnvFile: null,
    web: false,
  });
  adapter.takeoverNotes({ kind });
}

describe('createRoutedAdapter', () => {
  it.each(CLAUDE_KINDS)('sends %s to Claude', async (kind) => {
    const claude = recording('claude');
    const codex = recording('codex');
    await callAll(createRoutedAdapter({ claude, codex }), kind);
    expect(claude.calls.sort()).toEqual([...METHODS].sort());
    expect(codex.calls).toEqual([]);
  });

  it('sends codex_signin to Codex', async () => {
    const claude = recording('claude');
    const codex = recording('codex');
    const adapter = createRoutedAdapter({ claude, codex });
    await callAll(adapter, AccountKind.CodexSignin);
    expect(codex.calls.sort()).toEqual([...METHODS].sort());
    expect(claude.calls).toEqual([]);
    const probed = await adapter.probeAccount({
      cwd: '/d',
      env: {},
      kind: AccountKind.CodexSignin,
    });
    expect(probed.email).toBe('codex');
  });

  it.each(AGENT_ACCOUNT_KINDS)('asks the agent of %s what it can do', (kind) => {
    const routed = createRoutedAdapter({ claude: recording('claude'), codex: recording('codex') });
    expect(routed.capabilities({ kind }, null).label).toBe(providerOf(kind));
  });
});
