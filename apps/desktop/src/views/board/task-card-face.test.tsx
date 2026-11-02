import type { BatchDto, RequiredChecksDto } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { batchDto, taskDto, workstreamDto } from '../../test/fixtures';
import { theme } from '../../theme';
import { cardSummary, TaskCard } from './task-card';

function card(props: Partial<Parameters<typeof TaskCard>[0]>) {
  render(
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <TaskCard task={taskDto()} workstream={undefined} peers={new Map()} {...props} />
    </MantineProvider>,
  );
}

const PR = 'https://github.com/acme/widgets/pull/9';
const required = (state: RequiredChecksDto['state']): RequiredChecksDto => ({
  state,
  failing: [],
  pending: [],
  cancelled: [],
});
const shippedWith = (checks: RequiredChecksDto['state'], overrides: Partial<BatchDto> = {}) =>
  batchDto({
    state: 'SHIPPED',
    prUrl: PR,
    prRequired: required(checks),
    pr: {
      state: 'open',
      checks: 'pending',
      failingChecks: [],
      checkedAt: '2026-10-31T12:00:00.000Z',
      unknownReason: null,
    },
    ...overrides,
  });

describe('TaskCard face: words', () => {
  it('shows the headline and the why in place of the title', () => {
    card({
      task: taskDto({
        title: 'Stamping a write never blocks or stalls the daemon',
        headline: "Odd files can't freeze 10db",
        why: 'A FIFO could hang every lane.',
      }),
    });
    expect(screen.getByText("Odd files can't freeze 10db")).toBeTruthy();
    expect(screen.getByText('A FIFO could hang every lane.')).toBeTruthy();
    expect(screen.queryByText(/Stamping a write/)).toBeNull();
  });

  it('shows the title when the headline is empty, and no why line when the why is empty', () => {
    card({ task: taskDto({ title: 'The precise promise', headline: '', why: '' }) });
    expect(screen.getByText('The precise promise')).toBeTruthy();
    expect(screen.queryByTestId('task-card-why')).toBeNull();
  });
});

describe('TaskCard face: status line', () => {
  it.each(['RUNNING', 'DONE', 'QUEUED'] as const)('shows no status line for a %s task', (state) => {
    card({ workstream: workstreamDto({ state }) });
    expect(screen.queryByTestId('state-dot')).toBeNull();
  });

  it.each([
    { state: 'WAITING_HUMAN', color: 'yellow' },
    { state: 'FAILED', color: 'red' },
    { state: 'PAUSED_LIMIT', color: 'orange' },
  ] as const)('shows a line for a $state task and keeps the $color border', ({ state, color }) => {
    card({ workstream: workstreamDto({ state }) });
    expect(screen.getByTestId('state-dot').getAttribute('data-color')).toBe(color);
    const paper = screen.getByTestId('task-card');
    expect(paper.getAttribute('data-state-color')).toBe(color);
    expect(paper.style.borderColor).toContain(`--mantine-color-${color}-filled`);
  });

  it('keeps the colored border of a running task without a line', () => {
    card({ workstream: workstreamDto({ state: 'RUNNING' }) });
    expect(screen.getByTestId('task-card').getAttribute('data-state-color')).toBe('blue');
  });

  it('shows a refused start as a red line and an unanswered one as a yellow line', () => {
    card({ startNote: { kind: 'refused', line: 'Not started: no gate', inbox: false } });
    expect(screen.getByText('Not started: no gate')).toBeTruthy();
  });

  it('shows no line for a start on its way', () => {
    card({ startNote: { kind: 'starting', line: 'Starting…', inbox: false } });
    expect(screen.queryByText('Starting…')).toBeNull();
  });
});

