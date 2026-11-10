import { mintId, PassOpenRequest, type AreaDef } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto, taskDto } from '../../test/fixtures';
import {
  goalPassPagesDto,
  pagesByStatus,
  pagesProposalDto,
  passDto,
  passHandlers,
  passOpenedDto,
  passStartDto,
  passViewDto,
  type PassRoutes,
} from '../../test/pass-fixtures';

// The Workbench route over the daemon: what it reads for the selected project, and what it sends.

const areas: AreaDef[] = [
  { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
  { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
];
const project = projectViewDto({ name: 'ampsio', areas });
const start = passStartDto({
  pages: [
    { area: 'settings', route: '/settings', lastChangedAt: null, uncommitted: 0, heldBy: null },
    { area: 'people', route: '/people', lastChangedAt: null, uncommitted: 0, heldBy: null },
  ],
});

/** The app at `path` over a daemon with `project` and these Workbench answers; the opens it was sent. */
function open(path: string, routes: PassRoutes = {}, opts: { tasks?: unknown[] } = {}) {
  const opened: { projectId: string; body: PassOpenRequest }[] = [];
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(opts.tasks ?? [])),
    http.post(daemonUrl('/projects/:projectId/passes'), async ({ params, request }) => {
      opened.push({
        projectId: String(params['projectId']),
        body: PassOpenRequest.parse(await request.json()),
      });
      return HttpResponse.json(passOpenedDto({ projectId: project.id }));
    }),
    ...passHandlers({ start: { [project.id]: start }, ...routes }),
    ...baseHandlers(),
  );
  const { router } = renderApp(path);
  return { opened, router };
}

const row = (name: string) => screen.findByRole('checkbox', { name: new RegExp(`^${name}`) });

describe('WorkbenchView', () => {
  it("with no pass open, is the picker over the project's pages, and Start Pass opens one there", async () => {
    const { opened } = open('/workbench');
    fireEvent.click(await row('settings'));
    fireEvent.click(screen.getByRole('button', { name: 'Start Pass (1)' }));
    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(opened[0]?.projectId).toBe(project.id);
    expect(opened[0]?.body).toMatchObject({ pages: ['settings'], taskIds: [] });
  });

  it("ticks the Board's tasks a link names", async () => {
    const task = taskDto({ projectId: project.id, title: 'People list', areas: ['people'] });
    const { opened } = open(`/workbench?tasks=${JSON.stringify([task.id])}`, {}, { tasks: [task] });
    expect(await row('People list')).toHaveProperty('checked', true);
    fireEvent.click(screen.getByRole('button', { name: 'Start Pass (1)' }));
    await waitFor(() => {
      expect(opened[0]?.body).toMatchObject({ taskIds: [task.id], pages: [] });
    });
  });

  it("ticks a goal's pages and opens the pass for that goal", async () => {
    const goal = mintId('Goal');
    const { opened } = open(`/workbench?goal=${goal}`, {
      goalPages: goalPassPagesDto({ pages: ['people'], fromTasks: [] }),
    });
    await waitFor(async () => {
      expect(await row('people')).toHaveProperty('checked', true);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start Pass (1)' }));
    await waitFor(() => {
      expect(opened[0]?.body).toMatchObject({ pages: ['people'], goalId: goal });
    });
  });

  it("with the project's pass open, draws its header and queue, the address's page current", async () => {
    const { ready, working } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [ready, working] });
    const other = passViewDto({ pass: { name: 'Their pass' }, pages: [pagesByStatus().ready] });
    const { router } = open(`/workbench?task=${working.taskId}`, { live: [other, live] });
    expect(await screen.findByText('ampsio · Settings pass · 1 ready · 1 working')).toBeTruthy();
    const queue = screen.getByRole('list', { name: 'Pages in this pass' });
    expect(
      within(queue)
        .getByRole('button', { name: /^Billing/ })
        .getAttribute('aria-current'),
    ).toBe('true');
    fireEvent.click(within(queue).getByRole('button', { name: /^Settings/ }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: ready.taskId });
    });
  });

  it('with no page area, proposes some through the daemon', async () => {
    let proposed = 0;
    const bare = projectViewDto({ areas: [{ name: 'src', globs: ['src/**'] }] });
    server.use(
      http.post(daemonUrl('/projects/:projectId/propose-page-areas'), () => {
        proposed += 1;
        return HttpResponse.json(pagesProposalDto());
      }),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([bare])),
      ...baseHandlers(),
    );
    renderApp('/workbench');
    fireEvent.click(await screen.findByRole('button', { name: 'Propose Page Areas' }));
    await waitFor(() => {
      expect(proposed).toBe(1);
    });
  });
});
