import { EventsHead, mintId, type InboxItemDto, type InboxListState } from '@10db/contracts';
import { useEffect, type ReactNode } from 'react';
import { act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  baseHandlers,
  daemonUrl,
  eventStream,
  renderWithDaemon,
  server,
  TEST_CONNECTION,
} from '../test/daemon';
import { createDaemonClient } from './client';
import { daemonEvent, inboxItemDto } from '../test/fixtures';
import { serveInboxRows } from '../test/inbox-page-fixtures';
import { useEventStream } from './events';
import { dropCard } from './inbox-live';
import { RenderModeContext } from '../screens/render-context';
import { useInboxCount, useInboxRows, type InboxList } from './inbox-queries';

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
  showRows = true,
  /** More lists and counts on screen beside the open list, and how many reads the whole screen makes at first. */
  beside: { readonly nodes: ReactNode; readonly reads: number } = { nodes: null, reads: 2 },
) {
  const seen: { rows: Rows | null } = { rows: null };
  let released: () => void = () => undefined;
  const firstPage = new Promise<void>((resolve) => {
    released = resolve;
  });
  const sockets: { send(data: string): void; close(): void }[] = [];
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
    showRows ? (
      <>
        <Stream />
        <Probe />
        {beside.nodes}
      </>
    ) : (
      <Stream />
    ),
  );
  if (!showRows) released();
  await waitFor(() => {
    expect(sockets).toHaveLength(1);
    if (!showRows) return;
    expect(asked.length).toBeGreaterThanOrEqual(beside.reads);
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
    sockets,
    sendSlack: () => {
      seq += 1;
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({
            seq,
            type: 'slack.connection.changed',
            entityType: 'slack',
            entityId: 'slack',
          }),
        ),
      );
    },
    loadMore: () => {
      act(() => {
        seen.rows?.loadMore();
      });
    },
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

  it('moves a grouped row that an answer shrank before the event came, by looking up the next card (row 8)', async () => {
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
    all.splice(0, 1);
    // The answer's own success drops the card before the event for it is read.
    dropCard(view.queryClient, createDaemonClient(TEST_CONNECTION), f1.id);
    view.send('inbox.changed', f1.id);
    await waitFor(() => {
      expect(view.keys()).toEqual([middle.id, flags]);
    });
    // The drop looks the card left in the row up; the event for the dropped card is then a no-op lookup.
    expect(lookups(view.asked, view.baseline)).toEqual([f2.id, f1.id]);
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

/** Runs `then` each time the daemon has answered a `card=` read, which is when the lookup's answer is on its way. */
function onLookupAnswered(then: () => void): () => void {
  const listener = ({ request }: { readonly request: Request }) => {
    if (new URL(request.url).searchParams.has('card')) then();
  };
  server.events.on('response:mocked', listener);
  return () => {
    server.events.removeListener('response:mocked', listener);
  };
}

describe('a fetch in flight', () => {
  /** Holds the first read that asks for the page after `after`, until `release()`. */
  function holdSecondPage() {
    let release: () => void = () => undefined;
    let held = false;
    return {
      hold: (query: Record<string, string>) => {
        if (query['after'] === undefined || held) return undefined;
        held = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      release: () => {
        release();
      },
    };
  }

  it('merges an event after page two lands, and shows the card once (row 12)', async () => {
    const all = cards(52);
    const gate = holdSecondPage();
    const view = await mount({ open: all }, gate.hold);
    view.loadMore();
    await waitFor(() => {
      expect(view.asked.some((query) => query['after'] !== undefined)).toBe(true);
    });
    // Page two was answered without this card. Page two lands only after the lookup has been answered.
    const fresh = inboxItemDto({
      projectId: all[0]?.projectId ?? mintId('Project'),
      createdAt: T(-5),
    });
    all.unshift(fresh);
    const off = onLookupAnswered(gate.release);
    view.send('inbox.opened', fresh.id);
    await waitFor(() => {
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
    off();
  });

  it('merges an event into a list whose first page was answered before the event (row 12, pending)', async () => {
    const all = cards(3);
    let release: () => void = () => undefined;
    let held = false;
    const view = await mount(
      { open: all },
      () => {
        if (held) return undefined;
        held = true;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      { state: 'open' },
      false,
    );
    view.rerender(
      <>
        <view.Stream />
        <view.Probe />
      </>,
    );
    await waitFor(() => {
      expect(view.asked).toHaveLength(1);
    });
    const fresh = inboxItemDto({
      projectId: all[0]?.projectId ?? mintId('Project'),
      createdAt: T(-5),
    });
    all.unshift(fresh);
    const off = onLookupAnswered(release);
    view.send('inbox.opened', fresh.id);
    await waitFor(() => {
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
    off();
  });

  it('drops a card after the page that holds it lands (row 27)', async () => {
    const all = cards(52);
    const gate = holdSecondPage();
    const view = await mount({ open: all }, gate.hold);
    view.loadMore();
    await waitFor(() => {
      expect(view.asked.some((query) => query['after'] !== undefined)).toBe(true);
    });
    const answered = all[51];
    dropCard(
      view.queryClient,
      createDaemonClient(TEST_CONNECTION),
      answered?.id ?? mintId('InboxItem'),
    );
    gate.release();
    await waitFor(() => {
      expect(view.ids()).toHaveLength(51);
    });
    expect(view.ids()).not.toContain(answered?.id);
  });
});

describe('a failed lookup', () => {
  it('reads the whole list again from its first page (row 20)', async () => {
    const all = cards(3);
    const view = await mount({ open: all });
    server.use(
      http.get(daemonUrl('/inbox/page'), ({ request }) =>
        new URL(request.url).searchParams.has('card')
          ? new HttpResponse(null, { status: 500 })
          : undefined,
      ),
    );
    const [gone] = all.splice(1, 1);
    view.send('inbox.changed', gone?.id ?? '');
    await waitFor(() => {
      expect(view.ids()).toEqual(all.map((card) => card.id));
    });
    const reads = view.asked.slice(view.baseline);
    expect(
      reads.every((query) => query['card'] === undefined && query['after'] === undefined),
    ).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
  });
});

function WaitingRows() {
  useInboxRows({ state: 'waiting' });
  return null;
}

function OpenCount() {
  useInboxCount('open');
  return null;
}

describe('Slack and the socket', () => {
  it('reads Open and Waiting rows and the counts again when Slack changes (row 10)', async () => {
    const view = await mount({ open: cards(2), waiting: [] }, undefined, { state: 'open' }, true, {
      nodes: (
        <>
          <WaitingRows />
          <OpenCount />
        </>
      ),
      reads: 6,
    });
    view.sendSlack();
    await waitFor(() => {
      const reads = view.asked.slice(view.baseline);
      expect(reads.some((q) => q['state'] === 'open' && q['pageSize'] === '50')).toBe(true);
      expect(reads.some((q) => q['state'] === 'waiting' && q['pageSize'] === '50')).toBe(true);
      expect(reads.some((q) => q['state'] === 'open' && q['pageSize'] === '1')).toBe(true);
    });
  });

  it('reads every loaded page again when the socket reopens, keeping the old rows meanwhile (row 19)', async () => {
    const all = cards(52);
    let holding = false;
    let release: () => void = () => undefined;
    const view = await mount({ open: all }, () => {
      if (!holding) return undefined;
      holding = false;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    view.loadMore();
    await waitFor(() => {
      expect(view.ids()).toHaveLength(52);
    });
    const before = view.asked.length;
    holding = true;
    view.sockets[0]?.close();
    await waitFor(() => {
      expect(view.asked.length).toBeGreaterThan(before);
    });
    expect(view.ids()).toHaveLength(52);
    release();
    await waitFor(() => {
      const reads = view.asked.slice(before);
      expect(reads.some((q) => q['after'] === undefined)).toBe(true);
      expect(reads.some((q) => q['after'] !== undefined)).toBe(true);
    });
  });

  it("asks for a screen frame's project in every row and count read (row 25)", async () => {
    const project = mintId('Project');
    server.use(...baseHandlers());
    const asked = serveInboxRows({ open: [] });
    renderWithDaemon(
      <RenderModeContext
        value={{
          token: 't',
          daemon: 'http://127.0.0.1:4999',
          projectId: project,
          screen: 'inbox',
          path: '/inbox',
        }}
      >
        <OpenCount />
        <WaitingRows />
      </RenderModeContext>,
    );
    await waitFor(() => {
      expect(asked.length).toBeGreaterThanOrEqual(2);
    });
    expect(asked.every((query) => query['project'] === project)).toBe(true);
  });
});
