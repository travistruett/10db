import { describe, expect, it } from 'vitest';
import { FAKE_SRT, SANDBOXED } from '../../test/fixtures';
import { sandboxedMcpServer } from '../../test/sandboxed-mcp';
import {
  interruptReceipt,
  mapSdkMessage,
  resetsAtToDate,
  SUMMARY_CHARS,
  toHookOutput,
  toPermissionResult,
  toSdkMcpServer,
  userMessage,
} from './claude-mapping';
import { createClaudeStreamState } from './claude-stream';
import {
  assistantMessage,
  backgroundTasksChanged,
  blockStart,
  commandsChanged,
  compactBoundary,
  initMessage,
  messageStart,
  PROVIDER_SESSION,
  rateLimitEvent,
  resultMessage,
  streamEvent,
  textBlock,
  textDelta,
  toolResultMessage,
  toolUseBlock,
} from './claude-test-support';
import { createClaudeToolCalls } from './claude-tool-calls';
import type { SessionMcpServer } from './types';

/** A session's mapping state; `streamed` names messages that came as partial frames first. */
function mapping(streamed: readonly string[] = []) {
  const stream = createClaudeStreamState();
  for (const id of streamed) stream.streamed.add(id);
  return {
    pid: 4242,
    stream,
    calls: createClaudeToolCalls({
      now: () => new Date('2026-11-12T10:00:00.000Z'),
      before: () => ({ kind: 'unread' }),
    }),
  };
}

// The rows below that only read activity run as if `msg_1` had streamed, so it brings no message.
const ctx = mapping(['msg_1']);
const TOOK_FIRST = '01a1b2c3-0000-7000-8000-000000000001';
const TOOK_SECOND = '01a1b2c3-0000-7000-8000-000000000002';

