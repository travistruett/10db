import { mintId } from '@10db/contracts';
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

  it('keeps a failed run for the Needs you block, with Retry when the daemon would accept it', () => {
    const failed = workstreamDto({ state: 'FAILED' });
    const task = taskDto({ id: failed.taskId, boardStatus: 'blocked', workstreamId: failed.id });
    const [row] = taskRows(input({ tasks: [task], workstreams: [failed] }));
    expect(row?.failed?.id).toBe(failed.id);
    expect(row?.retryable).toBe(true);
  });

  it.each([
    { name: 'closed', task: { status: 'cancelled' as const, boardStatus: 'blocked' as const } },
    { name: 'parked', task: { boardColumnId: mintId('BoardColumn') } },
    { name: 'replaced', task: { workstreamId: mintId('Workstream') } },
  ])('offers no Retry for a failed run of a task that is $name', ({ task: over }) => {
    const failed = workstreamDto({ state: 'FAILED' });
    const task = taskDto({
      id: failed.taskId,
      boardStatus: 'blocked',
      workstreamId: failed.id,
      ...over,
    });
    const rows = taskRows(input({ tasks: [task], workstreams: [failed] }));
    // A closed task has no row; the others keep the failure but not the Retry.
    expect(rows.every((r) => !r.retryable)).toBe(true);
  });

  it('offers no Retry for a failed run whose batch shipped without a pull request', () => {
    const failed = workstreamDto({ state: 'FAILED', failureKind: 'gate_failed' });
    const task = taskDto({ id: failed.taskId, boardStatus: 'blocked', workstreamId: failed.id });
    const shipped = batchDto({ state: 'SHIPPED', prUrl: null });
    const [row] = taskRows(
      input({
        tasks: [task],
        batches: [shipped],
        workstreams: [{ ...failed, batchId: shipped.id }],
      }),
    );
    expect(row?.retryable).toBe(false);
  });

  it('links a pull request, and shows a shared one once, with every row marked shared', () => {
    // The daemon marks a shipped task done; its open pull request puts it In review on the Board.
    const a = taskDto({ status: 'done', boardStatus: 'in_review' });
    const b = taskDto({ status: 'done', boardStatus: 'in_review' });
    const c = taskDto({ status: 'done', boardStatus: 'in_review' });
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
    expect(rows.map((r) => r.bucket)).toEqual(['in_review', 'in_review', 'in_review']);
  });

  it('counts a done task whose batch still ships as in progress, not merged', () => {
    const task = taskDto({ status: 'done', boardStatus: 'in_progress' });
    const shipping = batchDto({ state: 'SHIPPING' });
    const [row] = taskRows(
      input({
        tasks: [task],
        batches: [shipping],
        workstreams: [workstreamDto({ taskId: task.id, state: 'DONE', batchId: shipping.id })],
      }),
    );
    expect(row?.bucket).toBe('in_progress');
  });

  it('counts a merged task as merged', () => {
    const task = taskDto({ status: 'done', boardStatus: 'done' });
    const [row] = taskRows(
      input({ tasks: [task], workstreams: [workstreamDto({ taskId: task.id, state: 'DONE' })] }),
    );
    expect(row?.bucket).toBe('merged');
  });

  it('says Ready for a ready task whose last run was cancelled, and can tag it next', () => {
    const task = taskDto({ boardStatus: 'ready' });
    const cancelled = workstreamDto({ taskId: task.id, state: 'CANCELLED', contextPct: 40 });
    const [row] = taskRows(input({ tasks: [task], workstreams: [cancelled], nextTaskId: task.id }));
    expect(row?.bucket).toBe('ready');
    expect(row?.state).toBe('Ready · next');
    expect(row?.next).toBe(true);
    expect(row?.running).toBeNull();
    expect(row?.failed).toBeNull();
  });

  it('says Waits on for a backlog task whose last run was cancelled', () => {
    const dep = taskDto({ boardStatus: 'ready' });
    const task = taskDto({ boardStatus: 'backlog', dependsOn: [dep.id] });
    const cancelled = workstreamDto({ taskId: task.id, state: 'CANCELLED' });
    const rows = taskRows(input({ tasks: [dep, task], workstreams: [cancelled] }));
    expect(rows[1]?.bucket).toBe('not_started');
    expect(rows[1]?.state).toBe('Waits on 1');
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
