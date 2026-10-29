import { describe, expect, it } from 'vitest';
import { batchDto, taskDto, workstreamDto } from '../../test/fixtures';
import { cardSummary } from './task-card';

describe('cardSummary', () => {
  it.each([
    { name: 'a running workstream', state: 'RUNNING', said: 'Building.' },
    {
      name: 'a workstream waiting for a human',
      state: 'WAITING_HUMAN',
      said: 'Waiting on you: answer in Inbox.',
    },
  ] as const)('speaks $name with the line the card shows', ({ state, said }) => {
    const summary = cardSummary(taskDto(), workstreamDto({ state }), new Map());
    expect(summary).toContain(said);
    expect(summary).not.toContain(state);
  });

  it('names the gate command while the task is checked', () => {
    const summary = cardSummary(
      taskDto(),
      workstreamDto({ state: 'VERIFYING' }),
      new Map(),
      undefined,
      'make gate',
    );
    expect(summary).toContain('Checking: make gate.');
  });

  it('says finished work whose ship failed is not shipped', () => {
    const summary = cardSummary(
      taskDto(),
      workstreamDto({ state: 'DONE' }),
      new Map(),
      batchDto({ state: 'FAILED', failure: 'gate_failed' }),
    );
    expect(summary).toContain('Not shipped: the gate failed.');
  });
});