describe('mapSdkMessage', () => {
  it('maps init to started with the provider session id and pid', () => {
    expect(mapSdkMessage(initMessage(), ctx)).toEqual([
      { type: 'started', providerSessionId: PROVIDER_SESSION, pid: 4242 },
    ]);
  });

  it('maps each text block to activity, skipping empty text, and each tool use to a running tool call', () => {
    const msg = assistantMessage([
      textBlock('  Reading the task.  '),
      textBlock('   '),
      toolUseBlock('Bash', { command: 'pnpm test' }),
    ]);
    expect(mapSdkMessage(msg, mapping(['msg_1']))).toMatchObject([
      { type: 'activity', kind: 'text', summary: 'Reading the task.' },
      {
        type: 'tool_call',
        call: { id: 'toolu_1', kind: 'command', command: 'pnpm test', status: 'running' },
      },
    ]);
  });

  it('routes a stream event to the stream', () => {
    const state = mapping();
    mapSdkMessage(streamEvent(messageStart('msg_5')), state);
    mapSdkMessage(streamEvent(blockStart(0, 'text')), state);
    expect(mapSdkMessage(streamEvent(textDelta(0, 'Hi')), state)).toEqual([
      { type: 'text_delta', itemId: 'msg_5:0', offset: 0, text: 'Hi' },
    ]);
  });

  it('an assistant text whose message streamed gives activity only', () => {
    const state = mapping();
    mapSdkMessage(streamEvent(messageStart('msg_9')), state);
    expect(
      mapSdkMessage(assistantMessage([textBlock('Hello')], undefined, 'msg_9'), state),
    ).toEqual([{ type: 'activity', kind: 'text', summary: 'Hello' }]);
  });

  it("an assistant text whose message didn't stream gives activity and the message", () => {
    const state = mapping();
    expect(
      mapSdkMessage(assistantMessage([textBlock('Hello')], undefined, 'msg_9'), state),
    ).toEqual([
      { type: 'activity', kind: 'text', summary: 'Hello' },
      { type: 'message', itemId: 'msg_9:a0', text: 'Hello' },
    ]);
    expect(
      mapSdkMessage(assistantMessage([textBlock('Again')], undefined, 'msg_9'), state),
    ).toContainEqual({ type: 'message', itemId: 'msg_9:a1', text: 'Again' });
  });

  it("a subagent's assistant text gives no message, and its tool use names its parent", () => {
    const events = mapSdkMessage(
      assistantMessage(
        [textBlock('inner'), toolUseBlock('Read', { file_path: 'a.ts' }, 'toolu_2')],
        undefined,
        'msg_3',
        'toolu_9',
      ),
      mapping(),
    );
    expect(events.filter((e) => e.type === 'message')).toEqual([]);
    expect(events.filter((e) => e.type === 'tool_call')).toMatchObject([
      { call: { id: 'toolu_2', parentId: 'toolu_9' } },
    ]);
  });

  it('TodoWrite gives a plan update', () => {
    expect(
      mapSdkMessage(
        assistantMessage([
          toolUseBlock('TodoWrite', { todos: [{ content: 'Read', status: 'in_progress' }] }),
        ]),
        mapping(['msg_1']),
      ),
    ).toEqual([{ type: 'plan_update', steps: [{ text: 'Read', status: 'in_progress' }] }]);
  });

  it("a user frame's tool result finishes its call", () => {
    const state = mapping(['msg_1']);
    mapSdkMessage(assistantMessage([toolUseBlock('Bash', { command: 'ls' })]), state);
    expect(mapSdkMessage(toolResultMessage('toolu_1', 'a.ts\n'), state)).toMatchObject([
      { type: 'tool_call', call: { id: 'toolu_1', status: 'done', outputTail: 'a.ts\n' } },
    ]);
  });

  it('a commands push gives the commands, leaving out an empty hint', () => {
    expect(
      mapSdkMessage(
        commandsChanged([
          { name: 'compact', description: 'Compact', argumentHint: '' },
          { name: 'review', description: 'Review', argumentHint: '<pr>' },
        ]),
        mapping(),
      ),
    ).toEqual([
      {
        type: 'commands',
        commands: [
          { name: 'compact', description: 'Compact' },
          { name: 'review', description: 'Review', argumentHint: '<pr>' },
        ],
      },
    ]);
  });

  it.each<[string, { user_message_uuid?: string; user_message_uuids?: string[] }, string[] | null]>(
    [
      [
        'every uuid the turn took so far',
        { user_message_uuid: TOOK_SECOND, user_message_uuids: [TOOK_FIRST, TOOK_SECOND] },
        [TOOK_FIRST, TOOK_SECOND],
      ],
      ['the one uuid an older producer stamps', { user_message_uuid: TOOK_FIRST }, [TOOK_FIRST]],
      ['nothing for a frame with no stamp', {}, null],
    ],
  )('maps an assistant message to the uuids its turn consumed: %s', (_name, stamp, uuids) => {
    const events = mapSdkMessage({ ...assistantMessage([textBlock('On it.')]), ...stamp }, ctx);
    expect(events).toEqual([
      { type: 'activity', kind: 'text', summary: 'On it.' },
      ...(uuids === null ? [] : [{ type: 'consumed', uuids }]),
    ]);
  });

  // A message folded into a running turn between tool rounds is stamped on no later assistant
  // message: the turn's result lists it, which the live test saw on the pinned Claude Code.
  it.each<[string, { user_message_uuid?: string; user_message_uuids?: string[] }, string[] | null]>(
    [
      [
        'the prompt and each message folded in',
        { user_message_uuid: TOOK_FIRST, user_message_uuids: [TOOK_FIRST, TOOK_SECOND] },
        [TOOK_FIRST, TOOK_SECOND],
      ],
      ['the one uuid an older producer echoes', { user_message_uuid: TOOK_FIRST }, [TOOK_FIRST]],
      ['nothing for a turn with no client uuid', {}, null],
    ],
  )(
    'maps a result to the uuids its turn consumed, before the turn ends: %s',
    (_name, stamp, uuids) => {
      const events = mapSdkMessage(
        { ...resultMessage({ input: 1, output: 1, costUsd: 0 }), ...stamp },
        ctx,
      );
      expect(events.map((e) => e.type)).toEqual([
        ...(uuids === null ? [] : ['consumed']),
        'turn_complete',
      ]);
      if (uuids !== null) expect(events[0]).toEqual({ type: 'consumed', uuids });
    },
  );

  it('caps activity summaries', () => {
    const [event] = mapSdkMessage(assistantMessage([textBlock('x'.repeat(5_000))]), ctx);
    expect(event).toMatchObject({ type: 'activity' });
    expect(event?.type === 'activity' ? event.summary.length : 0).toBe(SUMMARY_CHARS);
  });

  it('turns an assistant rate_limit error into a rejected rate limit', () => {
    expect(mapSdkMessage(assistantMessage([], 'rate_limit'), ctx)).toEqual([
      {
        type: 'rate_limit',
        status: 'rejected',
        resetsAt: null,
        utilization: null,
        limitType: null,
      },
    ]);
  });

  it('maps a result to turn_complete with cache reads apart from input', () => {
    expect(
      mapSdkMessage(
        resultMessage({
          input: 100,
          output: 20,
          cacheRead: 900,
          cacheCreation: 50,
          costUsd: 0.0123,
        }),
        ctx,
      ),
    ).toEqual([
      {
        type: 'turn_complete',
        inputTokens: 150,
        outputTokens: 20,
        cachedTokens: 900,
        costUsd: 0.0123,
      },
    ]);
  });

  it.each([
    { subtype: 'error_max_turns', isError: true, result: 'max_turns' },
    { subtype: 'error_during_execution', isError: true, result: 'error' },
    { subtype: 'error_max_budget_usd', isError: true, result: 'error' },
    { subtype: 'success', isError: true, result: 'error' },
  ])('says how a $subtype result (is_error $isError) ended the turn: $result', (c) => {
    const message = {
      ...resultMessage({ input: 1, output: 1, costUsd: 0 }),
      subtype: c.subtype,
      is_error: c.isError,
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    expect(mapSdkMessage(message, ctx)).toMatchObject([
      { type: 'turn_complete', result: c.result },
    ]);
  });

  it('maps rate limit events, with the reset time', () => {
    expect(
      mapSdkMessage(rateLimitEvent({ status: 'allowed_warning', resetsAt: 1_791_000_000 }), ctx),
    ).toEqual([
      {
        type: 'rate_limit',
        status: 'allowed_warning',
        resetsAt: new Date(1_791_000_000_000),
        utilization: null,
        limitType: null,
      },
    ]);
  });

  it('carries the utilization and the limit type, and drops a utilization outside 0 to 1', () => {
    expect(
      mapSdkMessage(
        rateLimitEvent({
          status: 'allowed_warning',
          resetsAt: 1_791_000_000,
          utilization: 0.96,
          rateLimitType: 'five_hour',
        }),
        ctx,
      ),
    ).toEqual([
      {
        type: 'rate_limit',
        status: 'allowed_warning',
        resetsAt: new Date(1_791_000_000_000),
        utilization: 0.96,
        limitType: 'five_hour',
      },
    ]);
    expect(
      mapSdkMessage(rateLimitEvent({ status: 'allowed_warning', utilization: 96 }), ctx),
    ).toEqual([expect.objectContaining({ utilization: null })]);
  });

  it('ignores a utilization or a limit type of the wrong type, which the SDK types do not guarantee', () => {
    // Claude Code's payload is not verified against its types: a string that would coerce is no share.
    const odd = { status: 'allowed_warning', utilization: '0.96', rateLimitType: 5 };
    expect(
      mapSdkMessage(rateLimitEvent(odd as unknown as Parameters<typeof rateLimitEvent>[0]), ctx),
    ).toEqual([expect.objectContaining({ utilization: null, limitType: null })]);
  });

  it('treats spending extra usage as a rejected limit, so lanes pause instead of billing overage', () => {
    expect(
      mapSdkMessage(
        rateLimitEvent({
          status: 'allowed',
          resetsAt: 1_791_000_000,
          isUsingOverage: true,
          overageResetsAt: 1_791_500_000,
        }),
        ctx,
      ),
    ).toEqual([
      {
        type: 'rate_limit',
        status: 'rejected',
        resetsAt: new Date(1_791_500_000_000),
        utilization: null,
        limitType: null,
      },
    ]);
  });

  it('maps a compact boundary to compacted', () => {
    expect(mapSdkMessage(compactBoundary('auto'), ctx)).toEqual([
      { type: 'compacted', trigger: 'auto' },
    ]);
  });

  it('maps the live background tasks to the commands the lane is waiting on, leaving out ambient ones', () => {
    const msg = backgroundTasksChanged([
      { task_id: 'b1', task_type: 'local_bash', description: 'pnpm exec vitest run a.test.ts' },
      { task_id: 'w1', task_type: 'watcher', description: 'a live-update watcher', ambient: true },
    ]);
    expect(mapSdkMessage(msg, ctx)).toEqual([
      {
        type: 'background_tasks',
        tasks: [{ id: 'b1', description: 'pnpm exec vitest run a.test.ts' }],
      },
    ]);
  });

  it('maps an empty set of background tasks, which is how the lane learns they finished', () => {
    expect(mapSdkMessage(backgroundTasksChanged([]), ctx)).toEqual([
      { type: 'background_tasks', tasks: [] },
    ]);
  });
});

describe('interruptReceipt', () => {
  it.each<[string, { still_queued: string[] } | undefined, ReturnType<typeof interruptReceipt>]>([
    ['the uuids still queued', { still_queued: [TOOK_FIRST] }, { stillQueued: [TOOK_FIRST] }],
    ['an empty queue', { still_queued: [] }, { stillQueued: [] }],
    ['no receipt from a Claude Code that does not advertise one', undefined, null],
  ])('reports %s', (_name, answer, receipt) => {
    expect(interruptReceipt(answer)).toEqual(receipt);
  });
});

describe('resetsAtToDate', () => {
  it.each([
    [undefined, null],
    [0, null],
    [1_791_000_000, new Date(1_791_000_000_000)],
    [1_791_000_000_000, new Date(1_791_000_000_000)],
  ])('%s → %s', (value, expected) => {
    expect(resetsAtToDate(value)).toEqual(expected);
  });
});

describe('permission and hook translation', () => {
  it('allows with the original input unless the decision rewrote it', () => {
    expect(toPermissionResult({ behavior: 'allow' }, { command: 'ls' })).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls' },
    });
    expect(
      toPermissionResult(
        { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } },
        { questions: [] },
      ),
    ).toEqual({ behavior: 'allow', updatedInput: { answers: { Q: 'A' } } });
  });

  it('passes a denial message and interrupt through', () => {
    expect(
      toPermissionResult({ behavior: 'deny', message: 'Parked', interrupt: true, by: '10db' }, {}),
    ).toEqual({
      behavior: 'deny',
      message: 'Parked',
      interrupt: true,
    });
    expect(toPermissionResult({ behavior: 'deny', message: 'No', by: '10db' }, {})).toEqual({
      behavior: 'deny',
      message: 'No',
    });
  });

  it('turns a guard denial into a PreToolUse deny with the reason', () => {
    expect(toHookOutput({ decision: 'allow' })).toEqual({});
    expect(
      toHookOutput({ decision: 'deny', reason: 'outside your claims; call request_claim' }),
    ).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'outside your claims; call request_claim',
      },
    });
  });

  it('turns a guard ask into a PreToolUse ask with the reason, so the call reaches canUseTool', () => {
    expect(toHookOutput({ decision: 'ask', reason: '10db judges every WebFetch.' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: '10db judges every WebFetch.',
      },
    });
  });

  it('turns a settled allow into a PreToolUse allow, so neither the classifier nor a card follows', () => {
    expect(toHookOutput({ decision: 'allow', settled: 'Every part only reads.' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Every part only reads.',
      },
    });
  });

  it('builds a user message, with a priority when given', () => {
    expect(userMessage('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    });
    expect(userMessage('nudge', 'next')).toMatchObject({ priority: 'next' });
    expect(userMessage('nudge', 'next')).not.toHaveProperty('uuid');
  });

  it("carries a builder message's uuid as the client uuid a turn that takes it stamps", () => {
    expect(userMessage('Make it blue', 'next', [], TOOK_FIRST)).toMatchObject({
      uuid: TOOK_FIRST,
      priority: 'next',
    });
  });

  it('sends a dropped image as an image content block after the text', () => {
    expect(userMessage('look', 'next', [{ mediaType: 'image/png', data: 'AAAA' }]).message).toEqual(
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    );
  });

  it('keeps a plain string when there is no image', () => {
    expect(userMessage('hi', undefined, []).message.content).toBe('hi');
  });
});

