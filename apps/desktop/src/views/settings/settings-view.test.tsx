import { KeepAwakeStatus } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

describe('SettingsView', () => {
  it('opens General from /settings and lists every section in its group', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings');
    expect(await screen.findByRole('heading', { name: 'Settings', level: 2 })).toBeTruthy();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const label of [
      'General',
      'Board columns',
      'Areas and hazards',
      'Billing',
      'Team',
      'Routing rules',
      'Keep-awake',
      'Accounts',
      'Models and benchmarks',
      'Personas and flows',
    ])
      expect(within(nav).getByRole('link', { name: new RegExp(label) })).toBeTruthy();
  });

  it('redirects an unknown section to General', async () => {
    server.use(...baseHandlers());
    const { router } = renderApp('/settings/nope');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/general');
    });
  });

  it('says what a planned section will hold and which plan fills it', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/accounts');
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 3 })).toBeTruthy();
    expect(screen.getByText(/Not built yet/)).toBeTruthy();
    expect(screen.getByText(/accounts plan/)).toBeTruthy();
  });

  it('asks for a project before showing a project section', async () => {
    server.use(...baseHandlers());
    renderApp('/settings/areas');
    expect(await screen.findByText('Create a project on the board first.')).toBeTruthy();
  });

  it("shows the selected project's areas, hazards and billing", async () => {
    const project = projectDto({
      areas: [{ name: 'api', globs: ['src/api/**'] }],
      hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
    });
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    expect(await screen.findByText('src/api/**')).toBeTruthy();
    expect(screen.getByText('pnpm add')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: /Billing/ }));
    expect(await screen.findByText('Subscription')).toBeTruthy();
    expect(screen.getByText(/account picker/)).toBeTruthy();
  });

  it('changes the keep-awake mode', async () => {
    const put: unknown[] = [];
    server.use(
      http.put(daemonUrl('/settings/keep-awake'), async ({ request }) => {
        put.push(await request.json());
        return HttpResponse.json(KeepAwakeStatus.parse({ mode: 'always', active: true }));
      }),
      ...baseHandlers(),
    );
    renderApp('/settings/keep-awake');
    fireEvent.click(await screen.findByRole('radio', { name: 'Always keep the Mac awake' }));
    await waitFor(() => {
      expect(put).toEqual([{ mode: 'always' }]);
    });
  });
});
