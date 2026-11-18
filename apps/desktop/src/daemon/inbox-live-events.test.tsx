import { EventsHead, mintId, type InboxItemDto, type InboxListState } from '@10db/contracts';
import { useEffect } from 'react';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderWithDaemon, server } from '../test/daemon';
import { daemonEvent, inboxItemDto } from '../test/fixtures';
import { serveInboxRows } from '../test/inbox-page-fixtures';
import { useEventStream } from './events';
import { useInboxRows, type InboxList } from './inbox-queries';

type Rows = ReturnType<typeof useInboxRows>;

/** Mounts `useInboxRows` and keeps its latest result where a test can read it. */
function probe(list: InboxList): { readonly latest: () => Rows } {
  const seen: { rows: Rows | null } = { rows: null };
  function Probe() {
    const current = useInboxRows(list);
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

const T = (n: number) => new Date(Date.UTC(2026, 9, 13, 12, 0, n)).toISOString();

function Stream() {
  useEventStream();
  return null;
}

/**
 * One open list on screen with the event stream running. The head read waits until the first page is on screen, so the
 * stream's open-time refetch is the second read, and `baseline` is every read made before a test's events.
 */
async function mount(
  byState: Partial<Record<InboxListState, InboxItemDto[]>>,
  hold?: (query: Record<string, string>) => Promise<void> | undefined,
  list: InboxList = { state: 'open' },
) {
  const seen: { rows: Rows | null } = { rows: null };
  let released: () => void = () => undefined;
  const firstPage = new Promise<void>((resolve) => {
    released = resolve;
  });
  const sockets: { send(data: string): void }[] = [];
  server.use(
    http.get(daemonUrl('/events/head'), async () => {
      await firstPage;
      return HttpResponse.json(EventsHead.parse({ seq: 0 }));
    }),
    eventStream.addEventListener('connection', ({ client }) => {
      sockets.push(client);
    }),
    ...baseHandlers(),
  );
  const asked = serveInboxRows(byState, hold);
  function Probe() {
    const current = useInboxRows(list);
    useEffect(() => {
      seen.rows = current;
    });
    const loaded = current.rows.length > 0;
    useEffect(() => {
      if (loaded) released();
    }, [loaded]);
    return null;
  }
  const { queryClient, rerender } = renderWithDaemon(
    <>
      <Stream />
      <Probe />
    </>,
  );
  await waitFor(() => {
    expect(sockets).toHaveLength(1);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(queryClient.isFetching()).toBe(0);
  });
  let seq = 0;
  return {
    asked,
    baseline: asked.length,
    queryClient,
    rerender,
    Probe,
    Stream,
    keys: () => (seen.rows?.rows ?? []).map((row) => row.key),
    ids: () => (seen.rows?.rows ?? []).flatMap((row) => row.items.map((item) => item.id)),
    send: (type: 'inbox.opened' | 'inbox.changed', cardId: string) => {
      seq += 1;
      sockets[0]?.send(
        JSON.stringify(daemonEvent({ seq, type, entityType: 'inbox', entityId: cardId })),
      );
    },
    sendSend: (cardId: string) => {
      seq += 1;
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({
            seq,
            type: 'stakeholder_send.changed',
            entityType: 'stakeholder_send',
            entityId: mintId('StakeholderSend'),
            data: { inboxItemId: cardId },
          }),
        ),
      );
    },
  };
}

/** The `card=` reads made since `from`, in order. */
const lookups = (asked: Record<string, string>[], from: number) =>
  asked.slice(from).map((query) => query['card']);

