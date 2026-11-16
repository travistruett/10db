import { describe, expect, it } from 'vitest';
import { needsYou, tabState, tabWidths, tabWords, TabState } from './tab-state';

const base = { openCards: 0, lastReplyAt: null, seenAt: null } as const;

describe('tabState', () => {
  const rows: readonly {
    readonly name: string;
    readonly input: Parameters<typeof tabState>[0];
    readonly want: TabState;
  }[] = [
    {
      name: 'waiting_card with one open card is needs you',
      input: { ...base, state: 'waiting_card', openCards: 1 },
      want: TabState.NeedsYou,
    },
    {
      name: 'taken_over is in your terminal',
      input: { ...base, state: 'taken_over' },
      want: TabState.InTerminal,
    },
    {
      name: 'a card wins over taken_over',
      input: { ...base, state: 'taken_over', openCards: 1 },
      want: TabState.NeedsYou,
    },
    {
      name: 'taken_over wins over a reply not yet seen',
      input: { ...base, state: 'taken_over', lastReplyAt: '2026-11-14T10:00:00.000Z' },
      want: TabState.InTerminal,
    },
    {
      name: 'a card wins over running',
      input: { ...base, state: 'running', openCards: 1 },
      want: TabState.NeedsYou,
    },
    {
      name: 'ended_error is an error',
      input: { ...base, state: 'ended_error' },
      want: TabState.Error,
    },
    {
      name: 'paused_account is paused',
      input: { ...base, state: 'paused_account' },
      want: TabState.Paused,
    },
    ...(['starting', 'running', 'stopping'] as const).map((state) => ({
      name: `${state} is working`,
      input: { ...base, state },
      want: TabState.Working,
    })),
    {
      name: 'a reply after seenAt is a new reply',
      input: {
        ...base,
        state: 'idle_warm',
        lastReplyAt: '2026-11-14T10:00:00.000Z',
        seenAt: '2026-11-14T09:00:00.000Z',
      },
      want: TabState.NewReply,
    },
    {
      name: 'a reply never seen is a new reply',
      input: { ...base, state: 'idle_warm', lastReplyAt: '2026-11-14T10:00:00.000Z' },
      want: TabState.NewReply,
    },
    {
      name: 'a seen reply is idle',
      input: {
        ...base,
        state: 'idle_warm',
        lastReplyAt: '2026-11-14T10:00:00.000Z',
        seenAt: '2026-11-14T10:00:00.000Z',
      },
      want: TabState.Idle,
    },
    {
      name: 'idle_cold with no reply is idle',
      input: { ...base, state: 'idle_cold' },
      want: TabState.Idle,
    },
  ];
  it.each(rows)('$name', ({ input, want }) => {
    expect(tabState(input)).toBe(want);
  });

  it('counts needs you, a ready page and an error for the badge and ⌘J, and no other state', () => {
    const counted = Object.values(TabState).filter(needsYou);
    expect(counted).toEqual([TabState.NeedsYou, TabState.Ready, TabState.Error]);
  });
});

describe('tabWords', () => {
  const rows: readonly {
    readonly state: TabState;
    readonly detail?: Parameters<typeof tabWords>[1];
    readonly want: ReturnType<typeof tabWords>;
  }[] = [
    {
      state: TabState.NeedsYou,
      detail: { cardTitle: 'permission to run a command' },
      want: {
        spoken: 'needs you: permission to run a command',
        mark: 'dot_yellow',
        ring: 'yellow',
        bold: false,
        dim: false,
      },
    },
    {
      state: TabState.Error,
      want: {
        spoken: 'needs you: stopped by an error',
        mark: 'alert_red',
        ring: 'red',
        bold: false,
        dim: false,
      },
    },
    {
      state: TabState.Paused,
      detail: { resumes: '15:40' },
      want: {
        spoken: 'paused: usage limit, resumes 15:40',
        mark: 'pause_orange',
        ring: null,
        bold: false,
        dim: false,
      },
    },
    {
      state: TabState.Working,
      want: { spoken: 'working', mark: 'dot_blue', ring: null, bold: false, dim: false },
    },
    {
      state: TabState.InTerminal,
      want: {
        spoken: 'in your terminal',
        mark: 'terminal_dim',
        ring: null,
        bold: false,
        dim: true,
      },
    },
    {
      state: TabState.NewReply,
      want: { spoken: 'new reply', mark: null, ring: null, bold: true, dim: false },
    },
    { state: TabState.Idle, want: { spoken: '', mark: null, ring: null, bold: false, dim: false } },
  ];
  it.each(rows)('$state', ({ state, detail, want }) => {
    expect(tabWords(state, detail)).toEqual(want);
  });
});

describe('tabWidths', () => {
  it('lets five 180 px tabs in 1,000 px keep their width', () => {
    expect(tabWidths([180, 180, 180, 180, 180], 0, 1000)).toEqual([180, 180, 180, 180, 180]);
  });
  it('shrinks the others first with eight tabs in 1,000 px and keeps the selected one whole', () => {
    const widths = tabWidths(Array<number>(8).fill(180), 2, 1000);
    expect(widths[2]).toBe(180);
    expect(widths.filter((_, i) => i !== 2).every((w) => w >= 96 && w < 180)).toBe(true);
    expect(widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });
  it('puts every other tab at 96 with twelve tabs, the selected one keeping its width', () => {
    const widths = tabWidths(Array<number>(12).fill(180), 5, 1000);
    expect(widths.map((w, i) => (i === 5 ? w : w === 96))).toEqual(
      Array.from({ length: 12 }, (_, i) => (i === 5 ? 180 : true)),
    );
  });
  it('caps a long title at 220', () => {
    expect(tabWidths([400], 0, 1000)).toEqual([220]);
  });
});
