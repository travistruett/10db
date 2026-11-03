import { PROTOCOL_VERSION } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../test/daemon';

const COMMIT = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

function healthWith(commit: string | null) {
  return http.get(daemonUrl('/health'), () =>
    HttpResponse.json({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-29T12:00:00.000Z',
      commit,
    }),
  );
}

describe('the commit in the header', () => {
  it('names the commit the app was built from, short, with the whole SHA to hand', async () => {
    server.use(healthWith(COMMIT), ...baseHandlers());
    renderApp('/board');
    const label = await screen.findByLabelText(`Running commit ${COMMIT}`);
    expect(label.textContent).toBe('0a1b2c3');
  });

  it('says so when the app runs from source and has no commit', async () => {
    server.use(healthWith(null), ...baseHandlers());
    renderApp('/board');
    const label = await screen.findByLabelText('Not an installed build: running from source');
    expect(label.textContent).toBe('dev');
  });

  it('follows the daemon when a newer app restarts it', async () => {
    server.use(healthWith(COMMIT), ...baseHandlers());
    renderApp('/board', { intervals: { healthy: 30, disconnected: 30 } });
    await screen.findByLabelText(`Running commit ${COMMIT}`);
    const next = 'f'.repeat(40);
    server.use(healthWith(next), ...baseHandlers());
    expect((await screen.findByLabelText(`Running commit ${next}`)).textContent).toBe('fffffff');
  });
});
