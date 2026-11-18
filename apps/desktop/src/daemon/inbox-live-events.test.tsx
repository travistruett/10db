import { mintId, type InboxItemDto } from '@10db/contracts';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../test/daemon';
import { inboxItemDto } from '../test/fixtures';
import { serveInboxRows } from '../test/inbox-page-fixtures';
import { useInboxRows, type InboxList } from './inbox-queries';

type Rows = ReturnType<typeof useInboxRows>;

/** Mounts `useInboxRows` and keeps its latest result where a test can read it. */
function probe(list: InboxList): { readonly latest: () => Rows } {
  let latest: Rows | null = null;
  function Probe() {
    latest = useInboxRows(list);
    return null;
  }
  renderWithDaemon(<Probe />);
  return {
    latest: () => {
      if (latest === null) throw new Error('not rendered');
      return latest;
    },
  };
}

function cards(count: number): InboxItemDto[] {
  const project = mintId('Project');
  return Array.from({ length: count }, (_, index) =>
    inboxItemDto({
      projectId: project,
      title: `Card ${String(index)}`,
      createdAt: new Date(Date.UTC(2026, 9, 13, 12, 0, index)).toISOString(),
    }),
  );
}

describe('useInboxRows', () => {
  it("loads page two by the last row's sort", async () => {
    server.use(...baseHandlers());
    const all = cards(52);
    const asked = serveInboxRows({ open: all });
    const rows = probe({ state: 'open' });
    await waitFor(() => {
      expect(rows.latest().rows).toHaveLength(50);
    });
    expect(rows.latest().hasMore).toBe(true);
    expect(asked[0]).toMatchObject({ state: 'open', pageSize: '50' });
    act(() => {
      rows.latest().loadMore();
    });
    await waitFor(() => {
      expect(rows.latest().rows).toHaveLength(52);
    });
    expect(rows.latest().hasMore).toBe(false);
    const second = asked.find((query) => query['after'] !== undefined);
    expect(JSON.parse(second?.['after'] ?? 'null')).toEqual(rows.latest().rows[49]?.sort);
    expect(rows.latest().rows.map((row) => row.items[0].id)).toEqual(all.map((card) => card.id));
  });
});
