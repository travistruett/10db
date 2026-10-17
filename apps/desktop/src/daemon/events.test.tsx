import { EventsHead, type DaemonEvent } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderWithDaemon, server } from '../test/daemon';
import { daemonEvent } from '../test/fixtures';
import { eventStreamUrl, useEventStream } from './events';
import { useProjects } from './queries';

function Stream({ onEvent }: { readonly onEvent?: (event: DaemonEvent) => void }) {
  useEventStream(onEvent);
  return null;
}

function ProjectCount() {
  const projects = useProjects();
  return <p data-testid="count">{projects.data?.length ?? '-'}</p>;
}

/**
 * Counts `/projects` fetches and holds `/events/head` until the first one is served. Without the hold,
 * whether the list fetch or the stream's open-time refetch comes first depends on timing.
 */
function listBeforeHead(): { readonly handlers: HttpHandler[]; readonly fetches: () => number } {
  let fetches = 0;
  let release: () => void = () => undefined;
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    fetches: () => fetches,
    handlers: [
      http.get(daemonUrl('/projects'), () => {
        fetches += 1;
        release();
        return HttpResponse.json([]);
      }),
      http.get(daemonUrl('/events/head'), async () => {
        await listed;
        return HttpResponse.json(EventsHead.parse({ seq: 0 }));
      }),
    ],
  };
}

describe('useEventStream', () => {
  it('starts at the head instead of replaying history', async () => {
    const urls: string[] = [];
    server.use(
      ...baseHandlers({ headSeq: 41 }),
      eventStream.addEventListener('connection', ({ client }) => {
        urls.push(client.url.toString());
      }),
    );
    renderWithDaemon(<Stream />);
    await waitFor(() => {
      expect(urls).toHaveLength(1);
    });
    const url = new URL(urls[0] ?? 'ws://missing');
    expect(url.searchParams.get('after')).toBe('41');
    expect(url.searchParams.get('token')).toBe('test-token');
  });

  it('refetches once when the stream first opens, so nothing between the list fetch and the head is missed', async () => {
    const list = listBeforeHead();
    server.use(...list.handlers, ...baseHandlers());
    renderWithDaemon(
      <>
        <Stream />
        <ProjectCount />
      </>,
    );
    expect(await screen.findByText('0')).toBeTruthy();
    await waitFor(() => {
      expect(list.fetches()).toBe(2);
    });
  });

  it('refetches the queries an event touches', async () => {
    const list = listBeforeHead();
    // An array, not a `let`: TypeScript doesn't see assignments made inside the callback.
    const sockets: { send(data: string): void }[] = [];
    server.use(
      ...list.handlers,
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    renderWithDaemon(
      <>
        <Stream />
        <ProjectCount />
      </>,
    );
    expect(await screen.findByText('0')).toBeTruthy();
    // The list fetch, then the first-open refetch; count from there.
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
      expect(list.fetches()).toBe(2);
    });
    sockets[0]?.send(
      JSON.stringify(daemonEvent({ seq: 1, type: 'project.created', entityType: 'project' })),
    );
    await waitFor(() => {
      expect(list.fetches()).toBe(3);
    });
  });

  it('ignores frames that are not events', async () => {
    const seen: number[] = [];
    server.use(
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        client.send('not json');
        client.send(JSON.stringify({ seq: 'x' }));
        client.send(JSON.stringify(daemonEvent({ seq: 5 })));
      }),
    );
    renderWithDaemon(
      <Stream
        onEvent={(event) => {
          seen.push(event.seq);
        }}
      />,
    );
    await waitFor(() => {
      expect(seen).toEqual([5]);
    });
  });

  it('reconnects after a drop and resumes after the last event without duplicates', async () => {
    const urls: string[] = [];
    const seen: number[] = [];
    server.use(
      ...baseHandlers({ headSeq: 41 }),
      eventStream.addEventListener('connection', ({ client }) => {
        urls.push(client.url.toString());
        // Every connection replays 42, so the second one tests that the client drops the duplicate.
        client.send(JSON.stringify(daemonEvent({ seq: 42 })));
        if (urls.length > 1) client.send(JSON.stringify(daemonEvent({ seq: 43 })));
      }),
    );
    renderWithDaemon(
      <Stream
        onEvent={(event) => {
          seen.push(event.seq);
        }}
      />,
    );
    // MSW 3 delivers nothing when close() runs synchronously in the connection listener, so the
    // test drops the socket once the first event has been seen.
    await waitFor(() => {
      expect(seen).toEqual([42]);
    });
    for (const client of eventStream.clients) client.close();
    await waitFor(
      () => {
        expect(seen).toEqual([42, 43]);
      },
      { timeout: 3_000 },
    );
    expect(new URL(urls[1] ?? 'ws://missing').searchParams.get('after')).toBe('42');
  });

  it('builds ws and wss stream URLs', () => {
    expect(eventStreamUrl({ url: 'http://127.0.0.1:4317', token: 't k' }, 7)).toBe(
      'ws://127.0.0.1:4317/events/stream?after=7&token=t+k',
    );
    expect(eventStreamUrl({ url: 'https://example.test', token: 't' }, 0)).toBe(
      'wss://example.test/events/stream?after=0&token=t',
    );
  });
});
