import { TaskId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { workstreamDto } from '../../test/fixtures';
import { LiveGroup, liveGroups } from './live-groups';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (hours: number): string => new Date(NOW - hours * 3_600_000).toISOString();

describe('liveGroups', () => {
  it('sorts each task by its latest run into the sections, newest first, dropping old and cancelled runs', () => {
    const retried = TaskId.parse('tsk_01a1f55d-74d4-7632-9c3a-d5293f6efd14');
    const groups = liveGroups(
      [
        workstreamDto({
          taskTitle: 'Retried',
          taskId: retried,
          attempt: 0,
          state: 'FAILED',
          lastActivityAt: ago(2),
        }),
        workstreamDto({
          taskTitle: 'Retried',
          taskId: retried,
          attempt: 1,
          state: 'RUNNING',
          lastActivityAt: ago(1),
        }),
        workstreamDto({ taskTitle: 'Broke', state: 'FAILED', lastActivityAt: ago(3) }),
        workstreamDto({ taskTitle: 'Asks', state: 'WAITING_HUMAN', lastActivityAt: ago(5) }),
        workstreamDto({ taskTitle: 'Newer run', state: 'VERIFYING', lastActivityAt: ago(0.5) }),
        workstreamDto({ taskTitle: 'Next', state: 'QUEUED', lastActivityAt: null }),
        workstreamDto({ taskTitle: 'Landed', state: 'DONE', lastActivityAt: ago(4) }),
        workstreamDto({ taskTitle: 'Yesterday', state: 'DONE', lastActivityAt: ago(30) }),
        workstreamDto({ taskTitle: 'Old failure', state: 'FAILED', lastActivityAt: ago(24 * 8) }),
        workstreamDto({ taskTitle: 'Dropped', state: 'CANCELLED', lastActivityAt: ago(1) }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.group, g.rows.map((r) => r.taskTitle)])).toEqual([
      [LiveGroup.NeedsYou, ['Asks']],
      [LiveGroup.Failed, ['Broke']],
      [LiveGroup.Running, ['Newer run', 'Retried']],
      [LiveGroup.Waiting, ['Next']],
      [LiveGroup.Done, ['Landed']],
    ]);
  });
});
