import { mintId, PROTOCOL_VERSION } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from './test/daemon';
import { inboxItemDto, projectViewDto } from './test/fixtures';
import { passKeys } from './daemon/pass-queries';
import { pagesByStatus, passViewDto } from './test/pass-fixtures';

const healthy = () =>
  http.get(daemonUrl('/health'), () =>
    HttpResponse.json({
      status: 'ok',
      protocolVersion: PROTOCOL_VERSION,
      startedAt: '2026-10-13T12:00:00.000Z',
    }),
  );

describe('App shell', () => {
  it('opens Settings from the rail at the app-wide overview', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/factory');
    fireEvent.click(await screen.findByRole('link', { name: 'Settings' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/overview');
    });
  });

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

  it('counts a missing tool and an unreadable login shell on the Inbox link, with nothing above the view', async () => {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json({
          loginEnv: {
            source: 'inherited',
            warning:
              'The login shell timed out after 10 s; using the environment 10db was started with',
          },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          codex: { verifiedOn: '0.154.0', warning: null },
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
    // docker is optional, so its absence is not counted.
    expect(await screen.findByRole('link', { name: /Inbox.*2 open cards/ })).toBeTruthy();
    expect(screen.queryByText('claude was not found where 10db looks for it')).toBeNull();
    expect(screen.queryByText(/The login shell timed out after 10 s/)).toBeNull();
  });

  it('shows the open-card count on the Inbox link', async () => {
    server.use(
      http.get(daemonUrl('/inbox/page'), () =>
        HttpResponse.json({ items: [inboxItemDto()], total: 1, page: 1, pageSize: 1 }),
      ),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByRole('link', { name: /Inbox.*1 open card/ })).toBeTruthy();
  });

  it("counts the selected project's pass pages that wait on the builder on the UI Workbench link", async () => {
    const project = projectViewDto({ name: 'ampsio' });
    const pages = pagesByStatus();
    const live = passViewDto({
      pass: { projectId: project.id },
      pages: [pages.ready, pages.failed, pages.working, { ...pages.notStarted, signOff: 'done' }],
    });
    // Another project's pass is not counted.
    const elsewhere = passViewDto({ pass: { projectId: mintId('Project') }, pages: [pages.ready] });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/passes'), () => HttpResponse.json([elsewhere, live])),
      ...baseHandlers(),
    );
    renderApp('/factory');
    expect(await screen.findByRole('link', { name: /UI Workbench.*2 pages waiting/ })).toBeTruthy();
  });

  it('counts nothing on the UI Workbench link for a closed pass still to settle', async () => {
    const project = projectViewDto({ name: 'ampsio' });
    const pages = pagesByStatus();
    const closed = passViewDto({
      pass: { projectId: project.id, state: 'CLOSED' },
      pages: [pages.ready, pages.failed],
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/passes'), () => HttpResponse.json([closed])),
      ...baseHandlers(),
    );
    const { queryClient } = renderApp('/factory');
    await waitFor(() => {
      expect(queryClient.getQueryState(passKeys.live)?.status).toBe('success');
    });
    expect(screen.getByRole('link', { name: 'UI Workbench' })).toBeTruthy();
  });

  it('draws the color scheme toggle icon at the 18px size of the rail’s icons', async () => {
    server.use(...baseHandlers());
    renderApp();
    const toggle = await screen.findByRole('button', { name: /^Switch to (dark|light) mode$/ });
    expect(toggle.querySelector('svg')?.getAttribute('width')).toBe('18');
  });

  it('opens the UI Workbench from the sidebar, between Plan and Knowledge', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/factory');
    fireEvent.click(await screen.findByRole('link', { name: 'UI Workbench' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench');
    });
    expect(await screen.findByRole('heading', { name: 'UI Workbench' })).toBeTruthy();
  });
});
