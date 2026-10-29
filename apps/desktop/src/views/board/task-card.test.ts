import { describe, expect, it } from 'vitest';
import { taskDto, workstreamDto } from '../../test/fixtures';
import { cardSummary } from './task-card';

describe('cardSummary', () => {
  it.each([
    { name: 'a running workstream', state: 'RUNNING', said: 'Workstream Running.' },
    {
      name: 'a workstream waiting for a human',
      state: 'WAITING_HUMAN',
      said: 'Workstream Waiting on you.',
    },
  ] as const)('speaks $name with the label the badge shows', ({ state, said }) => {
    const summary = cardSummary(taskDto(), workstreamDto({ state }), new Map());
    expect(summary).toContain(said);
    expect(summary).not.toContain(state);
  });
});
