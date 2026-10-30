import { mintId } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { batchDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { theme } from '../../theme';
import { cardSummary, TaskCard } from './task-card';

function card(props: Partial<Parameters<typeof TaskCard>[0]>) {
  render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <TaskCard task={taskDto()} workstream={undefined} peers={new Map()} {...props} />
    </MantineProvider>,
  );
}

describe('TaskCard state', () => {
  it('says a running task once, in one plain line, with no badge or persona line', () => {
    card({
      workstream: workstreamDto({
        state: 'RUNNING',
        steps: [stepDto({ personaName: 'Implementer' }), stepDto()],
      }),
    });
    expect(screen.getAllByText('Building · step 1 of 2')).toHaveLength(1);
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText(/Implementer/)).toBeNull();
    expect(screen.queryByText(/sonnet@/)).toBeNull();
  });

  it.each([
    { state: 'RUNNING', color: 'blue' },
    { state: 'WAITING_HUMAN', color: 'yellow' },
    { state: 'PAUSED_LIMIT', color: 'orange' },
    { state: 'FAILED', color: 'red' },
  ] as const)(
    'takes the border and dot of a $state task from its $color status',
    ({ state, color }) => {
      card({ workstream: workstreamDto({ state }) });
      const paper = screen.getByTestId('task-card');
      expect(paper.getAttribute('data-state-color')).toBe(color);
      expect(paper.style.borderColor).toContain(`--mantine-color-${color}-filled`);
      expect(screen.getByTestId('state-dot').getAttribute('data-color')).toBe(color);
    },
  );

  it('keeps the plain border of a queued task', () => {
    card({ workstream: workstreamDto({ state: 'QUEUED' }) });
    expect(screen.getByTestId('task-card').style.borderColor).toBe('');
  });

  it('puts no fill, left stripe or animation on the card', () => {
    card({ workstream: workstreamDto({ state: 'FAILED' }) });
    const style = screen.getByTestId('task-card').style;
    expect(style.backgroundColor).toBe('');
    expect(style.borderLeft).toBe('');
    expect(style.borderLeftWidth).toBe(style.borderWidth);
    expect(style.animation).toBe('');
  });

  it('makes a card waiting on the builder the most prominent: a thicker yellow border and the Inbox line', () => {
    card({ workstream: workstreamDto({ state: 'WAITING_HUMAN' }) });
    expect(screen.getByText('Waiting on you: answer in Inbox')).toBeTruthy();
    expect(screen.getByTestId('task-card').style.borderWidth).toBe('2px');
    card({ workstream: workstreamDto({ state: 'RUNNING' }) });
    expect(screen.getAllByTestId('task-card')[1]?.style.borderWidth).toBe('1px');
  });

  it('says finished work whose ship failed is not shipped', () => {
    card({
      workstream: workstreamDto({ state: 'DONE' }),
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
    });
    expect(screen.getByText('Not shipped: the gate failed')).toBeTruthy();
  });

  describe('review sent the work back', () => {
    const rejected = (at: string) => ({
      summary: '1. NOTE x',
      verdict: 'reject' as const,
      sessionId: mintId('Session'),
      at,
    });
    const reviewed = (sentBack: number, attempt = sentBack) =>
      workstreamDto({
        state: 'RUNNING',
        attempt,
        steps: [
          stepDto(),
          stepDto({
            role: 'review',
            tools: 'read_only',
            earlier: [rejected('2026-10-29T10:00:00.000Z'), rejected('2026-10-29T11:00:00.000Z')],
            sentBack,
          }),
        ],
      });

    it('counts the rejections against the retry limit', () => {
      card({ workstream: reviewed(2) });
      expect(screen.getByText('Review sent back 2 of 3')).toBeTruthy();
    });

    it('says it to a screen reader too', () => {
      expect(cardSummary(taskDto(), reviewed(2), new Map())).toContain('Review sent back 2 of 3.');
    });

    it('says nothing for a task no review sent back', () => {
      card({ workstream: workstreamDto({ state: 'RUNNING', steps: [stepDto(), stepDto()] }) });
      expect(screen.queryByText(/Review sent back/)).toBeNull();
    });

    it('starts over when a retry resets the attempts', () => {
      card({ workstream: reviewed(0) });
      expect(screen.queryByText(/Review sent back/)).toBeNull();
    });

    it('counts no gate failure after a retry as a send-back', () => {
      // The review sent it back before the retry; since then only the gate failed, twice.
      card({ workstream: reviewed(0, 2) });
      expect(screen.queryByText(/Review sent back/)).toBeNull();
    });
  });

  it('names the gate command while it checks', () => {
    card({ workstream: workstreamDto({ state: 'VERIFYING' }), gateCommand: 'make gate' });
    expect(screen.getByText('Checking: make gate')).toBeTruthy();
  });
});
