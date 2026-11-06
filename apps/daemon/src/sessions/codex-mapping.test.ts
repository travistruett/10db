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

const tokenUsage = (usage: {
  last: number;
  window: number | null;
  input?: number;
  cached?: number;
  output?: number;
}) => ({
  method: 'thread/tokenUsage/updated',
  params: {
    threadId: 'thr-1',
    turnId: 'turn-1',
    tokenUsage: {
      total: { totalTokens: usage.last * 10 },
      last: {
        totalTokens: usage.last,
        inputTokens: usage.input ?? 0,
        cachedInputTokens: usage.cached ?? 0,
        outputTokens: usage.output ?? 0,
      },
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
      [{ type: 'activity', kind: 'tool', summary: 'ls' }],
    ],
    [
      'a patch',
      itemCompleted({ type: 'fileChange', changes: [{ path: '/c/a.ts' }, { path: '/c/b.ts' }] }),
      [{ type: 'activity', kind: 'tool', summary: '/c/a.ts' }],
    ],
    [
      'an MCP call',
      itemCompleted({ type: 'mcpToolCall', server: '10db', tool: 'commit' }),
      [{ type: 'activity', kind: 'tool', summary: '10db.commit' }],
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
      { method: 'thread/compacted', params: {} },
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

  it('ends a turn with the totals of this session and the last message', () => {
    const state = createTurnState();
    const usage = { last: 1_000, window: 272_000, input: 300, cached: 30, output: 60 };
    mapCodexNotification(turnStarted, state);
    mapCodexNotification(itemCompleted({ type: 'agentMessage', text: 'working' }), state);
    mapCodexNotification(itemCompleted({ type: 'agentMessage', text: 'done' }), state);
    mapCodexNotification(tokenUsage(usage), state);
    mapCodexNotification(tokenUsage(usage), state);
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

  it('keeps the totals across turns and starts each turn with no message', () => {
    const state = createTurnState();
    const usage = { last: 1_000, window: 272_000, input: 100, cached: 0, output: 10 };
    for (const text of ['one', '']) {
      mapCodexNotification(turnStarted, state);
      if (text !== '') mapCodexNotification(itemCompleted({ type: 'agentMessage', text }), state);
      mapCodexNotification(tokenUsage(usage), state);
      const [event] = mapCodexNotification(turnCompleted({ status: 'completed' }), state);
      if (text === '') expect(event).toMatchObject({ inputTokens: 200, outputTokens: 20 });
      if (text === '') expect(event).not.toHaveProperty('text');
    }
  });

  it('counts no tokens outside a turn, though the context still shows', () => {
    const state = createTurnState();
    const usage = { last: 1_000, window: 272_000, input: 300, cached: 30, output: 60 };
    expect(mapCodexNotification(tokenUsage(usage), state)).toHaveLength(1);
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
