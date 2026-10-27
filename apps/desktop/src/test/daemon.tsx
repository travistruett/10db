import { EventsHead, KeepAwakeStatus, PROTOCOL_VERSION, SystemCheckDto } from '@10db/contracts';
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { http, HttpResponse, ws, type HttpHandler, type WebSocketHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { App } from '../app';
import type { ConnectionResolver, DaemonConnection } from '../daemon/connection';
import { DaemonProvider, type DaemonIntervals } from '../daemon/provider';
import { createAppRouter, type AppRouter } from '../router';
import { cssVariablesResolver, theme } from '../theme';
import { DEFAULT_ACCOUNT } from './account-fixtures';

/** The daemon every UI test talks to, through MSW. */
export const TEST_CONNECTION: DaemonConnection = {
  url: 'http://127.0.0.1:4999',
  token: 'test-token',
};

/** Shared MSW server; `setup.ts` starts it with `onUnhandledFrame: 'error'`. */
export const server = setupServer();

/** The test daemon's event stream. */
export const eventStream = ws.link('ws://127.0.0.1:4999/events/stream');

export function daemonUrl(path: string, base: string = TEST_CONNECTION.url): string {
  return `${base}${path}`;
}

const STARTED_AT = '2026-10-13T12:00:00.000Z';

/** A healthy, empty daemon. Tests put their own handlers first with `server.use(mine, ...baseHandlers())`. */
export function baseHandlers(
  opts: { readonly headSeq?: number; readonly url?: string } = {},
): (HttpHandler | WebSocketHandler)[] {
  const base = opts.url ?? TEST_CONNECTION.url;
  return [
    http.get(daemonUrl('/health', base), () =>
      HttpResponse.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION, startedAt: STARTED_AT }),
    ),
    http.get(daemonUrl('/events/head', base), () =>
      HttpResponse.json(EventsHead.parse({ seq: opts.headSeq ?? 0 })),
    ),
    http.get(daemonUrl('/accounts', base), () => HttpResponse.json([DEFAULT_ACCOUNT])),
    http.get(daemonUrl('/projects', base), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/batches', base), () => HttpResponse.json([])),
    http.get(daemonUrl('/workstreams', base), () => HttpResponse.json([])),
    http.get(daemonUrl('/inbox', base), () => HttpResponse.json([])),
    http.get(daemonUrl('/settings/keep-awake', base), () =>
      HttpResponse.json(KeepAwakeStatus.parse({ mode: 'while_running', active: false })),
    ),
    http.get(daemonUrl('/system', base), () =>
      HttpResponse.json(
        SystemCheckDto.parse({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          tools: [
            {
              name: 'claude',
              path: '/usr/local/bin/claude',
              version: '2.1.299 (Claude Code)',
              required: true,
            },
            { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0', required: true },
            { name: 'docker', path: null, version: null, required: false },
          ],
        }),
      ),
    ),
    // Sockets connect and stay quiet unless a test adds its own connection listener.
    eventStream.addEventListener('connection', () => undefined),
  ];
}

export interface RenderOptions {
  readonly resolve?: ConnectionResolver;
  readonly intervals?: DaemonIntervals;
}

const resolveTest: ConnectionResolver = () => Promise.resolve(TEST_CONNECTION);

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/** The whole app (shell, router, daemon provider) at `path`. */
export function renderApp(
  path = '/',
  opts: RenderOptions = {},
): { router: AppRouter; queryClient: QueryClient } {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = testQueryClient();
  render(
    <App
      router={router}
      queryClient={queryClient}
      resolve={opts.resolve ?? resolveTest}
      {...(opts.intervals ? { intervals: opts.intervals } : {})}
    />,
  );
  return { router, queryClient };
}

/** One component inside the providers, without the router or shell. */
export function renderWithDaemon(
  ui: ReactElement,
  opts: RenderOptions = {},
): { queryClient: QueryClient } {
  const queryClient = testQueryClient();
  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <QueryClientProvider client={queryClient}>
        <DaemonProvider
          resolve={opts.resolve ?? resolveTest}
          {...(opts.intervals ? { intervals: opts.intervals } : {})}
        >
          {ui}
        </DaemonProvider>
      </QueryClientProvider>
    </MantineProvider>,
  );
  return { queryClient };
}
