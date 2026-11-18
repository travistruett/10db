import { mintId } from '@10db/contracts';
import { act, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { activityRowDto, serveActivity } from '../test/activity-fixtures';
import { baseHandlers, renderWithDaemon, server } from '../test/daemon';
import { useActivityRows, useTaskNotices } from './activity-queries';

type Rows = ReturnType<typeof useActivityRows>;

function probeRows(): { readonly latest: () => Rows } {
  const seen: { rows: Rows | null } = { rows: null };
  function Probe() {
    const current = useActivityRows({});
    useEffect(() => {
      seen.rows = current;
    });
    return null;
  }
  renderWithDaemon(<Probe />);
  return {
    latest: () => {
      if (seen.rows === null) throw new Error('not rendered');
      return seen.rows;
    },
  };
}

function probeNotices(taskId: ReturnType<typeof mintId<'Task'>> | null) {
  const seen: { notices: ReturnType<typeof useTaskNotices> | null } = { notices: null };
  function Probe() {
    const current = useTaskNotices(taskId);
    useEffect(() => {
      seen.notices = current;
    });
    return null;
  }
  renderWithDaemon(<Probe />);
  return () => seen.notices;
}

describe('useActivityRows', () => {
  it('reads 50 a page, then the next by the last row, and stops at a null cursor', async () => {
    server.use(...baseHandlers());
    const all = Array.from({ length: 52 }, () => activityRowDto());
    const asked = serveActivity(all);
    const probe = probeRows();
    await waitFor(() => {
      expect(probe.latest().rows).toHaveLength(50);
    });
    expect(asked[0]?.['pageSize']).toBe('50');
    expect(asked[0]?.['after']).toBeUndefined();
    expect(probe.latest().hasMore).toBe(true);
    act(() => {
      probe.latest().loadMore();
    });
    await waitFor(() => {
      expect(probe.latest().rows).toHaveLength(52);
    });
    const second = asked.find((query) => query['after'] !== undefined);
    expect(second?.['after']).toBe(String(probe.latest().rows[49]?.seq));
    expect(probe.latest().hasMore).toBe(false);
  });
});

describe('useTaskNotices', () => {
  it('maps a grouped row to a notice keyed by its seq, with its count on the line', async () => {
    server.use(...baseHandlers());
    const taskId = mintId('Task');
    const row = activityRowDto({ taskId, tone: 'warning', line: 'Task was resized', count: 3 });
    const asked = serveActivity([row, activityRowDto({ taskId: mintId('Task') })]);
    const notices = probeNotices(taskId);
    await waitFor(() => {
      expect(notices()).toHaveLength(1);
    });
    expect(notices()?.[0]).toEqual({
      key: `activity:${String(row.seq)}`,
      tone: 'warning',
      line: 'Task was resized ×3',
      body: row.body,
    });
    expect(asked[0]).toMatchObject({ task: taskId, pageSize: '20' });
  });

  it('sends no request for no task', async () => {
    server.use(...baseHandlers());
    const asked = serveActivity([activityRowDto()]);
    const notices = probeNotices(null);
    await waitFor(() => {
      expect(notices()).toEqual([]);
    });
    expect(asked).toHaveLength(0);
  });
});