describe('TaskCard face: what left it', () => {
  const crowded = () => {
    card({
      task: taskDto({
        areas: ['api', 'ui'],
        acceptanceCriteria: ['one', 'two'],
        workspaceMode: 'worktree',
      }),
      workstream: workstreamDto({ state: 'DONE' }),
      batch: shippedWith('passing'),
      batches: [shippedWith('passing')],
    });
  };

  it('shows no areas, criteria count, landing line, placement badge or links', () => {
    crowded();
    expect(screen.queryByText('api')).toBeNull();
    expect(screen.queryByText(/criteri/)).toBeNull();
    expect(screen.queryByTestId('landing-line')).toBeNull();
    expect(screen.queryByText(/Merges into/)).toBeNull();
    expect(screen.queryByTestId('placement-badge')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('still speaks areas, criteria, placement and landing to a screen reader', () => {
    const summary = cardSummary(
      taskDto({ areas: ['api', 'ui'], acceptanceCriteria: ['one', 'two'] }),
      workstreamDto({ state: 'DONE' }),
      new Map(),
      undefined,
      null,
      'Merges into main when checks pass',
      null,
      undefined,
      [],
      'Separate copy',
    );
    expect(summary).toContain('Areas: api, ui.');
    expect(summary).toContain('2 criteria.');
    expect(summary).toContain('Runs in Separate copy.');
    expect(summary).toContain('Merges into main when checks pass.');
  });

  it('speaks the CI result of a shipped pull request', () => {
    const batch = shippedWith('passing');
    const summary = cardSummary(
      taskDto(),
      workstreamDto({ state: 'DONE' }),
      new Map(),
      batch,
      null,
      null,
      null,
      undefined,
      [batch],
    );
    expect(summary).toContain('CI passed');
  });

  it('speaks a shared branch', () => {
    const summary = cardSummary(
      taskDto(),
      undefined,
      new Map(),
      undefined,
      null,
      null,
      null,
      undefined,
      [],
      null,
      3,
    );
    expect(summary).toContain('Shares its branch with 2 other tasks.');
  });
});

describe('TaskCard face: indicators', () => {
  it('shows no indicator row on a card with no indicator', () => {
    card({ workstream: workstreamDto({ state: 'RUNNING' }) });
    expect(screen.queryByTestId('indicator-row')).toBeNull();
  });

  it('shows a shared-branch indicator when the batch has more than one task', () => {
    card({ batchTaskCount: 2 });
    expect(screen.getByTestId('indicator-row').textContent).toContain('Shared branch');
  });

  it('shows none for a batch of one task', () => {
    card({ batchTaskCount: 1 });
    expect(screen.queryByTestId('indicator-row')).toBeNull();
  });

  it.each([
    { checks: 'passing', label: 'CI passed' },
    { checks: 'failing', label: 'CI failed' },
  ] as const)('shows $label on a shipped pull request', ({ checks, label }) => {
    const batch = shippedWith(checks);
    card({ workstream: workstreamDto({ state: 'DONE' }), batch, batches: [batch] });
    expect(screen.getByTestId('indicator-row').textContent).toContain(label);
  });

  it('shows no CI indicator while the checks run', () => {
    const batch = shippedWith('pending');
    card({ workstream: workstreamDto({ state: 'DONE' }), batch, batches: [batch] });
    expect(screen.queryByTestId('indicator-row')).toBeNull();
  });

  it('shows a waits-on indicator with the dependency titles in its tooltip', async () => {
    const dep = taskDto({ title: 'Base work', status: 'open', boardStatus: 'ready' });
    card({
      task: taskDto({ dependsOn: [dep.id] }),
      peers: new Map([[dep.id, dep]]),
    });
    const row = screen.getByTestId('indicator-row');
    expect(row.textContent).toContain('Waits on');
    expect(screen.queryByText('Base work')).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId('indicator-waits-on'));
    expect(await screen.findByText('Base work')).toBeTruthy();
  });

  it('shows no waits-on indicator once the dependency is done', () => {
    const dep = taskDto({ title: 'Base work', status: 'done', boardStatus: 'done' });
    card({ task: taskDto({ dependsOn: [dep.id] }), peers: new Map([[dep.id, dep]]) });
    expect(screen.queryByTestId('indicator-row')).toBeNull();
  });

  it('shows a Cancelled indicator for a cancelled task', () => {
    card({ task: taskDto({ status: 'cancelled' }) });
    expect(screen.getByTestId('indicator-row').textContent).toContain('Cancelled');
  });
});
