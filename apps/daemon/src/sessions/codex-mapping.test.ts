import { describe, expect, it } from 'vitest';
import {
  createTurnState,
  hasKnownShape,
  limitTypeOf,
  mapCodexNotification,
  rateLimitEvents,
} from './codex-mapping';

const itemCompleted = (item: Record<string, unknown>) => ({
  method: 'item/completed',
  params: { threadId: 'thr-1', turnId: 'turn-1', item },
});

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
      'a command',
      itemCompleted({ type: 'commandExecution', command: 'ls' }),
      [
        {
          type: 'activity',
          kind: 'tool',
          summary: 'ls',
          tool: { name: 'command', target: 'ls', written: [] },
        },
      ],
    ],
    [
      'a patch',
      itemCompleted({ type: 'fileChange', changes: [{ path: '/c/a.ts' }, { path: '/c/b.ts' }] }),
      [
        {
          type: 'activity',
          kind: 'tool',
          summary: '/c/a.ts',
          tool: { name: 'apply_patch', target: '/c/a.ts', written: ['/c/a.ts', '/c/b.ts'] },
        },
      ],
    ],
    [
      'an MCP call',
      itemCompleted({ type: 'mcpToolCall', server: '10db', tool: 'commit' }),
      [
        {
          type: 'activity',
          kind: 'tool',
          summary: '10db.commit',
          tool: { name: '10db.commit', target: null, written: [] },
        },
      ],
    ],
    [
      'a message',
      itemCompleted({ type: 'agentMessage', text: 'hi' }),
      [{ type: 'activity', kind: 'text', summary: 'hi' }],
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
