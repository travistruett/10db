import { mintId, TaskStatus, WorkspaceMode, WorkstreamState } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { taskDto } from '../../test/fixtures';
import { placementLabel, placementOpen } from './placement';

describe('placementOpen', () => {
  it.each<{
    name: string;
    status: TaskStatus;
    parked?: true;
    latest: WorkstreamState | undefined;
    expected: boolean;
  }>([
    {
      name: 'a task that never started',
      status: TaskStatus.Open,
      latest: undefined,
      expected: true,
    },
    {
      name: 'a parked task',
      status: TaskStatus.Open,
      parked: true,
      latest: undefined,
      expected: true,
    },
    {
      name: 'a failed run',
      status: TaskStatus.Open,
      latest: WorkstreamState.Failed,
      expected: true,
    },
    {
      name: 'a cancelled run',
      status: TaskStatus.Open,
      latest: WorkstreamState.Cancelled,
      expected: true,
    },
    {
      name: 'the finished run of a reopened task',
      status: TaskStatus.Open,
      latest: WorkstreamState.Done,
      expected: true,
    },
    {
      name: 'a queued run',
      status: TaskStatus.Open,
      latest: WorkstreamState.Queued,
      expected: false,
    },
    {
      name: 'a running run',
      status: TaskStatus.Open,
      latest: WorkstreamState.Running,
      expected: false,
    },
    { name: 'a held run', status: TaskStatus.Open, latest: WorkstreamState.Held, expected: false },
    {
      name: 'a done task',
      status: TaskStatus.Done,
      latest: WorkstreamState.Done,
      expected: false,
    },
    {
      name: 'a cancelled task',
      status: TaskStatus.Cancelled,
      latest: undefined,
      expected: false,
    },
  ])('$name: $expected', ({ status, parked, latest, expected }) => {
    const task = taskDto({
      status,
      boardColumnId: parked ? mintId('BoardColumn') : null,
    });
    expect(placementOpen(task, latest)).toBe(expected);
  });
});

describe('placementLabel', () => {
  it.each([
    { mode: WorkspaceMode.Shared, label: 'Your folder' },
    { mode: WorkspaceMode.Worktree, label: 'Separate copy' },
  ])('$mode is $label', ({ mode, label }) => {
    expect(placementLabel(mode)).toBe(label);
  });
});
