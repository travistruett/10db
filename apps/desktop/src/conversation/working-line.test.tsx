import type { ConversationDto } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { act, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationDto } from '../test/conversation-fixtures';
import { readCall } from '../test/tool-call-fixtures';
import { cssVariablesResolver, theme } from '../theme';
import { toolDoing, WorkingLine, type WorkingLineProps } from './working-line';

// Sessions UI spec §7.5: the working line's words in each state. It never names a provider.

const PAUSED_UNTIL = '2026-11-13T15:40:00.000Z';

const ui = (props: WorkingLineProps) => (
  <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
    <div data-testid="line">
      <WorkingLine {...props} />
    </div>
  </MantineProvider>
);

const shown = (): string => screen.getByTestId('line').textContent;

function lineText(props: WorkingLineProps): string {
  render(ui(props));
  return shown();
}

const inState = (
  state: ConversationDto['state'],
  over: Partial<ConversationDto> = {},
): ConversationDto => conversationDto({ state, ...over });

describe('WorkingLine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const rows: readonly {
    readonly name: string;
    readonly props: WorkingLineProps;
    readonly words: string;
  }[] = [
    {
      name: 'starting wakes the session',
      props: { conversation: inState('starting'), streaming: null },
      words: 'Waking up the session…',
    },
    {
      name: 'running with nothing streaming counts the turn',
      props: { conversation: inState('running'), streaming: null },
      words: 'Working · 0 s',
    },
    {
      name: 'running while reasoning streams is thinking',
      props: { conversation: inState('running'), streaming: 'reasoning' },
      words: 'Thinking…',
    },
    {
      name: 'running while text streams is writing',
      props: { conversation: inState('running'), streaming: 'text' },
      words: 'Writing…',
    },
    {
      name: 'running a tool says what it does',
      props: {
        conversation: inState('running'),
        streaming: 'tool',
        tool: toolDoing(readCall({ path: 'a.ts' })),
      },
      words: 'Working · 0 s · reading a.ts',
    },
    {
      name: 'waiting on a card points at it',
      props: { conversation: inState('waiting_card'), streaming: null },
      words: 'Waiting for your answer above',
    },
    {
      name: 'stopping says so',
      props: { conversation: inState('stopping'), streaming: 'text' },
      words: 'Stopping…',
    },
    {
      name: 'paused at a usage limit says when it resumes',
      props: {
        conversation: inState('paused_account', { pausedUntil: PAUSED_UNTIL }),
        streaming: null,
      },
      words: `Paused: usage limit, resumes ${dayjs(PAUSED_UNTIL).format('HH:mm')}`,
    },
    {
      name: 'paused with no reset is the monthly limit',
      props: { conversation: inState('paused_account'), streaming: null },
      words: 'Paused: the account’s monthly limit',
    },
    ...(['idle_cold', 'idle_warm', 'taken_over', 'ended_error', 'sealed'] as const).map(
      (state) => ({
        name: `${state} draws nothing`,
        props: { conversation: inState(state), streaming: null },
        words: '',
      }),
    ),
  ];

  it.each(rows)('$name', ({ props, words }) => {
    const text = lineText(props);
    expect(text).toBe(words);
    expect(text).not.toMatch(/Claude|Codex/);
  });

  it('counts seconds, then minutes, while the turn runs', () => {
    const conversation = inState('starting');
    const { rerender } = render(ui({ conversation, streaming: null }));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    rerender(ui({ conversation: { ...conversation, state: 'running' }, streaming: null }));
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(shown()).toBe('Working · 12 s');
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(shown()).toBe('Working · 3 min');
  });
});
