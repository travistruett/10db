import { mintId } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkstreamList } from '../../daemon/queries';
import { batchDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { theme } from '../../theme';
import { cardSummary, TaskCard } from './task-card';
import { failureLine } from './task-state';

function card(props: Partial<Parameters<typeof TaskCard>[0]>) {
  render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <TaskCard
        task={taskDto({ workstreamId: props.workstream?.id ?? null })}
        workstream={undefined}
        peers={new Map()}
        {...props}
      />
    </MantineProvider>,
  );
}

describe('TaskCard placement', () => {
  // The placement badge left the card face for the drawer (readable board spec §5).
  it('speaks the placement in the card summary', () => {
    expect(
      cardSummary(
        taskDto(),
        undefined,
        new Map(),
        undefined,
        null,
        null,
        null,
        undefined,
        [],
        'Separate copy',
      ),
    ).toContain('Runs in Separate copy.');
    expect(cardSummary(taskDto(), undefined, new Map())).not.toContain('Runs in');
  });
});

describe('TaskCard state', () => {
  it('says a running task once, in one plain line, with no badge or persona line', () => {
    card({
      workstream: workstreamDto({
        state: 'RUNNING',
        steps: [stepDto({ personaName: 'Implementer' }), stepDto()],
      }),
    });
    // Blue says it by the border alone (readable board spec §5); the line is for a screen reader.
    expect(screen.queryByText('Building · step 1 of 2')).toBeNull();
    expect(screen.getByTestId('task-card').getAttribute('data-state-color')).toBe('blue');
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText(/Implementer/)).toBeNull();
    expect(screen.queryByText(/sonnet@/)).toBeNull();
  });

  it.each([
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

    it('leaves the card face for the drawer', () => {
      card({ workstream: reviewed(2) });
      expect(screen.queryByText(/Review sent back/)).toBeNull();
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

  describe('shipped at the retry limit', () => {
    const rejection = {
      summary: '1. BLOCKING src/a.ts:1 no test.',
      verdict: 'reject' as const,
      sessionId: mintId('Session'),
      at: '2026-10-29T10:00:00.000Z',
    };
    const shipped = () =>
      workstreamDto({
        state: 'DONE',
        steps: [
          stepDto({ status: 'done' }),
          stepDto({
            role: 'review',
            tools: 'read_only',
            status: 'done',
            result: rejection,
            sentBack: 3,
            shippedAtLimit: {
              followUpTaskId: mintId('Task'),
              followUpTitle: 'Resolve the open findings of "Add the badge"',
            },
          }),
        ],
      });
    const LINE =
      'Shipped at the retry limit with open findings. Follow-up task: Resolve the open findings of "Add the badge"';

    it('leaves the card face for the drawer', () => {
      card({ workstream: shipped() });
      expect(screen.queryByText(/retry limit/)).toBeNull();
    });

    it('says it to a screen reader too', () => {
      expect(cardSummary(taskDto(), shipped(), new Map())).toContain(`${LINE}.`);
    });

    it('names every follow-up task when review and then QA shipped at the limit', () => {
      const workstream = shipped();
      const qa = stepDto({
        role: 'qa',
        tools: 'read_only',
        status: 'done',
        result: rejection,
        shippedAtLimit: {
          followUpTaskId: mintId('Task'),
          followUpTitle: 'Resolve the open QA findings of "Add the badge"',
        },
      });
      expect(
        cardSummary(taskDto(), { ...workstream, steps: [...workstream.steps, qa] }, new Map()),
      ).toContain(
        'Shipped at the retry limit with open findings. Follow-up tasks: Resolve the open findings of "Add the badge"; Resolve the open QA findings of "Add the badge".',
      );
    });

    it('says nothing for a task that did not ship at the limit', () => {
      card({ workstream: workstreamDto({ state: 'DONE', steps: [stepDto(), stepDto()] }) });
      expect(screen.queryByText(/retry limit/)).toBeNull();
    });
  });

  describe('a failed task', () => {
    const REASON =
      'The review step ended without calling complete_step: its last turn ended normally.';
    it.each([
      'no_result',
      'gate_failed',
      'session_failed',
      'retry_limit',
      'rejected_at_limit',
      null,
    ] as const)(
      'says a %s failure in plain words, with the raw reason as its tooltip',
      async (kind) => {
        const workstream = workstreamDto({
          state: 'FAILED',
          failureKind: kind,
          failureReason: REASON,
          steps: [stepDto({ status: 'done' }), stepDto({ role: 'review', status: 'failed' })],
          stepIndex: 1,
        });
        card({ workstream });
        const line = screen.getByText(failureLine(workstream, true));
        expect(line.textContent).toMatch(/Retry /);
        expect(screen.queryByText(REASON)).toBeNull();
        fireEvent.mouseEnter(line);
        expect(await screen.findByText(REASON)).toBeTruthy();
      },
    );

    it('parses a list with a kind this build does not know and shows the generic line', () => {
      // A newer daemon's kind, as it arrives over the wire.
      const wire: unknown = JSON.parse(
        JSON.stringify([
          {
            ...workstreamDto({ state: 'FAILED', failureReason: REASON }),
            failureKind: 'a_kind_from_a_newer_daemon',
          },
        ]),
      );
      const [workstream] = WorkstreamList.parse(wire);
      if (!workstream) throw new Error('the list lost its workstream');
      expect(workstream.failureKind).toBe('a_kind_from_a_newer_daemon');
      card({ workstream });
      expect(screen.getByText(/^The run failed\. Retry runs it again\.$/)).toBeTruthy();
    });

    it('speaks the plain line and the raw reason to a screen reader', () => {
      const workstream = workstreamDto({
        state: 'FAILED',
        failureKind: 'gate_failed',
        failureReason: 'The gate failed 4 times (last exit 2)',
      });
      const summary = cardSummary(taskDto({ workstreamId: workstream.id }), workstream, new Map());
      expect(summary).toContain(`${failureLine(workstream, true)} `);
      expect(summary).toContain('Reason: The gate failed 4 times (last exit 2).');
    });

    it('says only what happened, to the eye and to a screen reader, when the task is parked', () => {
      const workstream = workstreamDto({ state: 'FAILED', failureKind: 'gate_failed' });
      const task = taskDto({ workstreamId: workstream.id, boardColumnId: mintId('BoardColumn') });
      render(
        <MantineProvider theme={theme} defaultColorScheme="dark">
          <TaskCard task={task} workstream={workstream} peers={new Map()} />
        </MantineProvider>,
      );
      expect(screen.getByText(failureLine(workstream, false))).toBeTruthy();
      expect(screen.queryByText(/Retry/)).toBeNull();
      expect(cardSummary(task, workstream, new Map())).not.toContain('Retry');
    });
  });

  it('shows no line while it checks, but speaks the gate command', () => {
    card({ workstream: workstreamDto({ state: 'VERIFYING' }), gateCommand: 'make gate' });
    expect(screen.queryByText('Checking: make gate')).toBeNull();
  });
});
