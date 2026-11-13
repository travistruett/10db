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
import { passActivityData, passViewDto, pagesByStatus } from '../test/pass-fixtures';
import { useAccounts, useAccountUsage } from './account-queries';
import { EVENT_INVALIDATIONS, eventStreamUrl, INVALIDATIONS, useEventStream } from './events';
import { screenKeys } from './screen-queries';
import { passKeys, useTurnActivity } from './pass-queries';
import { threadKeys } from './thread-queries';
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

function AccountList() {
  useAccounts();
  return null;
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

  it.each<{
    name: string;
    type: DaemonEvent['type'];
    entityType: string;
    refetchesUsage: boolean;
  }>([
    {
      name: 'session.ended, when its tokens and dollars are recorded',
      type: 'session.ended',
      entityType: 'session',
      refetchesUsage: true,
    },
    {
      name: 'account.saved, whose cap change alters the usage view',
      type: 'account.saved',
      entityType: 'account',
      refetchesUsage: true,
    },
    {
      name: 'session.activity, which fires on every tool call',
      type: 'session.activity',
      entityType: 'session',
      refetchesUsage: false,
    },
  ])('$name: usage refetch is $refetchesUsage', async ({ type, entityType, refetchesUsage }) => {
    const usagePath = `/accounts/${DEFAULT_ACCOUNT.id}/usage`;
    const usage = listBeforeHead(usagePath, accountUsageDto());
    let accountListFetches = 0;
    let projectFetches = 0;
    const sockets: { send(data: string): void }[] = [];
    server.use(
      ...usage.handlers,
      http.get(daemonUrl('/projects'), () => {
        projectFetches += 1;
        return HttpResponse.json([]);
      }),
      http.get(daemonUrl('/accounts'), () => {
        accountListFetches += 1;
        return HttpResponse.json([DEFAULT_ACCOUNT]);
      }),
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    renderWithDaemon(
      <>
        <Stream />
        <UsageOf accountId={DEFAULT_ACCOUNT.id} />
        <AccountList />
        <ProjectCount />
      </>,
    );
    // The fetch, then the first-open refetch; count from there.
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
      expect(usage.fetches()).toBe(2);
      expect(accountListFetches).toBeGreaterThan(0);
    });
    const listed = accountListFetches;
    const listedProjects = projectFetches;
    sockets[0]?.send(JSON.stringify(daemonEvent({ seq: 1, type, entityType })));
    if (refetchesUsage) {
      await waitFor(() => {
        expect(usage.fetches()).toBe(3);
      });
      // A session event never refreshes the account list; an account event does.
      if (entityType === 'account')
        await waitFor(() => {
          expect(accountListFetches).toBe(listed + 1);
        });
      else expect(accountListFetches).toBe(listed);
    } else {
      // A later event the stream handles in order marks the point by which the first would have acted.
      sockets[0]?.send(
        JSON.stringify(daemonEvent({ seq: 2, type: 'project.created', entityType: 'project' })),
      );
      await waitFor(() => {
        expect(projectFetches).toBe(listedProjects + 1);
      });
      expect(usage.fetches()).toBe(2);
      expect(accountListFetches).toBe(listed);
    }
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
      { timeout: 15_000 },
    );
    expect(new URL(urls[1] ?? 'ws://missing').searchParams.get('after')).toBe('42');
  });

  it('maps the knowledge entities to the knowledge lists, their proposals and provenance', () => {
    // The stream's first open refetches everything, so a rendered event test would pass without
    // the mapping; the table is what can go wrong.
    for (const entity of ['decision', 'principle', 'proposal']) {
      expect(INVALIDATIONS[entity]).toEqual(
        expect.arrayContaining([['knowledge'], ['proposals'], ['provenance']]),
      );
    }
    // The goal digest's Decisions row still follows decisions.
    expect(INVALIDATIONS['decision']).toEqual(expect.arrayContaining([['goals']]));
  });

  it("refetches an open Plan view's conversations when a converted decision or principle changes", () => {
    // A converted row reads 'Converted · in Knowledge' from the record's state, so a retire or
    // withdraw from outside the view must reach it.
    for (const entity of ['decision', 'principle']) {
      expect(INVALIDATIONS[entity]).toEqual(expect.arrayContaining([['shapes']]));
    }
  });

  it('refetches the Models page when a profile, an account or its list, a role setting, a pattern or a persona changes', () => {
    // The router's picks read all of them.
    for (const entity of [
      'model_profile',
      'account_models',
      'account',
      'role_setting',
      'pattern',
      'persona',
      'playbook',
    ]) {
      expect(INVALIDATIONS[entity]).toEqual(expect.arrayContaining([['models']]));
    }
  });

  it.each([
    { entity: 'playbook', key: ['playbook'] },
    { entity: 'persona', key: ['personas'] },
  ])('refetches the $entity lists the settings page reads when one changes', ({ entity, key }) => {
    expect(INVALIDATIONS[entity]).toEqual(expect.arrayContaining([key]));
  });

  it('refetches the role settings and patterns when either changes', () => {
    for (const entity of ['role_setting', 'pattern']) {
      expect(INVALIDATIONS[entity]).toEqual(expect.arrayContaining([['model-settings']]));
    }
  });

  it("refetches a pass on every pass event, and a task's thread and turns when a message joins it", () => {
    // The stream's first open refetches everything, so the table is what can go wrong.
    expect(INVALIDATIONS['pass']).toEqual(expect.arrayContaining([passKeys.all]));
    // A message joining a page starts its turn, and a run pausing or resuming changes its page: the
    // queue reads both from the live passes.
    expect(EVENT_INVALIDATIONS['task.message_added']).toEqual(
      expect.arrayContaining([threadKeys.all, passKeys.turnsAll, passKeys.live]),
    );
    expect(INVALIDATIONS['workstream']).toEqual(expect.arrayContaining([passKeys.live]));
    // A tool call is written into the pass, never refetched: one arrives per call.
    for (const key of [
      ...(INVALIDATIONS['session'] ?? []),
      ...(EVENT_INVALIDATIONS['session.activity'] ?? []),
    ])
      expect(key[0]).not.toBe(passKeys.all[0]);
  });

  it("refetches a task's pictures when one is kept", () => {
    expect(EVENT_INVALIDATIONS['task.screen_added']).toEqual(
      expect.arrayContaining([screenKeys.all]),
    );
  });

  it("writes a pass lane's tool call into its page's turn, and leaves other lanes' pages alone", async () => {
    const { working, ready } = pagesByStatus();
    const view = passViewDto({ pages: [working, ready] });
    const sockets: { send(data: string): void }[] = [];
    server.use(
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    const seen: number[] = [];
    const { queryClient } = renderWithDaemon(
      <Stream
        onEvent={(event) => {
          seen.push(event.seq);
        }}
      />,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    queryClient.setQueryData(passKeys.live, [view]);
    queryClient.setQueryData(passKeys.view(view.pass.id), view);
    const workingRun = working.workstreamId ?? mintId('Workstream');
    const turnId = working.turn?.id ?? mintId('PassTurn');
    const at = '2026-11-09T12:29:30.000Z';
    // A lane outside the pass, then one with no turn: neither touches the pass.
    sockets[0]?.send(
      JSON.stringify(
        daemonEvent({
          seq: 1,
          type: 'session.activity',
          entityType: 'session',
          data: passActivityData(mintId('Workstream'), mintId('PassTurn')),
          at,
        }),
      ),
    );
    sockets[0]?.send(
      JSON.stringify(
        daemonEvent({
          seq: 2,
          type: 'session.activity',
          entityType: 'session',
          data: { ...passActivityData(workingRun, turnId), turn: null },
          at,
        }),
      ),
    );
    sockets[0]?.send(
      JSON.stringify(
        daemonEvent({
          seq: 3,
          type: 'session.activity',
          entityType: 'session',
          data: passActivityData(workingRun, turnId),
          at,
        }),
      ),
    );
    await waitFor(() => {
      expect(seen).toEqual([1, 2, 3]);
    });
    const activity = {
      tool: 'Edit',
      target: 'src/settings/form.tsx',
      filesTouched: ['src/settings/page.tsx', 'src/settings/form.tsx'],
      at,
    };
    const live = queryClient.getQueryData<(typeof view)[]>(passKeys.live);
    expect(live?.[0]?.pages[0]?.turn?.activity).toEqual(activity);
    expect(live?.[0]?.pages[1]).toEqual(ready);
    expect(
      queryClient.getQueryData<typeof view>(passKeys.view(view.pass.id))?.pages[0]?.turn?.activity,
    ).toEqual(activity);
  });

  it("reads an open turn log again on that turn's activity, and no other turn's", async () => {
    const turnId = mintId('PassTurn');
    const asked: string[] = [];
    const sockets: { send(data: string): void }[] = [];
    server.use(
      ...baseHandlers(),
      http.get(daemonUrl('/pass-turns/:turnId/activity'), ({ params }) => {
        asked.push(String(params['turnId']));
        return HttpResponse.json([]);
      }),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    const seen: number[] = [];
    function OpenLog() {
      useTurnActivity(turnId, true);
      return null;
    }
    const { queryClient } = renderWithDaemon(
      <>
        <Stream
          onEvent={(event) => {
            seen.push(event.seq);
          }}
        />
        <OpenLog />
      </>,
    );
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    // The stream reads everything again as it opens; count from once that has settled.
    await waitFor(() => {
      expect(asked.length > 0 && queryClient.isFetching() === 0).toBe(true);
    });
    const before = asked.length;
    const run = mintId('Workstream');
    for (const [seq, turn] of [
      [1, mintId('PassTurn')],
      [2, turnId],
    ] as const)
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({
            seq,
            type: 'session.activity',
            entityType: 'session',
            data: passActivityData(run, turn),
          }),
        ),
      );
    await waitFor(() => {
      expect(seen).toEqual([1, 2]);
    });
    await waitFor(() => {
      expect(asked).toHaveLength(before + 1);
    });
    expect(new Set(asked)).toEqual(new Set([turnId]));
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
