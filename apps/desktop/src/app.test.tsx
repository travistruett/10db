import { PROTOCOL_VERSION } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from './test/daemon';
import { inboxItemDto } from './test/fixtures';

const healthy = () =>
  http.get(daemonUrl('/health'), () =>
    HttpResponse.json({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-13T12:00:00.000Z',
    }),
  );

describe('App shell', () => {
  it('shows no daemon status in the header while connected', async () => {
    server.use(...baseHandlers());
    renderApp('/factory');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    expect(screen.queryByText(/daemon/i)).toBeNull();
    expect(screen.queryByRole('img', { name: /daemon/i })).toBeNull();
  });

  it('waits on a connecting screen while the daemon is unreachable', async () => {
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    renderApp();
    expect(await screen.findByText('Connecting to the 10db daemon…')).toBeTruthy();
  });

  it('redirects / to the Factory view and navigates to Inbox', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Inbox' }));
    expect(await screen.findByRole('heading', { name: 'Inbox' })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/inbox');
  });

  it('keeps the view and shows a banner while reconnecting, then clears it', async () => {
    server.use(...baseHandlers());
    renderApp('/factory', { intervals: { healthy: 40, disconnected: 40 } });
    expect(await screen.findByRole('heading', { name: 'Factory' })).toBeTruthy();
    server.use(http.get(daemonUrl('/health'), () => HttpResponse.error()));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Reconnecting to the daemon…',
    );
    expect(screen.getByRole('img', { name: 'Reconnecting to the daemon' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Factory' })).toBeTruthy();
    server.use(healthy());
    await waitFor(() => {
      expect(screen.queryByRole('status')).toBeNull();
    });
    expect(screen.queryByRole('img', { name: /daemon/i })).toBeNull();
  });

  it('warns when a required tool is missing or the login shell could not be read', async () => {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json({
          loginEnv: {
            source: 'inherited',
            warning:
              'The login shell timed out after 10 s; using the environment 10db was started with',
          },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          tools: [
            { name: 'claude', path: null, version: null, required: true },
            { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0', required: true },
            { name: 'docker', path: null, version: null, required: false },
          ],
        }),
      ),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByText('claude was not found on your login PATH')).toBeTruthy();
    expect(screen.getByText(/The login shell timed out after 10 s/)).toBeTruthy();
    // docker is optional, so its absence is not an alert.
    expect(screen.queryByText('docker was not found on your login PATH')).toBeNull();
  });

  it('warns when Claude Code is newer than the account checks were verified on', async () => {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: {
            verifiedOn: '2.1.302',
            warning: 'Claude Code 3.0.0 is a newer major version.',
          },
          tools: [
            { name: 'claude', path: '/bin/claude', version: '3.0.0 (Claude Code)', required: true },
            { name: 'git', path: '/usr/bin/git', version: 'git version 2.50.0', required: true },
          ],
        }),
      ),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(
      await screen.findByText("This Claude Code is newer than 10db's account checks"),
    ).toBeTruthy();
    expect(screen.getByText('Claude Code 3.0.0 is a newer major version.')).toBeTruthy();
  });

  it('shows the open-card count on the Inbox link', async () => {
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([inboxItemDto()])),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByRole('link', { name: /Inbox.*1 open card/ })).toBeTruthy();
  });

  it('draws the color scheme toggle icon at the 20px size DESIGN.md sets', async () => {
    server.use(...baseHandlers());
    renderApp();
    const toggle = await screen.findByRole('button', { name: /^Switch to (dark|light) mode$/ });
    expect(toggle.querySelector('svg')?.getAttribute('width')).toBe('20');
  });
});