describe('applyInboxEvent', () => {
  it('shows a new card sorting first as row 0 with a lookup and no whole refetch', async () => {
    const all = cards(3);
    const view = await mount({ open: all });
    const fresh = inboxItemDto({
      projectId: all[0]?.projectId ?? mintId('Project'),
      createdAt: T(-5),
    });
    all.unshift(fresh);
    view.send('inbox.opened', fresh.id);
    await waitFor(() => {
      expect(view.keys()[0]).toBe(fresh.id);
    });
    expect(view.keys()).toHaveLength(4);
    expect(lookups(view.asked, view.baseline)).toEqual([fresh.id]);
  });

  it('takes a resolved card out', async () => {
    const all = cards(3);
    const view = await mount({ open: all });
    const [gone] = all.splice(1, 1);
    view.send('inbox.changed', gone?.id ?? '');
    await waitFor(() => {
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
  });

  it('looks a stakeholder send up by the card it names', async () => {
    const all = cards(3);
    const view = await mount({ open: all });
    const [sent] = all.splice(0, 1);
    view.sendSend(sent?.id ?? '');
    await waitFor(() => {
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
    expect(lookups(view.asked, view.baseline)).toEqual([sent?.id]);
  });

  it('runs two events in one tick as two lookups, one at a time, in order (row 13)', async () => {
    const all = cards(4);
    let release: () => void = () => undefined;
    let holdFirst = false;
    const view = await mount({ open: all }, (query) => {
      if (!holdFirst || query['card'] === undefined) return undefined;
      holdFirst = false;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const [a, b] = [all[0], all[1]];
    all.splice(0, 2);
    holdFirst = true;
    view.send('inbox.changed', a?.id ?? '');
    view.send('inbox.changed', b?.id ?? '');
    await waitFor(() => {
      expect(lookups(view.asked, view.baseline)).toEqual([a?.id]);
    });
    // The second waits for the first: it is not asked while the first is in flight.
    expect(lookups(view.asked, view.baseline)).toHaveLength(1);
    release();
    await waitFor(() => {
      expect(lookups(view.asked, view.baseline)).toEqual([a?.id, b?.id]);
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
  });

  it('moves a grouped row when its first card leaves, by looking up the next card (row 8)', async () => {
    const project = mintId('Project');
    const flag = (n: number) =>
      inboxItemDto({
        projectId: project,
        kind: 'flag',
        options: [],
        title: 'Flag',
        body: 'same',
        createdAt: T(n),
      });
    const [f1, f2] = [flag(1), flag(5)];
    const middle = inboxItemDto({ projectId: project, createdAt: T(3) });
    const all = [f1, middle, f2];
    const view = await mount({ open: all });
    const flags = view.keys()[0];
    expect(view.keys()).toEqual([flags, middle.id]);
    all.splice(0, 1);
    view.send('inbox.changed', f1.id);
    await waitFor(() => {
      expect(view.keys()).toEqual([middle.id, flags]);
    });
    expect(lookups(view.asked, view.baseline)).toEqual([f1.id, f2.id]);
  });

  it('makes no lookup for a list that is not on screen, and reads it fresh when shown again (rows 19, 23)', async () => {
    const all = cards(3);
    const view = await mount({ open: all });
    view.rerender(<view.Stream />);
    const fresh = inboxItemDto({
      projectId: all[0]?.projectId ?? mintId('Project'),
      createdAt: T(-5),
    });
    all.unshift(fresh);
    view.send('inbox.opened', fresh.id);
    // The event reached the stream; nothing was looked up for the hidden list.
    await waitFor(() => {
      expect(
        view.queryClient
          .getQueryCache()
          .findAll({ queryKey: ['inbox-rows'] })[0]
          ?.isStale(),
      ).toBe(true);
    });
    expect(lookups(view.asked, view.baseline).filter((card) => card !== undefined)).toEqual([]);
    view.rerender(
      <>
        <view.Stream />
        <view.Probe />
      </>,
    );
    await waitFor(() => {
      expect(view.keys()[0]).toBe(fresh.id);
    });
    const reads = view.asked.slice(view.baseline);
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every((query) => query['card'] === undefined && query['after'] === undefined),
    ).toBe(true);
  });
});
