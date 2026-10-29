import { mintId } from '@10db/contracts';
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

  it('says a finished task with no gate is ready for the builder to check', () => {
    const inboxId = mintId('InboxItem');
    const summary = cardSummary(
      taskDto(),
      workstreamDto({ state: 'WAITING_HUMAN', nextAction: { kind: 'builder_review', inboxId } }),
      new Map(),
    );
    expect(summary).toContain('Ready for you to check.');
  });
});
