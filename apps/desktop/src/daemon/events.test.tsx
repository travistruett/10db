import {
  EventsHead,
  mintId,
  type AccountId,
  type DaemonEvent,
  type ProjectId,
} from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderWithDaemon, server } from '../test/daemon';
import { accountUsageDto, DEFAULT_ACCOUNT } from '../test/account-fixtures';
import { daemonEvent } from '../test/fixtures';
import { useAccountUsage } from './account-queries';
import { eventStreamUrl, useEventStream } from './events';
import { useBatches, useProjects } from './queries';

function Stream({ onEvent }: { readonly onEvent?: (event: DaemonEvent) => void }) {
  useEventStream(onEvent);
  return null;
}

function ProjectCount() {
  const projects = useProjects();
  return <p data-testid="count">{projects.data?.length ?? '-'}</p>;
}

/** Mounts the project's batch list, so a batch event has a query to refetch. */
function BatchesOf({ projectId }: { readonly projectId: ProjectId }) {
  useBatches(projectId);
  return null;
}

/**
 * Counts fetches of `path` and holds `/events/head` until the first one is served. Without the hold,
 * whether the list fetch or the stream's open-time refetch comes first depends on timing.
 */
function listBeforeHead(
  path = '/projects',
  body: JsonBodyType = [],
): {
  readonly handlers: HttpHandler[];
  readonly fetches: () => number;
} {
  let fetches = 0;
  let release: () => void = () => undefined;
  const listed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    fetches: () => fetches,
    handlers: [
      http.get(daemonUrl(path), () => {
        fetches += 1;
        release();
        return HttpResponse.json(body);
      }),
      http.get(daemonUrl('/events/head'), async () => {
        await listed;
        return HttpResponse.json(EventsHead.parse({ seq: 0 }));
      }),
    ],
  };
}

/** Mounts an account's usage, so a session or account event has a query to refetch. */
function UsageOf({ accountId }: { readonly accountId: AccountId }) {
  useAccountUsage(accountId);
  return null;
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

  it("refetches a project's batches when a batch event arrives, so a shipped pull request appears", async () => {
    const list = listBeforeHead('/projects/:projectId/batches');
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
        <BatchesOf projectId={mintId('Project')} />
      </>,
    );
    // The batch list's fetch, then the first-open refetch; count from there.
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
      expect(list.fetches()).toBe(2);
    });
    sockets[0]?.send(
      JSON.stringify(daemonEvent({ seq: 1, type: 'batch.updated', entityType: 'batch' })),
    );
    await waitFor(() => {
      expect(list.fetches()).toBe(3);
    });
  });

  it.each<{ name: string; type: DaemonEvent['type']; entityType: string }>([
    {
      name: 'a session, whose tokens and dollars are recorded when it ends',
      type: 'session.ended',
      entityType: 'session',
    },
    {
      name: 'an account, whose cap change alters the usage view',
      type: 'account.saved',
      entityType: 'account',
    },
  ])(
    'refetches an open usage query when an event about $name arrives',
    async ({ type, entityType }) => {
      const usagePath = `/accounts/${DEFAULT_ACCOUNT.id}/usage`;
      const usage = listBeforeHead(usagePath, accountUsageDto());
      const sockets: { send(data: string): void }[] = [];
      server.use(
        ...usage.handlers,
        ...baseHandlers(),
        eventStream.addEventListener('connection', ({ client }) => {
          sockets.push(client);
        }),
      );
      renderWithDaemon(
        <>
          <Stream />
          <UsageOf accountId={DEFAULT_ACCOUNT.id} />
        </>,
      );
      // The usage fetch, then the first-open refetch; count from there.
      await waitFor(() => {
        expect(sockets).toHaveLength(1);
        expect(usage.fetches()).toBe(2);
      });
      sockets[0]?.send(JSON.stringify(daemonEvent({ seq: 1, type, entityType })));
      await waitFor(() => {
        expect(usage.fetches()).toBe(3);
      });
    },
  );

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
