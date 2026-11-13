import { describe, expect, it } from 'vitest';
import type { SessionEvent } from './types';
import {
  createTurnState,
  hasKnownShape,
  limitTypeOf,
  mapCodexNotification,
  rateLimitEvents,
} from './codex-mapping';

const AT = Date.parse('2026-11-12T10:00:00.000Z');

const itemCompleted = (item: Record<string, unknown>, completedAtMs = AT + 500) => ({
  method: 'item/completed',
  params: { threadId: 'thr-1', turnId: 'turn-1', item, completedAtMs },
});
const itemStarted = (item: Record<string, unknown>, startedAtMs = AT) => ({
  method: 'item/started',
  params: { threadId: 'thr-1', turnId: 'turn-1', item, startedAtMs },
});
const delta = (method: string, itemId: string, text: string, summaryIndex?: number) => ({
  method,
  params: {
    threadId: 'thr-1',
    turnId: 'turn-1',
    itemId,
    delta: text,
    ...(summaryIndex === undefined ? {} : { summaryIndex }),
  },
});
const lsCommand = (over: Record<string, unknown> = {}) => ({
  type: 'commandExecution',
  id: 'cmd_1',
  command: 'ls',
  cwd: '/repo',
  status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'ls' }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...over,
});
/** The tool calls among a list of events, by id and status. */
const callsIn = (events: readonly SessionEvent[]) =>
  events.flatMap((e) => (e.type === 'tool_call' ? [e.call] : []));

interface Counts {
  input: number;
  cached: number;
  output: number;
}

const tokenUsage = (usage: { last: number; window: number | null; total?: Counts }) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'thr-1',
    turnId: 'turn-1',
    tokenUsage: {
      total: {
        totalTokens: usage.last * 10,
        inputTokens: usage.total?.input ?? 0,
        cachedInputTokens: usage.total?.cached ?? 0,
        outputTokens: usage.total?.output ?? 0,
      },
      last: { totalTokens: usage.last },
      modelContextWindow: usage.window,
    },
  },
});

const U1 = 'c0ffee00-0000-4000-8000-000000000001';
const U2 = 'c0ffee00-0000-4000-8000-000000000002';
const userMessage = (clientId: string) => ({
  type: 'userMessage',
  id: `item-${clientId}`,
  clientId,
  content: [{ type: 'text', text: 'Make it blue', text_elements: [] }],
});

const turnStarted = {
  method: 'turn/started',
  params: { threadId: 'thr-1', turn: { id: 'turn-1', status: 'inProgress' } },
};
const turnCompleted = (turn: Record<string, unknown>) => ({
  method: 'turn/completed',
  params: { threadId: 'thr-1', turn: { id: 'turn-1', ...turn } },
});

