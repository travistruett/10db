import { AreaRole, SettingField, type WorkbenchSetupDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemonAndRouter, server } from '../../../test/daemon';
import { projectDto, projectViewDto } from '../../../test/fixtures';
import { workbenchSetupDto } from '../../../test/pass-fixtures';
import { WorkbenchSetup } from './workbench-setup';

const PROJECT = projectViewDto({ name: 'ampsio', areas: [{ name: 'repo', globs: ['**'] }] });

const SETUP = workbenchSetupDto({
  areas: {
    proposed: [
      { name: 'repo', globs: ['**'] },
      { name: 'board', globs: ['src/views/board/**'], role: AreaRole.Page, route: '/board' },
      { name: 'inbox', globs: ['src/views/inbox/**'], role: AreaRole.Page, route: '/inbox' },
      { name: 'ui-shared', globs: ['src/**'], role: AreaRole.Shared },
    ],
    kept: [{ name: 'repo', reason: 'kept: 146 open tasks name it' }],
    pages: [
      { name: 'board', route: '/board', folders: ['src/views/board/'] },
      { name: 'inbox', route: '/inbox', folders: ['src/views/inbox/'] },
    ],
    skipped: [{ name: 'review', reason: 'no route shows it' }],
  },
});

/** Serves the setup and records each patch; `refuse` answers the patch 400 with its words. */
function serve(setup: WorkbenchSetupDto | Promise<never>, refuse?: string) {
  const patches: unknown[] = [];
  server.use(
    http.post(daemonUrl('/projects/:projectId/workbench-setup'), async () =>
      HttpResponse.json(await setup),
    ),
    http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
      patches.push(await request.json());
      return refuse === undefined
        ? HttpResponse.json(projectDto())
        : HttpResponse.json({ error: 'invalid', message: refuse }, { status: 400 });
    }),
    ...baseHandlers(),
  );
  return patches;
}

describe('WorkbenchSetup', () => {
  it('says it is reading the repository while the proposal runs', async () => {
    serve(new Promise<never>(() => undefined));
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Reading the repository…',
    );
  });

  it('shows the summary, a row per new page, what is kept and left out, and the other areas behind Show', async () => {
    serve(SETUP);
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(
      await screen.findByText('1 area → 4: 2 pages, 1 shared, 1 other; repo keeps its name'),
    ).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Make board a page at /board' })).toHaveProperty(
      'checked',
      true,
    );
    expect(screen.getByText('kept: 146 open tasks name it')).toBeTruthy();
    expect(screen.getByText('review: no route shows it')).toBeTruthy();
    const show = screen.getByRole('button', { name: 'Show Other Areas (2)' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(
      screen.getByRole('button', { name: 'Hide Other Areas' }).getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('applies the ticked rows in one patch: an unticked page is folded back', async () => {
    const patches = serve(SETUP);
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Make inbox a page at /inbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply (1)' }));
    await waitFor(() => {
      expect(patches).toEqual([{ areas: SETUP.areas.proposed.filter((a) => a.name !== 'inbox') }]);
    });
  });

  it('says the words of a refused Apply above the button', async () => {
    serve(SETUP, 'An area or hazard name is used twice');
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Apply (2)' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'An area or hazard name is used twice',
    );
  });

  it('shows the settings and the branch note when the daemon has them, and sends the ticked settings', async () => {
    const patches = serve({
      ...SETUP,
      settings: [
        {
          field: SettingField.AppUrl,
          value: 'http://localhost:1420',
          source: 'from tauri.conf.json',
        },
      ],
      branch: { branch: 'build', ahead: 39, command: 'git push origin build' },
    });
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(await screen.findByText('from tauri.conf.json')).toBeTruthy();
    expect(screen.getByText('git push origin build')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply (3)' }));
    await waitFor(() => {
      expect(patches).toEqual([{ areas: SETUP.areas.proposed, appUrl: 'http://localhost:1420' }]);
    });
  });

  it('once the project has pages, offers the rebuild unticked and applies only what is ticked', async () => {
    const paged = projectViewDto({
      name: 'ampsio',
      areas: [{ name: 'repo', globs: ['**'] }, ...SETUP.areas.proposed.slice(1, 2)],
    });
    const setting = {
      field: SettingField.AppUrl,
      value: 'http://localhost:1420',
      source: 'from tauri.conf.json',
    } as const;
    const patches = serve({ ...SETUP, settings: [setting] });
    await renderWithDaemonAndRouter(<WorkbenchSetup project={paged} />);
    const rebuild = await screen.findByRole('checkbox', { name: /^Rebuild areas: 2 new pages/ });
    expect(rebuild).toHaveProperty('checked', false);
    expect(screen.queryByRole('checkbox', { name: 'Make board a page at /board' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply (1)' }));
    await waitFor(() => {
      expect(patches).toEqual([{ appUrl: 'http://localhost:1420' }]);
    });
    fireEvent.click(rebuild);
    expect(screen.getByRole('checkbox', { name: 'Make board a page at /board' })).toBeTruthy();
  });

  it('offers no Areas when the rebuild changes nothing, and applies the settings alone', async () => {
    const patches = serve({
      ...SETUP,
      areas: { proposed: PROJECT.areas, kept: [], pages: [], skipped: [] },
      settings: [{ field: SettingField.AppUrl, value: 'http://localhost:1420', source: 'from x' }],
    });
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(await screen.findByText('from x')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Areas' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply (1)' }));
    await waitFor(() => {
      expect(patches).toEqual([{ appUrl: 'http://localhost:1420' }]);
    });
  });

  it('says there is nothing to set up when the rebuilt list is the project’s own', async () => {
    serve({ ...SETUP, areas: { proposed: PROJECT.areas, kept: [], pages: [], skipped: [] } });
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(await screen.findByText('Nothing to set up.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings › Areas and hazards' })).toBeTruthy();
  });

  it('says why a proposal failed and offers Try Again', async () => {
    let asked = 0;
    server.use(
      http.post(daemonUrl('/projects/:projectId/workbench-setup'), () => {
        asked += 1;
        return HttpResponse.json(
          { error: 'invalid', message: 'Not a repository' },
          { status: 400 },
        );
      }),
      ...baseHandlers(),
    );
    await renderWithDaemonAndRouter(<WorkbenchSetup project={PROJECT} />);
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'The setup could not be read: Not a repository',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(() => {
      expect(asked).toBe(2);
    });
  });
});
