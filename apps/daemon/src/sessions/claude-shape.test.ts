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
import { autoModeRules, type LaneSandboxSpec } from '../sandbox';
import { createChannel } from './channel';
import { startShapeSession } from './claude-shape';
import { assistantMessage, initMessage, resultMessage, textBlock } from './claude-test-support';
import type { QueryFn } from './claude-adapter';
import type {
  SessionEvent,
  ShapeSessionSpec,
  ShapeToolRequest,
  ShapeToolResult,
  ToolRequest,
} from './types';

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
    sandbox: null,
    projectMcpServers: {},
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'not in this test' }),
    ...overrides,
  };
}

const readOnlySandbox: LaneSandboxSpec = {
  settings: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    allowAppleEvents: false,
    autoAllowBashIfSandboxed: false,
    filesystem: {
      denyRead: ['/'],
      allowRead: ['/repo'],
      allowWrite: ['/private/tmp/10db-x'],
      denyWrite: ['/repo', '/repo/.git'],
    },
    network: {
      allowedDomains: [],
      allowMachLookup: ['com.apple.FSEvents'],
      allowUnixSockets: ['/private/tmp/10db-x'],
    },
    credentials: { envVars: [] },
  },
  env: { CLAUDE_CODE_TMPDIR: '/private/tmp/10db-x', GIT_CONFIG_GLOBAL: '/dev/null' },
  disallowedTools: ['Read(//h/.claude.json)'],
  autoMode: autoModeRules(null),
  askRules: ['Edit(//repo/.mcp.json)'],
};

interface Run {
  options: Options | null;
  readonly inputs: SDKUserMessage[];
  readonly mcpServers: Record<string, McpServerConfig>[];
  readonly order: string[];
  interrupts: number;
}

