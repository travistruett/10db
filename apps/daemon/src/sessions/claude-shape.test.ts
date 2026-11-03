import type {
  AccountInfo,
  McpServerConfig,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../log';
import { createChannel } from './channel';
import { startShapeSession } from './claude-shape';
import { assistantMessage, initMessage, resultMessage, textBlock } from './claude-test-support';
import type { QueryFn } from './claude-adapter';
import type { SessionEvent, ShapeSessionSpec, ShapeToolRequest } from './types';

// Shape spec §5.1, §5.2: the SDK options of a conversation's session, and its start-up checks.

function spec(overrides: Partial<ShapeSessionSpec> = {}): ShapeSessionSpec {
  return {
    sessionId: mintId('Session'),
    shapeId: mintId('Shape'),
    cwd: '/repo',
    systemPrompt: 'You are Shape.',
    prompt: 'First message',
    model: 'sonnet',
    effort: 'high',
    resumeProviderSessionId: null,
    env: { PATH: '/usr/bin:/bin' },
    account: {
      accountId: mintId('Account'),
      label: 'Claude plan',
      kind: 'claude_subscription',
      identity: 'builder@example.com',
    },
    tools: ['Read', 'Grep', 'Glob', 'Agent'],
    allowedTools: ['Read', 'Grep', 'Glob', 'mcp__10db__note_heard'],
    disallowedTools: ['Edit', 'Bash'],
    agents: { scope: { description: 'Scope review', prompt: 'Review scope', tools: ['Read'] } },
    mcp: { url: 'http://127.0.0.1:4317/mcp', token: 'shape-token', toolTimeoutMs: 60_000 },
    preToolUse: () => ({ decision: 'allow' }),
    ...overrides,
  };
}

interface Run {
  options: Options | null;
  readonly inputs: SDKUserMessage[];
  readonly mcpServers: Record<string, McpServerConfig>[];
  readonly order: string[];
  interrupts: number;
}

/** Stands in for the SDK's query(): replies to each user message with the next scripted turn. */
function fakeQuery(opts: { account?: AccountInfo; turns?: SDKMessage[][] } = {}): {
  query: QueryFn;
  run: Run;
} {
  const run: Run = { options: null, inputs: [], mcpServers: [], order: [], interrupts: 0 };
  const turns = opts.turns ?? [
    [
      initMessage(),
      assistantMessage([textBlock('hello')]),
      resultMessage({ input: 10, output: 5, costUsd: 0.01 }),
    ],
  ];
  const query: QueryFn = ({ prompt, options }) => {
    run.options = options;
    const out = createChannel<SDKMessage>();
    void (async () => {
      let turn = 0;
      for await (const message of prompt) {
        run.order.push('input');
        run.inputs.push(message);
        for (const m of turns[Math.min(turn, turns.length - 1)] ?? []) out.push(m);
        turn += 1;
      }
      out.end();
    })();
    return Object.assign(out, {
      interrupt: () => {
        run.interrupts += 1;
        return Promise.resolve(undefined);
      },
      accountInfo: () => {
        run.order.push('accountInfo');
        return Promise.resolve(
          opts.account ?? {
            apiProvider: 'firstParty',
            subscriptionType: 'Claude Max',
            email: 'builder@example.com',
          },
        );
      },
      setMcpServers: (servers: Record<string, McpServerConfig>) => {
        run.order.push('setMcpServers');
        run.mcpServers.push(servers);
        return Promise.resolve({ added: [], removed: [], errors: {} });
      },
      mcpServerStatus: () => Promise.resolve([]),
      getContextUsage: () =>
        Promise.resolve({ totalTokens: 90_000, maxTokens: 200_000, percentage: 45 }),
    }) as unknown as ReturnType<QueryFn>;
  };
  return { query, run };
}

const deps = (query: QueryFn) => ({
  claudePath: '/usr/bin/claude',
  logger: silentLogger,
  query,
});

async function collect(
  handle: { events: AsyncIterable<SessionEvent>; stop(): Promise<void> },
  until: (events: SessionEvent[]) => boolean,
): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of handle.events) {
    events.push(event);
    if (until(events)) await handle.stop();
  }
  return events;
}

