import { PROTOCOL_VERSION } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, ws } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server, TEST_CONNECTION } from '../test/daemon';
import { daemonEvent } from '../test/fixtures';
import type { ConnectionResolver, DaemonConnection } from './connection';
import { useEventStream } from './events';
import { HEALTH_TIMEOUT_MS, useDaemon, useDaemonStatus } from './provider';

const FAST = { healthy: 40, disconnected: 40 } as const;

function StatusProbe() {
  const status = useDaemonStatus();
  const { connection } = useDaemon();
  return (
    <p data-testid="probe">
      {status.kind} {connection.url}
    </p>
  );
}

const probeText = (): string | null => screen.getByTestId('probe').textContent;

describe('DaemonProvider', () => {
  it('waits on a connecting screen and says why', async () => {
    const failing: ConnectionResolver = () =>
      Promise.reject(new Error('Set VITE_DAEMON_TOKEN to the daemon UI token'));
    renderWithDaemon(<StatusProbe />, { resolve: failing });
    expect(await screen.findByText('Connecting to the 10db daemon…')).toBeTruthy();
    expect(await screen.findByText(/Set VITE_DAEMON_TOKEN/)).toBeTruthy();
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('renders the app once the daemon answers', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(<StatusProbe />);
    await waitFor(() => {
      expect(probeText()).toBe(`connected ${TEST_CONNECTION.url}`);
    });
  });

  it('stops at a version mismatch instead of rendering the app', async () => {
    server.use(
      http.get(daemonUrl('/health'), () =>
        HttpResponse.json({
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION + 1,
          startedAt: '2026-10-13T12:00:00.000Z',
        }),
      ),
      ...baseHandlers(),
    );
    renderWithDaemon(<StatusProbe />);
    expect(await screen.findByText('10db needs a restart')).toBeTruthy();
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('follows a restarted daemon to its new port and resumes the stream after the last event', async () => {
    const portB: DaemonConnection = { url: 'http://127.0.0.1:5000', token: 'test-token-2' };
    let announced: DaemonConnection = TEST_CONNECTION;
    const resolve: ConnectionResolver = () => Promise.resolve(announced);
    const streamA = ws.link('ws://127.0.0.1:4999/events/stream');
    const streamB = ws.link('ws://127.0.0.1:5000/events/stream');
    const seen: number[] = [];
    const urlsB: string[] = [];
    let headCallsB = 0;
    let firstA = true;

    function StreamProbe() {
      useEventStream((event) => {
        seen.push(event.seq);
      });
      return <StatusProbe />;
    }

    server.use(
      ...baseHandlers({ headSeq: 10 }),
      streamA.addEventListener('connection', ({ client }) => {
        if (!firstA) return;
        firstA = false;
        client.send(JSON.stringify(daemonEvent({ seq: 11 })));
        client.send(JSON.stringify(daemonEvent({ seq: 12 })));
      }),
    );
    renderWithDaemon(<StreamProbe />, { resolve, intervals: FAST });
    await waitFor(() => {
      expect(seen).toEqual([11, 12]);
    });

    // The daemon is killed: port 4999 stops answering, and the supervisor restarts it on 5000,
    // which isn't ready yet.
    announced = portB;
    server.use(
      http.get(daemonUrl('/health'), () => HttpResponse.error()),
      http.get(daemonUrl('/health', portB.url), () => HttpResponse.error()),
    );
    for (const client of streamA.clients) client.close();
    await waitFor(() => {
      expect(probeText()).toMatch(/^reconnecting /);
    });

    // The new daemon comes up; its event log continues from the same database.
    server.use(
      http.get(daemonUrl('/health', portB.url), () =>
        HttpResponse.json({
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION,
          startedAt: '2026-10-14T08:00:00.000Z',
        }),
      ),
      http.get(daemonUrl('/events/head', portB.url), () => {
        headCallsB += 1;
        return HttpResponse.json({ seq: 99 });
      }),
      streamB.addEventListener('connection', ({ client }) => {
        urlsB.push(client.url.toString());
        client.send(JSON.stringify(daemonEvent({ seq: 12 })));
        client.send(JSON.stringify(daemonEvent({ seq: 13 })));
      }),
    );
    await waitFor(() => {
      expect(probeText()).toBe(`connected ${portB.url}`);
    });
    await waitFor(() => {
      expect(seen).toEqual([11, 12, 13]);
    });
    const resumed = new URL(urlsB[0] ?? 'ws://missing');
    expect(resumed.searchParams.get('after')).toBe('12');
    expect(resumed.searchParams.get('token')).toBe('test-token-2');
    // It resumed from its own cursor; it didn't skip to the new daemon's head.
    expect(headCallsB).toBe(0);
  });

  it('treats a daemon that stops answering as down instead of waiting on it', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(<StatusProbe />, { intervals: FAST });
    await waitFor(() => {
      expect(probeText()).toBe(`connected ${TEST_CONNECTION.url}`);
    });
    // The process is alive and accepting connections but never answers.
    server.use(http.get(daemonUrl('/health'), () => new Promise<never>(() => undefined)));
    await waitFor(
      () => {
        expect(probeText()).toMatch(/^reconnecting /);
      },
      { timeout: HEALTH_TIMEOUT_MS + 3_000 },
    );
  });
});
