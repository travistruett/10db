import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { App } from './app';
import { DAEMON_URL } from './daemon/client';
import { createAppRouter } from './router';

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function renderApp(path = '/') {
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<App router={router} queryClient={queryClient} />);
  return router;
}

describe('App shell', () => {
  it('shows the daemon as connected when /health answers', async () => {
    server.use(
      http.get(`${DAEMON_URL}/health`, () =>
        HttpResponse.json({
          status: 'ok',
          protocolVersion: 1,
          startedAt: '2026-10-13T12:00:00.000Z',
        }),
      ),
    );
    renderApp();
    expect(await screen.findByText('Daemon connected')).toBeTruthy();
  });

  it('shows the daemon as unreachable when /health fails', async () => {
    server.use(http.get(`${DAEMON_URL}/health`, () => HttpResponse.error()));
    renderApp();
    expect(await screen.findByText('Daemon unreachable')).toBeTruthy();
  });

  it('redirects / to the Factory view and navigates to Inbox', async () => {
    server.use(http.get(`${DAEMON_URL}/health`, () => HttpResponse.error()));
    const router = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('draws the color scheme toggle icon at the 20px size DESIGN.md sets', async () => {
    server.use(http.get(`${DAEMON_URL}/health`, () => HttpResponse.error()));
    renderApp();
    const toggle = await screen.findByRole('button', { name: /^Switch to (dark|light) mode$/ });
    expect(toggle.querySelector('svg')?.getAttribute('width')).toBe('20');
  });
});
