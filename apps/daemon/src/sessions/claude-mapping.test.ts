import { describe, expect, it } from 'vitest';
import { FAKE_SRT, SANDBOXED } from '../../test/fixtures';
import { sandboxedMcpServer } from '../../test/sandboxed-mcp';
import {
  contextEvent,
  mapSdkMessage,
  resetsAtToDate,
  SUMMARY_CHARS,
  toHookOutput,
  toolBrief,
  toPermissionResult,
  toSdkMcpServer,
  userMessage,
} from './claude-mapping';
import {
  assistantMessage,
  compactBoundary,
  initMessage,
  PROVIDER_SESSION,
  rateLimitEvent,
  resultMessage,
  textBlock,
  toolUseBlock,
} from './claude-test-support';
import type { SessionMcpServer } from './types';

const ctx = { pid: 4242 };

describe('mapSdkMessage', () => {
  it('maps init to started with the provider session id and pid', () => {
    expect(mapSdkMessage(initMessage(), ctx)).toEqual([
      { type: 'started', providerSessionId: PROVIDER_SESSION, pid: 4242 },
    ]);
  });

  it('maps each text and tool block of an assistant message to activity, skipping empty text', () => {
    const msg = assistantMessage([
      textBlock('  Reading the task.  '),
      textBlock('   '),
      toolUseBlock('Bash', { command: 'pnpm test' }),
      toolUseBlock('Edit', { file_path: 'src/a.ts', old_string: 'x' }),
    ]);
    expect(mapSdkMessage(msg, ctx)).toEqual([
      { type: 'activity', kind: 'text', summary: 'Reading the task.' },
      { type: 'activity', kind: 'tool', summary: 'Bash pnpm test' },
      { type: 'activity', kind: 'tool', summary: 'Edit src/a.ts' },
    ]);
  });

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

describe('contextEvent', () => {
  it('computes the percentage from the token counts, whatever scale the SDK uses', () => {
    expect(contextEvent({ totalTokens: 50_000, maxTokens: 200_000, percentage: 0.25 })).toEqual({
      type: 'context',
      percentage: 25,
      totalTokens: 50_000,
      maxTokens: 200_000,
    });
  });

  it.each([
    [0.4, 40],
    [40, 40],
  ])('falls back to percentage %s when maxTokens is 0', (percentage, expected) => {
    expect(contextEvent({ totalTokens: 0, maxTokens: 0, percentage }).percentage).toBe(expected);
  });
});

describe('toolBrief', () => {
  it.each([
    [{ command: 'git status' }, 'git status'],
    [{ file_path: 'src/x.ts', content: '…' }, 'src/x.ts'],
    [{ notebook_path: 'n.ipynb' }, 'n.ipynb'],
    [{ pattern: 'TODO' }, '{"pattern":"TODO"}'],
    ['plain', '"plain"'],
  ])('%o → %s', (input, expected) => {
    expect(toolBrief(input)).toBe(expected);
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
      toPermissionResult({ behavior: 'deny', message: 'Parked', interrupt: true }, {}),
    ).toEqual({
      behavior: 'deny',
      message: 'Parked',
      interrupt: true,
    });
    expect(toPermissionResult({ behavior: 'deny', message: 'No' }, {})).toEqual({
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

  it('builds a user message, with a priority when given', () => {
    expect(userMessage('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi' },
      parent_tool_use_id: null,
    });
    expect(userMessage('nudge', 'next')).toMatchObject({ priority: 'next' });
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
            expect.stringMatching(/^CLAUDE_CODE_TMPDIR=(?:\/private)?\/tmp\/sbx-[^/]+\/t\/10db-/),
            FAKE_SRT.node,
            FAKE_SRT.cli,
            '--settings',
            expect.stringMatching(/\/10db-mcp-[0-9a-f]+\.json$/),
            '-c',
            expect.stringMatching(
              /^exec \/usr\/bin\/env -i \/bin\/sh -c '\. "\$0" && exec "\$@"' '[^']+\/10db-mcp-[0-9a-f]+\.sh' 'npx' '-y' 'x'$/,
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