describe('a Shape session’s SDK options', () => {
  it('loads nothing of the project, the user or the harness, and lists exactly its tools', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec(), deps(query));
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const options = run.options;
    expect(options).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      permissionMode: 'default',
      tools: ['Read', 'Grep', 'Glob', 'Agent'],
      allowedTools: ['Read', 'Grep', 'Glob', 'mcp__10db__note_heard'],
      disallowedTools: ['Edit', 'Bash'],
      model: 'sonnet',
      effort: 'high',
      cwd: '/repo',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Shape.' },
    });
    expect(options).not.toHaveProperty('plugins');
    expect(options).not.toHaveProperty('sandbox');
    expect(options?.agents).toEqual({
      scope: {
        description: 'Scope review',
        prompt: 'Review scope',
        tools: ['Read'],
        model: 'inherit',
      },
    });
  });

  it('denies by default in canUseTool, whatever the tool', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec(), deps(query));
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const result = await run.options?.canUseTool?.('Bash', { command: 'ls' }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_1',
    } as never);
    expect(result).toMatchObject({ behavior: 'deny' });
  });

  it('registers 10db’s MCP server under the session’s token, then sends the first message', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec(), deps(query));
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    expect(run.order).toEqual(['accountInfo', 'setMcpServers', 'input']);
    expect(run.mcpServers[0]?.['10db']).toMatchObject({
      type: 'http',
      url: 'http://127.0.0.1:4317/mcp',
      headers: { Authorization: 'Bearer shape-token' },
    });
    expect(run.inputs[0]?.message.content).toBe('First message');
  });
});

describe('the PreToolUse hook', () => {
  async function hookFor(preToolUse: ShapeSessionSpec['preToolUse']) {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec({ preToolUse }), deps(query));
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const hook = run.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('no PreToolUse hook');
    return (input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PreToolUse', ...input } as never, undefined, {
        signal: new AbortController().signal,
      });
  }

  it('hands the guard the subagent’s id and type, which tell a reviewer from the session', async () => {
    const seen: ShapeToolRequest[] = [];
    const call = await hookFor((req) => {
      seen.push(req);
      return { decision: 'allow' };
    });
    await call({ tool_name: 'Read', tool_input: { file_path: 'a' } });
    await call({
      tool_name: 'mcp__10db__report_finding',
      tool_input: {},
      agent_id: 'agent-7',
      agent_type: 'scope',
    });
    expect(seen).toEqual([
      { toolName: 'Read', input: { file_path: 'a' }, agentId: undefined, agentType: undefined },
      { toolName: 'mcp__10db__report_finding', input: {}, agentId: 'agent-7', agentType: 'scope' },
    ]);
  });

  it('turns a deny into the hook’s deny answer', async () => {
    const call = await hookFor(() => ({ decision: 'deny', reason: 'read-only' }));
    expect(await call({ tool_name: 'Edit', tool_input: {} })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'read-only' },
    });
  });

  it('denies when the guard throws', async () => {
    const call = await hookFor(() => {
      throw new Error('boom');
    });
    expect(await call({ tool_name: 'Read', tool_input: {} })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });
});

describe('the session’s run', () => {
  it('reports the turn, its tokens and the context used', async () => {
    const { query } = fakeQuery();
    const handle = startShapeSession(spec(), deps(query));
    const events = await collect(handle, (e) => e.some((x) => x.type === 'context'));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['started', 'turn_complete', 'context', 'ended']),
    );
    expect(events.find((e) => e.type === 'context')).toMatchObject({ percentage: 45 });
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'stopped' });
  });

  it('sends a later message to the same session, and interrupts only the turn', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec(), deps(query));
    let sent = false;
    let interruptsBeforeStop = 0;
    for await (const event of handle.events) {
      if (event.type === 'turn_complete' && !sent) {
        sent = true;
        await handle.interrupt();
        interruptsBeforeStop = run.interrupts;
        handle.send('and another');
      }
      if (event.type === 'turn_complete' && sent && run.inputs.length === 2) await handle.stop();
    }
    expect(interruptsBeforeStop).toBe(1);
    expect(run.inputs.map((m) => m.message.content)).toEqual(['First message', 'and another']);
  });

  it('refuses a session that is not the expected account, before any prompt', async () => {
    const { query, run } = fakeQuery({
      account: {
        apiProvider: 'firstParty',
        subscriptionType: 'Claude Max',
        email: 'other@example.com',
      },
    });
    const handle = startShapeSession(spec(), deps(query));
    const events = await collect(handle, () => false);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'account_refused' });
    expect(run.inputs).toEqual([]);
  });
});