describe('mapCodexNotification', () => {
  it.each([
    [
      'a message',
      itemCompleted({ type: 'agentMessage', text: 'hi' }),
      [{ type: 'activity', kind: 'text', summary: 'hi' }],
    ],
    [
      'a user message recorded under a client uuid, which no model item has followed yet',
      itemCompleted(userMessage(U1)),
      [],
    ],
    [
      'a user message with no client uuid',
      itemCompleted({ type: 'userMessage', id: 'u1', clientId: null, content: [] }),
      [],
    ],
    [
      'a user message from a Codex that names no client uuid',
      itemCompleted({ type: 'userMessage', id: 'u1', content: [] }),
      [],
    ],
    ['reasoning', itemCompleted({ type: 'reasoning' }), []],
    [
      'token use',
      tokenUsage({ last: 136_000, window: 272_000 }),
      [{ type: 'context', percentage: 50, totalTokens: 136_000, maxTokens: 272_000 }],
    ],
    [
      'token use with no window',
      tokenUsage({ last: 10, window: null }),
      [{ type: 'context', percentage: 0, totalTokens: 10, maxTokens: 0 }],
    ],
    [
      'compaction',
      itemCompleted({ type: 'contextCompaction', id: 'c1' }),
      [{ type: 'compacted', trigger: 'auto' }],
    ],
    [
      'a window',
      {
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 50, windowDurationMins: 300 } } },
      },
      [
        {
          type: 'rate_limit',
          status: 'allowed',
          utilization: 0.5,
          resetsAt: null,
          limitType: 'five_hour',
        },
      ],
    ],
    ['the deprecated compaction notice', { method: 'thread/compacted', params: {} }, []],
    ['a method 10db does not read', { method: 'turn/diff/updated', params: {} }, []],
    ['a known method with a bad shape', { method: 'turn/completed', params: {} }, []],
    [
      'a token update with a bad shape',
      { method: 'thread/tokenUsage/updated', params: { x: 1 } },
      [],
    ],
    ['an item with a bad shape', { method: 'item/completed', params: 7 }, []],
  ])('maps %s', (_name, notification, expected) => {
    expect(mapCodexNotification(notification, createTurnState())).toEqual(expected);
  });

  it.each([
    ['turn/completed with no turn', { method: 'turn/completed', params: {} }, false],
    [
      'a token update of the wrong shape',
      { method: 'thread/tokenUsage/updated', params: 3 },
      false,
    ],
    [
      'a rate limit update of the wrong shape',
      { method: 'account/rateLimits/updated', params: {} },
      false,
    ],
    ['a well-formed turn/completed', turnCompleted({ status: 'completed' }), true],
    ['an unread method', { method: 'turn/diff/updated', params: 3 }, true],
  ])('says whether %s has the shape 10db reads', (_name, notification, expected) => {
    expect(hasKnownShape(notification)).toBe(expected);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>[]]>([
    [
      'a command',
      lsCommand({ status: 'completed', exitCode: 0, aggregatedOutput: 'a.ts\n' }),
      [{ id: 'cmd_1', kind: 'command', status: 'done', outputTail: 'a.ts\n' }],
    ],
    [
      'a patch, one edit per file',
      {
        type: 'fileChange',
        id: 'fc_1',
        status: 'completed',
        changes: [
          { path: '/c/a.ts', kind: { type: 'add' }, diff: 'a\n' },
          { path: '/c/b.ts', kind: { type: 'delete' }, diff: 'b\n' },
        ],
      },
      [
        { id: 'fc_1:0', kind: 'edit', path: '/c/a.ts', change: 'add' },
        { id: 'fc_1:1', kind: 'edit', path: '/c/b.ts', change: 'delete' },
      ],
    ],
    [
      'an MCP call',
      {
        type: 'mcpToolCall',
        id: 'mcp_1',
        server: '10db',
        tool: 'commit',
        status: 'completed',
        arguments: {},
        result: { content: [] },
        error: null,
      },
      [{ id: 'mcp_1', kind: 'mcp', harnessTool: '10db.commit', status: 'done' }],
    ],
  ])('maps a completed %s to its final tool calls and no activity', (_name, item, calls) => {
    const events = mapCodexNotification(itemCompleted(item), createTurnState());
    expect(events.filter((e) => e.type === 'activity')).toEqual([]);
    expect(callsIn(events)).toMatchObject(calls);
  });

  it("follows a command's whole life: running, each piece of output, then done", () => {
    const state = createTurnState();
    const events = [
      turnStarted,
      itemStarted(lsCommand()),
      delta('item/commandExecution/outputDelta', 'cmd_1', 'a.ts\n'),
      delta('item/commandExecution/outputDelta', 'cmd_1', 'b.ts\n'),
      itemCompleted(lsCommand({ status: 'completed', exitCode: 0 })),
    ].flatMap((n) => mapCodexNotification(n, state));
    expect(callsIn(events).map((c) => c.status)).toEqual(['running', 'running', 'running', 'done']);
    expect(
      events.flatMap((e) =>
        e.type === 'tool_call' && e.appended !== undefined ? [e.appended] : [],
      ),
    ).toEqual(['a.ts\n', 'b.ts\n']);
    // Codex gave no aggregated output, so the call keeps what it streamed.
    expect(callsIn(events).at(-1)).toMatchObject({
      outputTail: 'a.ts\nb.ts\n',
      startedAt: '2026-11-12T10:00:00.000Z',
      durationMs: 500,
    });
  });

  it('offsets message deltas by JS length, then gives the message whole', () => {
    const state = createTurnState();
    const events = [
      turnStarted,
      delta('item/agentMessage/delta', 'msg_1', 'é'),
      delta('item/agentMessage/delta', 'msg_1', '😀x'),
      itemCompleted({ type: 'agentMessage', id: 'msg_1', text: 'é😀x' }),
    ].flatMap((n) => mapCodexNotification(n, state));
    expect(events.filter((e) => e.type === 'text_delta' || e.type === 'message')).toEqual([
      { type: 'text_delta', itemId: 'msg_1', offset: 0, text: 'é' },
      { type: 'text_delta', itemId: 'msg_1', offset: 1, text: '😀x' },
      { type: 'message', itemId: 'msg_1', text: 'é😀x' },
    ]);
  });

  it('starts a later reasoning summary part on a new paragraph', () => {
    const state = createTurnState();
    const events = [
      turnStarted,
      delta('item/reasoning/summaryTextDelta', 'r_1', 'First', 0),
      delta('item/reasoning/summaryTextDelta', 'r_1', 'Second', 1),
      delta('item/reasoning/summaryTextDelta', 'r_1', ' part', 1),
    ].flatMap((n) => mapCodexNotification(n, state));
    expect(events).toEqual([
      { type: 'reasoning_delta', itemId: 'r_1', offset: 0, text: 'First' },
      { type: 'reasoning_delta', itemId: 'r_1', offset: 5, text: '\n\nSecond' },
      { type: 'reasoning_delta', itemId: 'r_1', offset: 13, text: ' part' },
    ]);
  });

  it("gives the turn's plan as steps", () => {
    expect(
      mapCodexNotification(
        {
          method: 'turn/plan/updated',
          params: {
            threadId: 'thr-1',
            turnId: 'turn-1',
            explanation: null,
            plan: [{ step: 'Read', status: 'inProgress' }],
          },
        },
        createTurnState(),
      ),
    ).toEqual([{ type: 'plan_update', steps: [{ text: 'Read', status: 'in_progress' }] }]);
  });

  it('gives one final call for a tool item that completed with no start seen', () => {
    const state = createTurnState();
    mapCodexNotification(turnStarted, state);
    expect(
      callsIn(
        mapCodexNotification(itemCompleted(lsCommand({ status: 'completed', exitCode: 0 })), state),
      ),
    ).toMatchObject([{ id: 'cmd_1', status: 'done' }]);
  });

  it('gives nothing for output of an item it never saw', () => {
    const state = createTurnState();
    mapCodexNotification(turnStarted, state);
    expect(
      mapCodexNotification(delta('item/commandExecution/outputDelta', 'cmd_9', 'x'), state),
    ).toEqual([]);
  });

  it('ends a turn with the totals above the baseline and the last message', () => {
    const state = createTurnState();
    mapCodexNotification(
      tokenUsage({ last: 1, window: 1, total: { input: 100, cached: 10, output: 20 } }),
      state,
    );
    mapCodexNotification(turnStarted, state);
    mapCodexNotification(itemCompleted({ type: 'agentMessage', text: 'working' }), state);
    mapCodexNotification(itemCompleted({ type: 'agentMessage', text: 'done' }), state);
    mapCodexNotification(
      tokenUsage({ last: 1, window: 1, total: { input: 700, cached: 70, output: 140 } }),
      state,
    );
    expect(mapCodexNotification(turnCompleted({ status: 'completed' }), state)).toEqual([
      {
        type: 'turn_complete',
        inputTokens: 540,
        cachedTokens: 60,
        outputTokens: 120,
        costUsd: 0,
        text: 'done',
      },
    ]);
  });

  it('takes the thread total, not the sum of last, which repeats and estimates', () => {
    const state = createTurnState();
    mapCodexNotification(turnStarted, state);
    // Real trace of last/total: 5000/5000, 5410/5000, 300/5300.
    for (const [last, input] of [
      [5_000, 5_000],
      [5_410, 5_000],
      [300, 5_300],
      [300, 5_300],
    ] as const)
      mapCodexNotification(
        tokenUsage({ last, window: 272_000, total: { input, cached: 0, output: 0 } }),
        state,
      );
    expect(mapCodexNotification(turnCompleted({ status: 'completed' }), state)).toMatchObject([
      { inputTokens: 5_300 },
    ]);
  });

  it('counts nothing for the replay of a resumed thread, which arrives outside a turn', () => {
    const state = createTurnState();
    const total = { input: 9_000, cached: 4_000, output: 500 };
    mapCodexNotification(tokenUsage({ last: 1, window: 1, total }), state);
    mapCodexNotification(turnStarted, state);
    expect(mapCodexNotification(turnCompleted({ status: 'completed' }), state)).toEqual([
      { type: 'turn_complete', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });

  it('keeps the totals across turns and starts each turn with no message', () => {
    const state = createTurnState();
    const totals = [
      { input: 100, cached: 0, output: 10 },
      { input: 200, cached: 0, output: 20 },
    ];
    totals.forEach((total, index) => {
      mapCodexNotification(turnStarted, state);
      if (index === 0)
        mapCodexNotification(itemCompleted({ type: 'agentMessage', text: 'one' }), state);
      mapCodexNotification(tokenUsage({ last: 1_000, window: 272_000, total }), state);
      const [event] = mapCodexNotification(turnCompleted({ status: 'completed' }), state);
      if (index === 1) {
        expect(event).toMatchObject({ inputTokens: 200, outputTokens: 20 });
        expect(event).not.toHaveProperty('text');
      }
    });
  });

  it('shows the context but counts nothing before any total is known', () => {
    const state = createTurnState();
    expect(mapCodexNotification(tokenUsage({ last: 1_000, window: 272_000 }), state)).toHaveLength(
      1,
    );
    mapCodexNotification(turnStarted, state);
    expect(mapCodexNotification(turnCompleted({ status: 'completed' }), state)).toEqual([
      { type: 'turn_complete', inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0 },
    ]);
  });

  it('caps the text of a turn as the Claude adapter does', () => {
    const state = createTurnState();
    mapCodexNotification(turnStarted, state);
    mapCodexNotification(
      itemCompleted({ type: 'agentMessage', text: ` ${'x'.repeat(20_000)} ` }),
      state,
    );
    const [event] = mapCodexNotification(turnCompleted({ status: 'completed' }), state);
    expect(event?.type === 'turn_complete' ? event.text?.length : 0).toBeGreaterThan(0);
    expect(event?.type === 'turn_complete' ? event.text?.length : 0).toBeLessThan(20_000);
    expect(event?.type === 'turn_complete' ? event.text?.startsWith('x') : false).toBe(true);
  });

  it.each([
    ['failed', 'error'],
    ['interrupted', 'error'],
  ])('ends a %s turn with result %s', (status, result) => {
    const state = createTurnState();
    mapCodexNotification(turnStarted, state);
    expect(
      mapCodexNotification(turnCompleted({ status, error: { message: 'boom' } }), state),
    ).toMatchObject([{ type: 'turn_complete', result }]);
  });

  // Workbench spec §6.3: a message is consumed, not only received. Codex records a user message as a
  // turn begins to take it, before the model answers, so it counts as taken once a model item follows
  // it in the turn, as Claude Code's first assistant message stamps it, or once the turn completes.
  it.each<[string, readonly { method: string; params: unknown }[], readonly unknown[]]>([
    [
      'a model item after the message: taken, before the item',
      [turnStarted, itemCompleted(userMessage(U1)), itemCompleted({ type: 'reasoning', id: 'r' })],
      [{ type: 'consumed', uuids: [U1] }],
    ],
    [
      'two messages, then a command: both taken at once, then the command',
      [
        turnStarted,
        itemCompleted(userMessage(U1)),
        itemCompleted(userMessage(U2)),
        itemCompleted({ type: 'commandExecution', command: 'ls' }),
      ],
      // A command with no id is no call 10db can follow, so only its consumption shows.
      [{ type: 'consumed', uuids: [U1, U2] }],
    ],
    [
      'a compaction after the message: not a model answer',
      [turnStarted, itemCompleted(userMessage(U1)), itemCompleted({ type: 'contextCompaction' })],
      [{ type: 'compacted', trigger: 'auto' }],
    ],
    [
      'the turn fails before the model answered, on a usage limit: not taken',
      [
        turnStarted,
        itemCompleted(userMessage(U1)),
        turnCompleted({ status: 'failed', error: { message: 'limit' } }),
      ],
      [expect.objectContaining({ type: 'turn_complete', result: 'error' })],
    ],
    [
      'the turn is interrupted before the model answered: not taken',
      [turnStarted, itemCompleted(userMessage(U1)), turnCompleted({ status: 'interrupted' })],
      [expect.objectContaining({ type: 'turn_complete', result: 'error' })],
    ],
    [
      'the turn completes: taken, before its completion',
      [turnStarted, itemCompleted(userMessage(U1)), turnCompleted({ status: 'completed' })],
      [{ type: 'consumed', uuids: [U1] }, expect.objectContaining({ type: 'turn_complete' })],
    ],
    [
      'a message the last turn recorded and dropped is not taken by the next',
      [
        turnStarted,
        itemCompleted(userMessage(U1)),
        turnCompleted({ status: 'interrupted' }),
        turnStarted,
        itemCompleted(userMessage(U2)),
        itemCompleted({ type: 'agentMessage', text: 'done' }),
      ],
      [
        expect.objectContaining({ type: 'turn_complete' }),
        { type: 'consumed', uuids: [U2] },
        expect.objectContaining({ type: 'activity', kind: 'text' }),
      ],
    ],
  ])('takes a message on evidence: %s', (_name, notifications, expected) => {
    const state = createTurnState();
    expect(notifications.flatMap((n) => mapCodexNotification(n, state))).toEqual(expected);
  });

  it('tracks the active turn from turn/started to turn/completed', () => {
    const state = createTurnState();
    expect(state.turnId).toBeNull();
    mapCodexNotification(turnStarted, state);
    expect(state.turnId).toBe('turn-1');
    mapCodexNotification(turnCompleted({ status: 'completed' }), state);
    expect(state.turnId).toBeNull();
  });

  it('remembers the reset of the last window it saw', () => {
    const state = createTurnState();
    mapCodexNotification(
      {
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 10, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
          },
        },
      },
      state,
    );
    expect(state.lastLimit).toMatchObject({
      limitType: 'seven_day',
      resetsAt: new Date(1_800_000_000_000),
    });
  });
});

describe('rateLimitEvents', () => {
  it('turns the real plan window into one seven_day event', () => {
    expect(
      rateLimitEvents({
        primary: { usedPercent: 96.5, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
        secondary: null,
      }),
    ).toEqual([
      {
        type: 'rate_limit',
        status: 'allowed',
        utilization: 0.965,
        resetsAt: new Date(1_800_000_000_000),
        limitType: 'seven_day',
      },
    ]);
  });

  it('gives one event per window, primary first', () => {
    const events = rateLimitEvents({
      primary: { usedPercent: 10, windowDurationMins: 300 },
      secondary: { usedPercent: 20, windowDurationMins: 10_080 },
    });
    expect(events.map((e) => e.limitType)).toEqual(['five_hour', 'seven_day']);
  });

  it('gives none for a snapshot with no window', () => {
    expect(rateLimitEvents({})).toEqual([]);
  });
});

describe('limitTypeOf', () => {
  it.each([
    [300, 'five_hour'],
    [10_080, 'seven_day'],
    [null, null],
    [60, '60_minutes'],
  ])('%s is %s', (minutes, expected) => {
    expect(limitTypeOf(minutes)).toBe(expected);
  });
});
