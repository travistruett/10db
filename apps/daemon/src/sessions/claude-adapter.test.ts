import type {
  AccountInfo,
  McpServerStatus,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import { mintId } from '@10db/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ManualClock, systemClock, type Clock } from '../clock';
import { createLogger, silentLogger } from '../log';
import {
  buildQueryOptions,
  CLAUDE_MCP_SERVER,
  createClaudeAdapter,
  type QueryFn,
} from './claude-adapter';
import {
  assistantMessage,
  initMessage,
  PROVIDER_SESSION,
  rateLimitEvent,
  resultMessage,
  textBlock,
  toolUseBlock,
} from './claude-test-support';
import type { SessionEvent, SessionSpec } from './types';

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: mintId('Session'),
    workstreamId: mintId('Workstream'),
    sequence: 1,
    cwd: '/repo',
    prompt: 'Task: Alpha\nDo it.',
    model: 'sonnet',
    effort: 'medium',
    resumeProviderSessionId: null,
    env: { PATH: '/usr/bin:/bin', CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0' },
    billingMode: 'subscription',
    projectMcpServers: {},
    allowedTools: ['Read', 'mcp__10db__*'],
    mcp: { url: 'http://127.0.0.1:4317/mcp', token: 'session-token', toolTimeoutMs: 900_000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    ...overrides,
  };
}

interface Script {
  readonly messages: readonly SDKMessage[];
  /** After the scripted messages: end the stream, wait for input to end or an abort, or throw. */
  readonly then?: 'end' | 'hang' | { readonly throws: string };
  /** What accountInfo() answers; a pending promise holds the billing preflight open. */
  readonly account?: AccountInfo | Promise<AccountInfo>;
  readonly interruptHangs?: boolean;
  /** What mcpServerStatus() answers. */
  readonly mcpStatus?: readonly McpServerStatus[];
}

interface Record_ {
  options: Options | null;
  readonly inputs: SDKUserMessage[];
  interrupts: number;
  readonly contextCalls: unknown[];
}

/** Stands in for the SDK's query(): the test boundary for Claude Code. */
function fakeQuery(script: Script): { query: QueryFn; record: Record_ } {
  const record: Record_ = { options: null, inputs: [], interrupts: 0, contextCalls: [] };
  const query: QueryFn = ({ prompt, options }) => {
    record.options = options;
    let inputDone: () => void = () => undefined;
    const inputEnded = new Promise<void>((resolve) => {
      inputDone = resolve;
    });
    void (async () => {
      for await (const message of prompt) record.inputs.push(message);
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
      for (const message of script.messages) yield message;
      const then = script.then ?? 'end';
      if (then === 'hang') {
        await Promise.race([inputEnded, aborted]);
        if (signal?.aborted) throw new Error('Claude Code process aborted by user');
        return;
      }
      if (then !== 'end') throw new Error(then.throws);
    }
    // The adapter calls only these Query members; the rest of the interface is irrelevant here.
    return Object.assign(stream(), {
      interrupt: () => {
        record.interrupts += 1;
        return script.interruptHangs
          ? new Promise<undefined>(() => undefined)
          : Promise.resolve(undefined);
      },
      accountInfo: () =>
        Promise.resolve(
          script.account ?? { apiProvider: 'firstParty', subscriptionType: 'Claude Max' },
        ),
      mcpServerStatus: () => Promise.resolve(script.mcpStatus ?? []),
      getContextUsage: (opts?: unknown) => {
        record.contextCalls.push(opts);
        return Promise.resolve({ totalTokens: 30_000, maxTokens: 200_000, percentage: 15 });
      },
    }) as unknown as Query;
  };
  return { query, record };
}

function adapterFor(script: Script, stopGraceMs = 1_000, clock: Clock = systemClock) {
  const fake = fakeQuery(script);
  const adapter = createClaudeAdapter({
    claudePath: '/usr/local/bin/claude',
    pluginDir: '/harness',
    logger: silentLogger,
    query: fake.query,
    stopGraceMs,
    clock,
  });
  return { adapter, record: fake.record };
}

/** The message of an `ended` event, so a test can match it without an untyped asymmetric matcher. */
const endMessage = (event: SessionEvent | undefined): string =>
  event?.type === 'ended' ? (event.message ?? '') : '';

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const deps = {
  claudePath: '/usr/local/bin/claude',
  pluginDir: '/harness',
  abortController: new AbortController(),
  billingVerified: Promise.resolve(true),
  onSpawn: () => undefined,
  onStderr: () => undefined,
};

describe('buildQueryOptions', () => {
  it('runs the installed claude with project settings only, the 10db MCP server and the harness plugin', () => {
    const options = buildQueryOptions(spec(), deps);
    expect(options).toMatchObject({
      cwd: '/repo',
      model: 'sonnet',
      effort: 'medium',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      settingSources: ['project'],
      strictMcpConfig: true,
      settings: { autoCompactEnabled: true },
      plugins: [{ type: 'local', path: '/harness' }],
      allowedTools: ['Read', 'mcp__10db__*'],
      permissionMode: 'default',
      env: { PATH: '/usr/bin:/bin', CLAUDE_AGENT_SDK_CLIENT_APP: '10db/0.1.0' },
      mcpServers: {
        [CLAUDE_MCP_SERVER]: {
          type: 'http',
          url: 'http://127.0.0.1:4317/mcp',
          headers: { Authorization: 'Bearer session-token' },
          timeout: 900_000,
          alwaysLoad: true,
        },
      },
    });
    expect(options).not.toHaveProperty('resume');
  });

  it("passes the repo's MCP servers through next to 10db's own, which keeps its name", () => {
    const options = buildQueryOptions(
      spec({
        projectMcpServers: {
          mantine: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@mantine/mcp-server@9.7.2'],
            env: { PATH: '/usr/bin:/bin', HOME: '/h' },
          },
          [CLAUDE_MCP_SERVER]: { type: 'http', url: 'https://impostor.example/mcp', headers: null },
        },
      }),
      deps,
    );
    expect(options.strictMcpConfig).toBe(true);
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['mantine', CLAUDE_MCP_SERVER]);
    // Launched through env -i with the env the runner built, never with an `env` block.
    expect(options.mcpServers?.['mantine']).toEqual({
      type: 'stdio',
      command: '/usr/bin/env',
      args: ['-i', 'PATH=/usr/bin:/bin', 'HOME=/h', 'npx', '-y', '@mantine/mcp-server@9.7.2'],
    });
    expect(options.mcpServers?.[CLAUDE_MCP_SERVER]).toMatchObject({
      url: 'http://127.0.0.1:4317/mcp',
    });
  });

  it('resumes when the spec names a provider session', () => {
    expect(buildQueryOptions(spec({ resumeProviderSessionId: 'prov-9' }), deps).resume).toBe(
      'prov-9',
    );
  });

  it('bridges canUseTool to the spec with the tool use id and signal', async () => {
    const canUseTool = vi.fn<SessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'deny', message: 'Parked', interrupt: true }),
    );
    const options = buildQueryOptions(spec({ canUseTool }), deps);
    const signal = new AbortController().signal;
    const result = await options.canUseTool?.(
      'Bash',
      { command: 'curl x' },
      { signal, toolUseID: 'toolu_7', requestId: 'req_1' },
    );
    expect(canUseTool).toHaveBeenCalledWith({
      toolName: 'Bash',
      input: { command: 'curl x' },
      toolUseId: 'toolu_7',
      signal,
    });
    expect(result).toEqual({ behavior: 'deny', message: 'Parked', interrupt: true });
  });

  it('denies tools without asking the spec when billing was not verified', async () => {
    const canUseTool = vi.fn<SessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'allow' }),
    );
    const preToolUse = vi.fn(() => ({ decision: 'allow' as const }));
    const options = buildQueryOptions(spec({ canUseTool, preToolUse }), {
      ...deps,
      billingVerified: Promise.resolve(false),
    });
    const result = await options.canUseTool?.(
      'Read',
      { file_path: 'a.ts' },
      { signal: new AbortController().signal, toolUseID: 'toolu_2', requestId: 'req_2' },
    );
    expect(result).toMatchObject({ behavior: 'deny', interrupt: true });
    const hook = options.hooks?.PreToolUse?.[0]?.hooks[0];
    const output = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'a.ts' },
        tool_use_id: 'toolu_3',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/repo',
      },
      'toolu_3',
      { signal: new AbortController().signal },
    );
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(canUseTool).not.toHaveBeenCalled();
    expect(preToolUse).not.toHaveBeenCalled();
  });

  it('runs the guard as a PreToolUse hook', async () => {
    const preToolUse = vi.fn(() => ({ decision: 'deny' as const, reason: 'outside your claims' }));
    const hook = buildQueryOptions(spec({ preToolUse }), deps).hooks?.PreToolUse?.[0]?.hooks[0];
    const output = await hook?.(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/elsewhere/x' },
        tool_use_id: 'toolu_1',
        session_id: 's',
        transcript_path: '/t',
        cwd: '/repo',
      },
      'toolu_1',
      { signal: new AbortController().signal },
    );
    expect(preToolUse).toHaveBeenCalledWith({
      toolName: 'Write',
      input: { file_path: '/elsewhere/x' },
    });
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'outside your claims',
      },
    });
  });

  it('spawns claude itself, reporting the pid and stderr, and stops it on abort', async () => {
    const pids: (number | null)[] = [];
    const stderr: string[] = [];
    const abort = new AbortController();
    const options = buildQueryOptions(spec(), {
      ...deps,
      onSpawn: (pid) => pids.push(pid),
      onStderr: (chunk) => stderr.push(chunk),
    });
    const child: SpawnedProcess | undefined = options.spawnClaudeCodeProcess?.({
      command: '/bin/sh',
      args: ['-c', 'echo starting >&2; sleep 30'],
      env: { PATH: '/usr/bin:/bin' },
      signal: abort.signal,
    });
    const exited = new Promise<string | null>((resolve) => {
      child?.once('exit', (_code, signal) => {
        resolve(signal);
      });
    });
    expect(pids[0]).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(stderr.join('')).toContain('starting');
    });
    abort.abort();
    expect(await exited).toBe('SIGTERM');
  });
});