describe('toSdkMcpServer', () => {
  // The sandboxed launch is made under a short root in the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)(
    'hands Claude Code a stdio server only as its sandboxed launch, with no env block',
    async () => {
      const made = await sandboxedMcpServer({
        command: 'npx',
        args: ['-y', 'x'],
        env: {},
        hosts: [],
      });
      try {
        const config = toSdkMcpServer(made.server);
        // env -i with a system PATH, then srt's host with its sealed settings, then the command inside.
        expect(config).toEqual({
          type: 'stdio',
          command: '/usr/bin/env',
          args: [
            '-i',
            'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
            expect.stringMatching(/^HOME=\//),
            expect.stringMatching(
              /^CLAUDE_CODE_TMPDIR=(?:\/private)?\/tmp\/sbx-[^/]+\/t\/[A-Za-z0-9]{6}$/,
            ),
            // srt's debug log says which host its proxy refused; the preload carries that out.
            'SRT_DEBUG=1',
            FAKE_SRT.node,
            '-r',
            expect.stringMatching(/\/10db-mcp-[0-9a-f]+\.cjs$/),
            FAKE_SRT.cli,
            '--settings',
            expect.stringMatching(/\/10db-mcp-[0-9a-f]+\.json$/),
            '-c',
            // srt's proxy variables, by name only, then the sealed env file.
            expect.stringMatching(
              /^exec \/usr\/bin\/env -i (?:[A-Za-z_]+="\$[A-Za-z_]+" )+\/bin\/sh -c '\. "\$0" && exec "\$@"' '[^']+\/10db-mcp-[0-9a-f]+\.sh' 'npx' '-y' 'x'$/,
            ),
          ],
        });
        // No `env` block: Claude Code would merge it over the session environment.
        expect(config).not.toHaveProperty('env');
        // Each call hands out its own copy: changing one changes no later launch.
        if (config.type !== 'stdio') throw new Error('not a stdio config');
        config.args?.push('--inject');
        expect(toSdkMcpServer(made.server)).toEqual({ ...config, args: config.args?.slice(0, -1) });
      } finally {
        made.cleanup();
      }
    },
  );

  // The sandboxed launch is made under a short root in the shared `/tmp`, which no sandbox can write.
  it.skipIf(SANDBOXED)(
    'takes no stdio server that skipped the sandbox, nor a copy of a sandboxed one with its own arguments',
    async () => {
      const unsandboxed = { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: {} } as const;
      // @ts-expect-error a stdio server reaches a session only through the lane sandbox
      const plain: SessionMcpServer = unsandboxed;
      expect(toSdkMcpServer(plain)).not.toHaveProperty('command');
      const made = await sandboxedMcpServer({
        command: 'npx',
        args: ['-y', 'x'],
        env: {},
        hosts: [],
      });
      try {
        // eslint-disable-next-line @typescript-eslint/no-misused-spread -- the copy is the bypass under test
        const copy = { ...made.server, args: ['-c', 'npx -y x'] };
        // @ts-expect-error a copy keeps no launch: only the sandbox makes one
        const copied: SessionMcpServer = copy;
        // Nothing to run: the launch lives only in the sandbox's own object.
        const config = toSdkMcpServer(copied);
        expect(config).not.toHaveProperty('command');
        expect(config).not.toHaveProperty('args');
      } finally {
        made.cleanup();
      }
    },
  );

  it('passes HTTP and SSE servers with their expanded headers, leaving out a block the repo did not declare', () => {
    expect(toSdkMcpServer({ type: 'http', url: 'https://d/mcp', headers: { A: 'b' } })).toEqual({
      type: 'http',
      url: 'https://d/mcp',
      headers: { A: 'b' },
    });
    expect(toSdkMcpServer({ type: 'sse', url: 'https://f', headers: null })).toEqual({
      type: 'sse',
      url: 'https://f',
    });
  });
});
