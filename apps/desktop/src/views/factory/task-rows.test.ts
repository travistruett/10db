import { describe, expect, it } from 'vitest';
import { batchDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { barCounts, taskRows, teamLine, type TaskRowsInput } from './task-rows';

function input(over: Partial<TaskRowsInput> = {}): TaskRowsInput {
  return { tasks: [], workstreams: [], batches: [], nextTaskId: null, gateCommand: null, ...over };
}

describe('taskRows', () => {
  it('names a task by its headline, and by its title when it has none', () => {
    const withHeadline = taskDto({ title: 'Replace the file', headline: 'Greet by name' });
    const plain = taskDto({ title: 'Plain title', headline: '' });
    const rows = taskRows(input({ tasks: [withHeadline, plain] }));
    expect(rows.map((r) => r.label)).toEqual(['Greet by name', 'Plain title']);
  });

  it('says Ready, tags the next ready task, and counts what a not-started task waits on', () => {
    const first = taskDto({ boardStatus: 'ready' });
    const second = taskDto({ boardStatus: 'ready' });
    const waits = taskDto({ boardStatus: 'backlog', dependsOn: [first.id, second.id] });
    const free = taskDto({ boardStatus: 'backlog' });
    const rows = taskRows(input({ tasks: [first, second, waits, free], nextTaskId: first.id }));
    expect(rows.map((r) => r.state)).toEqual([
      'Ready · next',
      'Ready',
      'Waits on 2',
      'Not started',
    ]);
    expect(rows.map((r) => r.next)).toEqual([true, false, false, false]);
  });

  it('leaves cancelled tasks out', () => {
    const gone = taskDto({ status: 'cancelled' });
    expect(taskRows(input({ tasks: [gone] }))).toEqual([]);
  });

  it('shows step, model and context only on a running row', () => {
    const task = taskDto({ boardStatus: 'in_progress' });
    const running = workstreamDto({
      taskId: task.id,
      state: 'RUNNING',
      model: 'sonnet',
      steps: [stepDto({ role: 'implement' }), stepDto({ role: 'review' })],
      stepIndex: 0,
      contextPct: 34,
    });
    const [row] = taskRows(input({ tasks: [task], workstreams: [running] }));
    expect(row?.running).toEqual({ step: 'Implement 1/2 · sonnet', contextPct: 34 });
    expect(row?.color).toBe('blue');
  });

  it('gives a queued, failed or finished run no step and no context', () => {
    const queued = taskDto({ boardStatus: 'in_progress' });
    const failed = taskDto({ boardStatus: 'blocked' });
    const done = taskDto({ boardStatus: 'done', status: 'done' });
    const rows = taskRows(
      input({
        tasks: [queued, failed, done],
        workstreams: [
          workstreamDto({ taskId: queued.id, state: 'QUEUED', steps: [stepDto()], contextPct: 3 }),
          workstreamDto({ taskId: failed.id, state: 'FAILED', contextPct: 80 }),
          workstreamDto({ taskId: done.id, state: 'DONE', contextPct: 90 }),
        ],
      }),
    );
    expect(rows.map((r) => r.running)).toEqual([null, null, null]);
    expect(rows.map((r) => r.state)).toEqual(['Queued', 'Failed', 'Done']);
    expect(rows.map((r) => r.color)).toEqual(['gray', 'red', 'green']);
  });

  it('uses the latest run of a task', () => {
    const task = taskDto({ boardStatus: 'in_progress' });
    const old = workstreamDto({
      taskId: task.id,
      state: 'FAILED',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const fresh = workstreamDto({
      taskId: task.id,
      state: 'QUEUED',
      createdAt: '2026-10-02T00:00:00.000Z',
    });
    const [row] = taskRows(input({ tasks: [task], workstreams: [old, fresh] }));
    expect(row?.state).toBe('Queued');
    expect(row?.failed).toBeNull();
  });

  it('keeps a failed run for the Needs you block', () => {
    const task = taskDto({ boardStatus: 'blocked' });
    const failed = workstreamDto({ taskId: task.id, state: 'FAILED' });
    const [row] = taskRows(input({ tasks: [task], workstreams: [failed] }));
    expect(row?.failed?.id).toBe(failed.id);
  });

  it('links a pull request, and shows a shared one once, with every row marked shared', () => {
    const a = taskDto({ boardStatus: 'in_review' });
    const b = taskDto({ boardStatus: 'in_review' });
    const c = taskDto({ boardStatus: 'in_review' });
    const shared = batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/a/b/pull/1' });
    const alone = batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/a/b/pull/2' });
    const rows = taskRows(
      input({
        tasks: [a, b, c],
        batches: [shared, alone],
        workstreams: [
          workstreamDto({ taskId: a.id, state: 'DONE', batchId: shared.id }),
          workstreamDto({ taskId: b.id, state: 'DONE', batchId: shared.id }),
          workstreamDto({ taskId: c.id, state: 'DONE', batchId: alone.id }),
        ],
      }),
    );
    expect(rows.map((r) => r.prUrl)).toEqual([
      'https://github.com/a/b/pull/1',
      null,
      'https://github.com/a/b/pull/2',
    ]);
    expect(rows.map((r) => r.shared)).toEqual([true, true, false]);
    expect(rows[0]?.state.startsWith('In review')).toBe(true);
  });
});

describe('barCounts', () => {
  it('takes merged and in review from the progress and the rest from the rows', () => {
    const ready = taskDto({ boardStatus: 'ready' });
    const idle = taskDto({ boardStatus: 'backlog' });
    const busy = taskDto({ boardStatus: 'in_progress' });
    const rows = taskRows(
      input({
        tasks: [ready, idle, busy],
        workstreams: [workstreamDto({ taskId: busy.id, state: 'RUNNING' })],
      }),
    );
    const progress = { merged: 1, inReview: 2, total: 6, cancelled: [] };
    expect(barCounts(progress, rows)).toEqual({
      merged: 1,
      inReview: 2,
      inProgress: 1,
      ready: 1,
      notStarted: 1,
      total: 6,
    });
  });
});

describe('teamLine', () => {
  it('names each persona once, with the distinct model and effort of its members', () => {
    expect(
      teamLine([
        { persona: 'Implementer', model: 'opus', effort: 'high' },
        { persona: 'Reviewer', model: 'opus', effort: 'medium' },
        { persona: 'Implementer', model: 'sonnet', effort: 'medium' },
        { persona: 'Implementer', model: 'opus', effort: 'high' },
      ]),
    ).toBe('Implementer opus@high, sonnet@medium · Reviewer opus@medium');
  });
});