describe('createClaudeAdapter', () => {
  it('emits started, activity, context, turn_complete, then ended exactly once', async () => {
    const { adapter, record } = adapterFor({
      messages: [
        initMessage(),
        assistantMessage([textBlock('Looking.'), toolUseBlock('Read', { file_path: 'a.ts' })]),
        resultMessage({ input: 100, output: 10, costUsd: 0.01 }),
      ],
    });
    const events = await collect(adapter.start(spec()).events);
    expect(events[0]).toEqual({ type: 'started', providerSessionId: PROVIDER_SESSION, pid: null });
    expect(events).toContainEqual({ type: 'activity', kind: 'text', summary: 'Looking.' });
    expect(events).toContainEqual({ type: 'activity', kind: 'tool', summary: 'Read a.ts' });
    expect(events).toContainEqual({
      type: 'turn_complete',
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.01,
    });
    expect(events.filter((e) => e.type === 'ended')).toEqual([
      { type: 'ended', reason: 'completed', message: null },
    ]);
    expect(events.at(-1)?.type).toBe('ended');
    expect(record.contextCalls).toEqual([{ detail: 'summary' }]);
    expect(record.inputs[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Task: Alpha\nDo it.' },
      parent_tool_use_id: null,
    });
  });

  it('reports context after an assistant message', async () => {
    const { adapter } = adapterFor({
      messages: [initMessage(), assistantMessage([textBlock('hi')])],
      then: 'hang',
    });
    const handle = adapter.start(spec());
    const seen: SessionEvent[] = [];
    const done = (async () => {
      for await (const event of handle.events) {
        seen.push(event);
        if (event.type === 'context') await handle.stop();
      }
    })();
    await done;
    expect(seen).toContainEqual({
      type: 'context',
      percentage: 15,
      totalTokens: 30_000,
      maxTokens: 200_000,
    });
  });

  it('emits started once even though the CLI sends init at the start of every turn', async () => {
    const { adapter } = adapterFor({
      messages: [
        initMessage(),
        resultMessage({ input: 1, output: 1, costUsd: 0 }),
        initMessage(),
        resultMessage({ input: 1, output: 1, costUsd: 0 }),
      ],
    });
    const events = await collect(adapter.start(spec()).events);
    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
  });

  it('logs the MCP servers the CLI reports at the first init, and their status after the first turn, once each', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'info',
      destination: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      },
    });
    const servers = [
      { name: '10db', status: 'connected' },
      { name: 'mantine', status: 'pending' },
    ];
    const fake = fakeQuery({
      messages: [
        initMessage('none', servers),
        resultMessage({ input: 1, output: 1, costUsd: 0 }),
        initMessage('none', servers),
        resultMessage({ input: 1, output: 1, costUsd: 0 }),
      ],
      mcpStatus: [
        { name: '10db', status: 'connected' },
        {
          name: 'mantine',
          status: 'connected',
          config: {
            type: 'http',
            url: 'https://x',
            headers: { Authorization: 'Bearer secret-value' },
          },
        },
      ],
    });
    const adapter = createClaudeAdapter({
      claudePath: '/usr/local/bin/claude',
      pluginDir: '/harness',
      logger,
      query: fake.query,
    });
    await collect(adapter.start(spec()).events);
    expect(lines.filter((l) => l['msg'] === 'claude session mcp')).toEqual([
      expect.objectContaining({ mcpServers: servers }),
    ]);
    // After the first turn the status is read once more, because init often reports `pending`.
    await vi.waitFor(() => {
      expect(lines.filter((l) => l['msg'] === 'claude session mcp status')).toEqual([
        expect.objectContaining({
          mcpServers: [
            { name: '10db', status: 'connected' },
            { name: 'mantine', status: 'connected' },
          ],
        }),
      ]);
    });
    expect(JSON.stringify(lines)).not.toContain('secret-value');
  });

  it('reports running token totals and the cumulative cost', async () => {
    const { adapter } = adapterFor({
      messages: [
        initMessage(),
        resultMessage({ input: 100, output: 10, costUsd: 0.01 }),
        resultMessage({ input: 50, output: 5, costUsd: 0.015 }),
      ],
    });
    const turns = (await collect(adapter.start(spec()).events)).filter(
      (e) => e.type === 'turn_complete',
    );
    expect(turns).toEqual([
      { type: 'turn_complete', inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
      { type: 'turn_complete', inputTokens: 150, outputTokens: 15, costUsd: 0.015 },
    ]);
  });

  it('never sends the prompt when the billing preflight shows Bedrock on a subscription project', async () => {
    const { adapter, record } = adapterFor({
      messages: [initMessage('none'), assistantMessage([textBlock('working')])],
      then: 'hang',
      account: { apiProvider: 'bedrock' },
    });
    const events = await collect(adapter.start(spec()).events);
    expect(events.map((e) => e.type)).toEqual(['ended']);
    expect(events[0]).toMatchObject({ type: 'ended', reason: 'error' });
    expect(endMessage(events[0])).toMatch(
      /^Billing check failed: expected the Claude subscription.*No prompt was sent/,
    );
    expect(record.inputs).toEqual([]);
    expect(record.interrupts).toBe(1);
  });

  it('holds tool calls until the preflight answers, then denies them when it fails', async () => {
    let answer: (info: AccountInfo) => void = () => undefined;
    const account = new Promise<AccountInfo>((resolve) => {
      answer = resolve;
    });
    const canUseTool = vi.fn<SessionSpec['canUseTool']>(() =>
      Promise.resolve({ behavior: 'allow' }),
    );
    const { adapter, record } = adapterFor({ messages: [], then: 'hang', account });
    const done = collect(adapter.start(spec({ canUseTool })).events);
    const bridge = record.options?.canUseTool;
    if (!bridge) throw new Error('the adapter passed no canUseTool');
    let settled = false;
    const decision = bridge(
      'Write',
      { file_path: 'x.txt' },
      { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'req_1' },
    ).then((d) => {
      settled = true;
      return d;
    });
    // One turn of the event loop lets every pending microtask run: the call must still be waiting on the preflight.
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(record.inputs).toEqual([]);
    answer({ apiProvider: 'bedrock' });
    expect(await decision).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(canUseTool).not.toHaveBeenCalled();
    const last = (await done).at(-1);
    expect(last).toMatchObject({ type: 'ended', reason: 'error' });
    expect(endMessage(last)).toContain('Billing check failed');
    expect(record.inputs).toEqual([]);
  });

  it('ends a subscription session whose project settings re-added an API key', async () => {
    // A repo's committed .claude/settings.json can carry an env block; settingSources ['project'] loads it.
    const { adapter } = adapterFor({ messages: [initMessage('ANTHROPIC_API_KEY')], then: 'hang' });
    const events = await collect(adapter.start(spec()).events);
    expect(events.map((e) => e.type)).toEqual(['ended']);
    expect(events[0]).toMatchObject({ type: 'ended', reason: 'error' });
    expect(endMessage(events[0])).toContain('apiKeySource ANTHROPIC_API_KEY');
  });

  it('accepts a Bedrock session when the project bills to Bedrock', async () => {
    const { adapter } = adapterFor({
      messages: [initMessage('none'), resultMessage({ input: 1, output: 1, costUsd: 0 })],
      account: { apiProvider: 'bedrock' },
    });
    const events = await collect(
      adapter.start(
        spec({
          billingMode: 'bedrock',
          env: { PATH: '/bin', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' },
        }),
      ).events,
    );
    expect(events.map((e) => e.type)).toEqual(['started', 'turn_complete', 'ended']);
  });

  it('delivers send() to the input stream with next priority, never ahead of the prompt', async () => {
    const { adapter, record } = adapterFor({ messages: [initMessage()], then: 'hang' });
    const handle = adapter.start(spec());
    const done = collect(handle.events);
    // Sent while the billing preflight is still running: it must still arrive after the prompt.
    handle.send('Finish this step, then call write_handoff.');
    await vi.waitFor(() => {
      expect(record.inputs).toHaveLength(2);
    });
    await handle.stop();
    await done;
    expect(record.inputs[0]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Task: Alpha\nDo it.' },
      parent_tool_use_id: null,
    });
    expect(record.inputs[1]).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Finish this step, then call write_handoff.' },
      parent_tool_use_id: null,
      priority: 'next',
    });
  });

  it('stops cleanly: interrupt, input ends, ended stopped, and stop resolves after ended', async () => {
    const { adapter, record } = adapterFor({ messages: [initMessage()], then: 'hang' });
    const handle = adapter.start(spec());
    const done = collect(handle.events);
    await handle.stop();
    const events = await done;
    expect(record.interrupts).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'stopped', message: null });
    expect(events.filter((e) => e.type === 'ended')).toHaveLength(1);
  });

  it('gives up on an interrupt that never answers after the grace period, and still ends stopped', async () => {
    const clock = new ManualClock();
    const { adapter, record } = adapterFor(
      { messages: [initMessage()], then: 'hang', interruptHangs: true },
      50,
      clock,
    );
    const handle = adapter.start(spec());
    const done = collect(handle.events);
    await vi.waitFor(() => {
      expect(record.inputs).toHaveLength(1);
    });
    let returned = false;
    const stopped = handle.stop().then(() => {
      returned = true;
    });
    expect(record.interrupts).toBe(1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(false);
    clock.advance(50);
    await stopped;
    expect((await done).at(-1)).toEqual({ type: 'ended', reason: 'stopped', message: null });
  });

  it('ends with error and the message when the stream throws', async () => {
    const { adapter } = adapterFor({
      messages: [initMessage()],
      then: { throws: 'Claude Code process exited with code 1' },
    });
    const events = await collect(adapter.start(spec()).events);
    expect(events.at(-1)).toEqual({
      type: 'ended',
      reason: 'error',
      message: 'Claude Code process exited with code 1',
    });
  });

  it('gives an assistant rate_limit error the reset time of the latest rate_limit_event', async () => {
    const { adapter } = adapterFor({
      messages: [
        initMessage(),
        rateLimitEvent({ status: 'allowed_warning', resetsAt: 1_791_000_000 }),
        assistantMessage([], 'rate_limit'),
      ],
    });
    const limits = (await collect(adapter.start(spec()).events)).filter(
      (e) => e.type === 'rate_limit',
    );
    expect(limits.at(-1)).toEqual({
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: new Date(1_791_000_000_000),
    });
  });

  it('ends rate_limited when a rejected limit is the last word before the stream ends', async () => {
    const { adapter } = adapterFor({
      messages: [initMessage(), rateLimitEvent({ status: 'rejected', resetsAt: 1_791_000_000 })],
    });
    const events = await collect(adapter.start(spec()).events);
    expect(events).toContainEqual({
      type: 'rate_limit',
      status: 'rejected',
      resetsAt: new Date(1_791_000_000_000),
    });
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'rate_limited', message: null });
  });

  it('ignores send() and stop() after the session ended', async () => {
    const { adapter, record } = adapterFor({ messages: [initMessage()] });
    const handle = adapter.start(spec());
    await collect(handle.events);
    handle.send('late');
    await handle.stop();
    expect(record.inputs).toHaveLength(1);
    expect(record.interrupts).toBe(0);
  });
});
