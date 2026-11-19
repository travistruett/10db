import { TaskId, WorkstreamId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { workstreamDto } from '../../test/fixtures';
import { LiveGroup, liveGroups, type LiveTask } from './live-groups';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();
const task = (n: number): TaskId =>
  TaskId.parse(`tsk_01a1f55d-74d4-7632-9c3a-d5293f6efd${String(10 + n)}`);
const run = (n: number): WorkstreamId =>
  WorkstreamId.parse(`ws_01a1f55d-7507-7121-a9a1-8728aa19a5${String(10 + n)}`);

describe('liveGroups', () => {
  it('sorts each task by its latest run into the sections, leaving out old, closed, reviewed and pass-held runs', () => {
    const at = (h: number) => ({
      lastActivityAt: ago(h),
      updatedAt: ago(h),
      createdAt: ago(h + 1),
    });
    const tasks = new Map<TaskId, LiveTask>([
      // Started over after a failure: both runs are attempt 0, the newer made last.
      [task(1), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
      [task(3), { status: 'open', boardStatus: 'in_review', workstreamId: run(3) }],
      [task(4), { status: 'done', boardStatus: 'done', workstreamId: run(4) }],
      [task(6), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
      [task(7), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
      [task(8), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
      [task(10), { status: 'open', boardStatus: 'done', workstreamId: null }],
      [task(11), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
      [task(12), { status: 'open', boardStatus: 'in_progress', workstreamId: null }],
    ]);
    const groups = liveGroups(
      [
        workstreamDto({
          taskTitle: 'Started over',
          taskId: task(1),
          attempt: 0,
          state: 'FAILED',
          ...at(3),
          createdAt: ago(5),
        }),
        workstreamDto({
          taskTitle: 'Started over',
          taskId: task(1),
          attempt: 0,
          state: 'RUNNING',
          ...at(1),
          createdAt: ago(2),
        }),
        workstreamDto({
          id: run(2),
          taskTitle: 'Closed',
          taskId: task(2),
          state: 'FAILED',
          ...at(2),
        }),
        workstreamDto({
          id: run(3),
          taskTitle: 'PR open',
          taskId: task(3),
          state: 'DONE',
          ...at(2),
        }),
        workstreamDto({
          id: run(4),
          taskTitle: 'Landed',
          taskId: task(4),
          state: 'DONE',
          ...at(4),
        }),
        workstreamDto({ taskTitle: 'Broke', taskId: task(6), state: 'FAILED', ...at(3) }),
        workstreamDto({ taskTitle: 'Asks', taskId: task(7), state: 'WAITING_HUMAN', ...at(5) }),
        workstreamDto({
          taskTitle: 'Out with Sam',
          taskId: task(8),
          state: 'WAITING_HUMAN',
          waitingOn: { names: ['Sam'], since: ago(1) },
          ...at(1),
        }),
        workstreamDto({ taskTitle: 'A page', taskId: task(5), state: 'WAITING_HUMAN', ...at(1) }),
        workstreamDto({ taskTitle: 'Yesterday', taskId: task(10), state: 'DONE', ...at(30) }),
        workstreamDto({
          taskTitle: 'Old failure',
          taskId: task(11),
          state: 'FAILED',
          ...at(24 * 8),
        }),
        workstreamDto({ taskTitle: 'Dropped', taskId: task(12), state: 'CANCELLED', ...at(1) }),
      ],
      tasks,
      // Every task list was read; the closed task (2) is missing from them, as the daemon lists it.
      true,
      new Set([task(5)]),
      NOW,
    );
    expect(groups.map((g) => [g.group, g.rows.map((r) => r.taskTitle)])).toEqual([
      [LiveGroup.NeedsYou, ['Asks']],
      [LiveGroup.Failed, ['Broke']],
      [LiveGroup.Running, ['Started over']],
      [LiveGroup.InReview, ['PR open']],
      [LiveGroup.Waiting, ['Out with Sam']],
      [LiveGroup.Done, ['Landed']],
    ]);
  });
});
