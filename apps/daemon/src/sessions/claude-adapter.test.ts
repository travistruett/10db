import type {
  AccountInfo,
  McpServerConfig,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { testPolicy } from '../../test/fixtures';
import { silentLogger } from '../log';
import { createClaudeAdapter } from './claude-adapter';
import type { QueryFn } from './claude-session';
import { initMessage } from './claude-test-support';
import type { LaneSessionSpec, SessionEvent } from './types';

/** A lane's spec on an API-key account, which holds a key and no saved login. */
function keyedSpec(): LaneSessionSpec {
  return {
    sessionId: mintId('Session'),
    conversationId: null,
    policy: testPolicy(),
    cwd: '/repo',
    prompt: 'Task: Alpha\nDo it.',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    resumeProviderSessionId: null,
    env: { PATH: '/usr/bin:/bin', CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0' },
    account: {
      accountId: mintId('Account'),
      label: 'API key',
      kind: 'anthropic_api_key',
      harness: 'claude',
      identity: null,
    },
    projectMcpServers: {},
    yourMcpServers: {},
    claudeConnectors: false,
    sandbox: null,
    mcp: { url: 'http://127.0.0.1:4317/mcp', token: 'session-token', toolTimeoutMs: 900_000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    profile: {
      kind: 'lane',
      workstreamId: mintId('Workstream'),
      sequence: 1,
      allowedTools: ['Read', 'mcp__10db__*'],
    },
  };
}

/**
 * Stands in for the SDK's query(): the test boundary for Claude Code. It sends `messages`, then
 * waits for its input to end or an abort, and reports `account` as who the session bills.
 */
function fakeQuery(
  messages: readonly SDKMessage[],
  account: AccountInfo,
): { query: QueryFn; inputs: SDKUserMessage[] } {
  const inputs: SDKUserMessage[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    let inputDone: () => void = () => undefined;
    const inputEnded = new Promise<void>((resolve) => {
      inputDone = resolve;
    });
    void (async () => {
      for await (const message of prompt) inputs.push(message);
      inputDone();
    })();
    const signal = options.abortController?.signal;
    const aborted = new Promise<void>((resolve) => {
      signal?.addEventListener(
        'abort',
        () => {
          resolve();
        },
        { once: true },
      );
    });
    async function* stream(): AsyncGenerator<SDKMessage, void> {
      for (const message of messages) yield message;
      await Promise.race([inputEnded, aborted]);
      if (signal?.aborted) throw new Error('Claude Code process aborted by user');
    }
    // The adapter calls only these Query members; the rest of the interface is irrelevant here.
    return Object.assign(stream(), {
      interrupt: () => Promise.resolve(undefined),
      accountInfo: () => Promise.resolve(account),
      setMcpServers: (servers: Record<string, McpServerConfig>) =>
        Promise.resolve({ added: Object.keys(servers), removed: [], errors: {} }),
      supportedModels: () => Promise.resolve([]),
      mcpServerStatus: () => Promise.resolve([]),
      getContextUsage: () =>
        Promise.resolve({ totalTokens: 30_000, maxTokens: 200_000, percentage: 15 }),
    }) as unknown as Query;
  };
  return { query, inputs };
}

describe('the account check', () => {
  it('refuses a keyed session that bills a saved login instead of its key', async () => {
    const fake = fakeQuery([initMessage()], {
      apiProvider: 'firstParty',
      subscriptionType: 'Claude Max',
      email: 'builder@example.com',
    });
    const adapter = createClaudeAdapter({
      claudePath: '/usr/local/bin/claude',
      pluginDir: '/harness',
      logger: silentLogger,
      query: fake.query,
      allowUnsandboxed: true,
      stopGraceMs: 1_000,
      // Never the real `claude auth status`.
      signInCheck: () => Promise.resolve('signed_in'),
    });
    const events: SessionEvent[] = [];
    for await (const event of adapter.open(keyedSpec()).events) events.push(event);
    expect(events.at(-1)).toMatchObject({
      reason: 'account_refused',
      refusal: { problem: 'wrong_credentials' },
    });
    expect(fake.inputs).toEqual([]);
  });
});
