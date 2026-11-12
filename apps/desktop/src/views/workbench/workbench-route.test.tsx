import {
  mintId,
  PassClosePreviewDto,
  PassJoinRequest,
  PassOpenRequest,
  PassRename,
  type AreaDef,
} from '@10db/contracts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { findPagesInput, pickOption, pillsOf } from '../../test/combobox';
import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto, projectViewDto, taskDto } from '../../test/fixtures';
import {
  goalPassPagesDto,
  askItem,
  pagesByStatus,
  workbenchSetupDto,
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
function open(
  path: string,
  routes: PassRoutes = {},
  opts: { tasks?: unknown[]; first?: Parameters<typeof server.use> } = {},
) {
  const opened: { projectId: string; body: PassOpenRequest }[] = [];
  server.use(
    ...(opts.first ?? []),
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
  const { router, queryClient } = renderApp(path);
  return { opened, router, queryClient };
}

const pick = async (name: string) => pickOption(await findPagesInput(), new RegExp(`^${name}`));
const picked = async () => pillsOf(await findPagesInput());

describe('WorkbenchView', () => {
  it("with no pass open, is the picker over the project's pages, and Start Pass opens one there", async () => {
    const { opened } = open('/workbench');
    await pick('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(opened).toHaveLength(1);
    });
    expect(opened[0]?.projectId).toBe(project.id);
    expect(opened[0]?.body).toMatchObject({ pages: ['settings'], taskIds: [] });
  });

  it("ticks the Board's tasks a link names", async () => {
    const task = taskDto({ projectId: project.id, title: 'People list', areas: ['people'] });
    const { opened } = open(`/workbench?tasks=${JSON.stringify([task.id])}`, {}, { tasks: [task] });
    expect(within(await picked()).getByText('People list')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
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
      expect(within(await picked()).getByText('people')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
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
    const queue = screen.getByRole('list', { name: 'Open pages' });
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

  it('reads the setup for Set Up only while no pass is open', async () => {
    let asked = 0;
    const { ready } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [ready] });
    open(
      '/workbench',
      { live: [live] },
      {
        first: [
          http.post(daemonUrl('/projects/:projectId/workbench-setup'), () => {
            asked += 1;
            return HttpResponse.json(workbenchSetupDto());
          }),
        ],
      },
    );
    expect(await screen.findByRole('button', { name: 'More actions' })).toBeTruthy();
    expect(asked).toBe(0);
  });

  it('pins the page it shows into the address, so a reordered queue never swaps the page under a draft', async () => {
    const { ready, working } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [working, ready] });
    const { router } = open('/workbench', { live: [live] });
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: ready.taskId });
    });
    // Pinned in place: Back leaves the Workbench rather than unpinning.
    expect(router.history.length).toBe(1);
  });

  it.each([
    {
      action: 'Add Page',
      act: async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Add Page' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add Page' });
        await pickOption(await findPagesInput(dialog), /^people/);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Add Pages' }));
      },
      sent: { method: 'POST', path: 'pages', body: { pages: ['people'], taskIds: [] } },
    },
    {
      action: 'Rename',
      act: async () => {
        fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename', hidden: true }));
        const dialog = await screen.findByRole('dialog', { name: 'Rename' });
        fireEvent.change(within(dialog).getByLabelText('Name'), {
          target: { value: 'Density pass' },
        });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
      },
      sent: { method: 'PATCH', path: '', body: { name: 'Density pass' } },
    },
  ])("$action is sent for the project's open pass", async ({ act, sent }) => {
    const live = passViewDto({
      pass: passDto({ projectId: project.id }),
      pages: [pagesByStatus().ready],
    });
    const asked: { method: string; path: string; body: unknown }[] = [];
    server.use(
      http.post(daemonUrl('/passes/:passId/pages'), async ({ params, request }) => {
        asked.push({
          method: 'POST',
          path: `${String(params['passId'])}/pages`,
          body: PassJoinRequest.parse(await request.json()),
        });
        return HttpResponse.json(live);
      }),
      http.patch(daemonUrl('/passes/:passId'), async ({ params, request }) => {
        asked.push({
          method: 'PATCH',
          path: `${String(params['passId'])}/`,
          body: PassRename.parse(await request.json()),
        });
        return HttpResponse.json(live.pass);
      }),
    );
    open('/workbench', { live: [live] });
    await screen.findByText(/^ampsio · Settings pass/);
    await act();
    await waitFor(() => {
      expect(asked).toHaveLength(1);
    });
    expect(asked[0]).toMatchObject({
      method: sent.method,
      path: `${live.pass.id}/${sent.path}`,
    });
    expect(asked[0]?.body).toMatchObject(sent.body);
  });

  it("Abandon Pass abandons the project's open pass after its confirm", async () => {
    const live = passViewDto({
      pass: passDto({ projectId: project.id }),
      pages: [pagesByStatus().ready],
    });
    const abandoned: string[] = [];
    server.use(
      http.post(daemonUrl('/passes/:passId/abandon'), ({ params }) => {
        abandoned.push(String(params['passId']));
        return HttpResponse.json({
          reverted: [],
          stays: [],
          left: [],
          folder: { branch: 'main', returned: true },
          droppedShared: [],
          pullRequestLeftOpen: null,
        });
      }),
    );
    open('/workbench', { live: [live] });
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abandon', hidden: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Abandon' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Abandon' }));
    await waitFor(() => {
      expect(abandoned).toEqual([live.pass.id]);
    });
  });

  it("Close Pass reads the open pass's close lists and stops nothing", async () => {
    const live = passViewDto({
      pass: passDto({ projectId: project.id }),
      pages: [pagesByStatus().ready],
    });
    const asked: string[] = [];
    const posted: string[] = [];
    server.use(
      http.get(daemonUrl('/passes/:passId/close'), ({ params }) => {
        asked.push(String(params['passId']));
        return HttpResponse.json(
          PassClosePreviewDto.parse({
            token: 'lists-1',
            unfinished: [],
            unowned: [],
            foreignCommits: [],
            summary: 'Lands 1 page on main.',
            gate: { where: 'none', consequence: null },
          }),
        );
      }),
      http.post(daemonUrl('/passes/:passId/close'), ({ params }) => {
        posted.push(String(params['passId']));
        return HttpResponse.json({ outcome: 'closing', pass: live.pass });
      }),
    );
    open('/workbench', { live: [live] });
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Finish', hidden: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Finish' });
    expect(await within(dialog).findByText('Lands 1 page on main.')).toBeTruthy();
    expect(asked).toEqual([live.pass.id]);
    expect(posted).toEqual([]);
  });

  it("keeps the open pass and a page's draft when a refetch of the live passes fails", async () => {
    const { ready, working } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [ready, working] });
    const { queryClient } = open(`/workbench?task=${ready.taskId}`, { live: [live] });
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message to Settings',
    });
    fireEvent.change(input, { target: { value: 'half a thought' } });
    server.use(
      http.get(daemonUrl('/passes'), () =>
        HttpResponse.json(
          { error: 'internal', message: 'The database is locked' },
          { status: 500 },
        ),
      ),
    );
    await act(() => queryClient.refetchQueries({ queryKey: ['passes', 'live'] }));
    await waitFor(() => {
      expect(queryClient.getQueryState(['passes', 'live'])?.status).toBe('error');
    });
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message to Settings' }).value,
    ).toBe('half a thought');
  });

  it('still pins the first page when the Inbox cannot be read', async () => {
    const { ready, working } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [working, ready] });
    const { router } = open(
      '/workbench',
      { live: [live] },
      {
        first: [
          http.get(daemonUrl('/inbox'), () =>
            HttpResponse.json({ error: 'internal', message: 'locked' }, { status: 500 }),
          ),
        ],
      },
    );
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: ready.taskId });
    });
  });

  it('pins the first page only once the Inbox has answered, which ranks a page that asks first', async () => {
    const { ready, asks } = pagesByStatus();
    const live = passViewDto({ pass: passDto({ projectId: project.id }), pages: [ready, asks] });
    const { router } = open(
      '/workbench',
      { live: [live] },
      {
        first: [
          http.get(daemonUrl('/inbox'), async () => {
            await delay(300);
            return HttpResponse.json([askItem(asks, { projectId: project.id })]);
          }),
        ],
      },
    );
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: asks.taskId });
    });
  });

  it.each([
    { read: 'the live passes', path: '/passes' },
    { read: 'what Start Pass says', path: '/projects/:projectId/pass-start' },
  ])('says so when $read cannot be read, rather than loading forever', async ({ path }) => {
    open(
      '/workbench',
      {},
      {
        first: [
          http.get(daemonUrl(path), () =>
            HttpResponse.json(
              { error: 'internal', message: 'The database is locked' },
              { status: 500 },
            ),
          ),
        ],
      },
    );
    expect(await screen.findByText(/The database is locked/)).toBeTruthy();
  });

  it('with no page area, is the setup, and Apply saves the rebuilt areas in one patch', async () => {
    let asked = 0;
    const patches: unknown[] = [];
    const bare = projectViewDto({ areas: [{ name: 'src', globs: ['src/**'] }] });
    server.use(
      http.post(daemonUrl('/projects/:projectId/workbench-setup'), () => {
        asked += 1;
        return HttpResponse.json(workbenchSetupDto());
      }),
      http.patch(daemonUrl('/projects/:projectId'), async ({ request }) => {
        patches.push(await request.json());
        return HttpResponse.json(projectDto());
      }),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([bare])),
      ...baseHandlers(),
    );
    renderApp('/workbench');
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(patches).toEqual([{ areas: workbenchSetupDto().areas.proposed }]);
    });
    expect(asked).toBe(1);
  });
});