/** Stands in for the SDK's query(): replies to each user message with the next scripted turn. */
function fakeQuery(
  opts: {
    account?: AccountInfo;
    turns?: SDKMessage[][];
    /** What setMcpServers answers each server it could not connect, by name. */
    mcpErrors?: Record<string, string>;
  } = {},
): {
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
    // Claude Code is started through the session's own spawn, when it has one.
    options.spawnClaudeCodeProcess?.({
      command: '/usr/bin/claude',
      args: [],
      cwd: '/repo',
      env: {},
      signal: new AbortController().signal,
    });
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
        return Promise.resolve({ added: [], removed: [], errors: opts.mcpErrors ?? {} });
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

  it('runs its commands in the read-only sandbox it is given, with the scrub on', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(spec({ sandbox: readOnlySandbox }), deps(query));
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    expect(run.options).toMatchObject({
      sandbox: readOnlySandbox.settings,
      permissionMode: 'default',
      env: {
        PATH: '/usr/bin:/bin',
        CLAUDE_CODE_TMPDIR: '/private/tmp/10db-x',
        GIT_CONFIG_GLOBAL: '/dev/null',
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
      },
      disallowedTools: ['Edit', 'Bash', 'Read(//h/.claude.json)'],
      settings: { autoCompactEnabled: true, permissions: { ask: ['Edit(//repo/.mcp.json)'] } },
    });
    expect(run.options).not.toHaveProperty('settings.autoMode');
  });

  it('hands a call the hook did not settle to the broker, with the directory the hook saw', async () => {
    const seen: ToolRequest[] = [];
    const { query, run } = fakeQuery();
    const handle = startShapeSession(
      spec({
        canUseTool: (req) => {
          seen.push(req);
          return Promise.resolve({ behavior: 'deny', message: 'the builder said no' });
        },
      }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const hook = run.options?.hooks?.PreToolUse?.[0]?.hooks[0];
    await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu_1',
        cwd: '/repo/apps',
      } as never,
      undefined,
      { signal: new AbortController().signal },
    );
    const result = await run.options?.canUseTool?.('Bash', { command: 'pnpm test' }, {
      signal: new AbortController().signal,
      toolUseID: 'toolu_1',
    } as never);
    expect(result).toEqual({ behavior: 'deny', message: 'the builder said no' });
    expect(seen.map((r) => [r.toolName, r.input, r.toolUseId, r.cwd])).toEqual([
      ['Bash', { command: 'pnpm test' }, 'toolu_1', '/repo/apps'],
    ]);
  });

  it('gives an agent its own model, and the session’s to one that names none', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(
      spec({
        agents: {
          'code-researcher': {
            description: 'Reads code',
            prompt: 'Read',
            tools: ['Read', 'Bash'],
            model: 'fable',
          },
          scope: { description: 'Scope review', prompt: 'Review scope', tools: ['Read'] },
        },
      }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    expect(run.options?.agents?.['code-researcher']?.model).toBe('fable');
    expect(run.options?.agents?.['scope']?.model).toBe('inherit');
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

  it('names a project server that failed to connect in the first message, so the session does not hunt for it', async () => {
    const { query, run } = fakeQuery({ mcpErrors: { billing: 'connection closed' } });
    const handle = startShapeSession(
      spec({
        projectMcpServers: {
          billing: { type: 'http', url: 'https://billing.example.com/mcp', headers: null },
        },
      }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const content = run.inputs[0]?.message.content;
    const first = typeof content === 'string' ? content : '';
    expect(first.startsWith('First message')).toBe(true);
    expect(first).toContain('failed to connect');
    expect(first).toContain('billing');
  });

  it('registers the project’s approved servers beside 10db’s, which keeps its name', async () => {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(
      spec({
        projectMcpServers: {
          docs: { type: 'http', url: 'https://docs.example.com/mcp', headers: null },
          '10db': { type: 'http', url: 'https://evil.example.com/mcp', headers: null },
        },
      }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    expect(Object.keys(run.mcpServers[0] ?? {})).toEqual(['docs', '10db']);
    expect(run.mcpServers[0]?.['docs']).toMatchObject({
      type: 'http',
      url: 'https://docs.example.com/mcp',
    });
    expect(run.mcpServers[0]?.['10db']).toMatchObject({ url: 'http://127.0.0.1:4317/mcp' });
  });
});

describe('the Claude Code process', () => {
  it('is spawned by the session, which reports its pid when it starts', async () => {
    const { query } = fakeQuery();
    const spawned: string[] = [];
    const handle = startShapeSession(spec(), {
      ...deps(query),
      spawn: (options, onSpawn) => {
        spawned.push(options.command);
        onSpawn(4242);
        return {} as never;
      },
    });
    const events = await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    expect(spawned).toEqual(['/usr/bin/claude']);
    expect(events.find((e) => e.type === 'started')).toMatchObject({ pid: 4242 });
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

  it('runs an allowed call with the input 10db set in place of the model’s', async () => {
    const call = await hookFor(() => ({
      decision: 'allow',
      updatedInput: { effortKey: 'density', reviewer: 'scope' },
    }));
    expect(
      await call({ tool_name: 'mcp__10db__report_finding', tool_input: { reviewer: 'x' } }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { effortKey: 'density', reviewer: 'scope' },
      },
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

describe('the PostToolUse hook', () => {
  async function postHook(postToolUse?: (req: ShapeToolResult) => void) {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(
      spec(postToolUse === undefined ? {} : { postToolUse }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const hook = run.options?.hooks?.PostToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('no PostToolUse hook');
    return (input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PostToolUse', ...input } as never, undefined, {
        signal: new AbortController().signal,
      });
  }

  it('hands the result, with the subagent’s id, to the session’s measurement', async () => {
    const seen: unknown[] = [];
    const call = await postHook((req) => seen.push(req));
    await call({
      tool_name: 'Read',
      tool_input: { file_path: 'a.png' },
      tool_response: { type: 'image' },
      agent_id: 'agent-7',
      agent_type: 'scope',
    });
    expect(seen).toEqual([
      {
        toolName: 'Read',
        input: { file_path: 'a.png' },
        response: { type: 'image' },
        agentId: 'agent-7',
        agentType: 'scope',
      },
    ]);
  });

  it('lets the call be when the measurement throws, and when there is none', async () => {
    const throwing = await postHook(() => {
      throw new Error('boom');
    });
    expect(await throwing({ tool_name: 'Read', tool_input: {}, tool_response: '' })).toEqual({});
    const none = await postHook(undefined);
    expect(await none({ tool_name: 'Read', tool_input: {}, tool_response: '' })).toEqual({});
  });
});

describe('the PostToolUseFailure hook', () => {
  async function failureHook(toolFailed?: (req: ShapeToolRequest) => void) {
    const { query, run } = fakeQuery();
    const handle = startShapeSession(
      spec(toolFailed === undefined ? {} : { toolFailed }),
      deps(query),
    );
    await collect(handle, (e) => e.some((x) => x.type === 'turn_complete'));
    const hook = run.options?.hooks?.PostToolUseFailure?.[0]?.hooks[0];
    if (!hook) throw new Error('no PostToolUseFailure hook');
    return (input: Record<string, unknown>) =>
      hook({ hook_event_name: 'PostToolUseFailure', ...input } as never, undefined, {
        signal: new AbortController().signal,
      });
  }

  it('tells the session which call failed, with the subagent’s id', async () => {
    const seen: unknown[] = [];
    const call = await failureHook((req) => seen.push(req));
    await call({
      tool_name: 'Read',
      tool_input: { file_path: 'a.png' },
      error: 'no such file',
      agent_id: 'agent-7',
      agent_type: 'scope',
    });
    expect(seen).toEqual([
      {
        toolName: 'Read',
        input: { file_path: 'a.png' },
        agentId: 'agent-7',
        agentType: 'scope',
      },
    ]);
  });

  it('lets the call be when the listener throws, and when there is none', async () => {
    const throwing = await failureHook(() => {
      throw new Error('boom');
    });
    expect(await throwing({ tool_name: 'Read', tool_input: {}, error: 'x' })).toEqual({});
    const none = await failureHook(undefined);
    expect(await none({ tool_name: 'Read', tool_input: {}, error: 'x' })).toEqual({});
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
