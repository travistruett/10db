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

  it('says where the work will land, when the project delivers by pull request', () => {
    const summary = cardSummary(
      taskDto(),
      undefined,
      new Map(),
      undefined,
      null,
      'Merges into feature/x when checks pass',
    );
    expect(summary).toContain('Merges into feature/x when checks pass.');
    expect(cardSummary(taskDto(), undefined, new Map())).not.toContain('Merges');
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

  it('waits on a run shipped anyway until its pull request merges', () => {
    const dep = taskDto({ title: 'Dep', status: 'open', boardStatus: 'in_review' });
    const task = taskDto({ dependsOn: [dep.id] });
    expect(cardSummary(task, undefined, new Map([[dep.id, dep]]))).toContain('Waits on Dep.');
    const merged = { ...dep, boardStatus: 'done' as const };
    expect(cardSummary(task, undefined, new Map([[dep.id, merged]]))).not.toContain('Waits on');
  });

  // The daemon starts a task once its dependencies are done; it holds the batch at cut time until
  // their pull requests merge, so the card has nothing to wait on before then.
  it('does not wait on a finished dependency whose pull request is still open', () => {
    const dep = taskDto({ title: 'Dep', status: 'done', boardStatus: 'in_review' });
    const task = taskDto({ dependsOn: [dep.id] });
    expect(cardSummary(task, undefined, new Map([[dep.id, dep]]))).not.toContain('Waits on');
  });
});
