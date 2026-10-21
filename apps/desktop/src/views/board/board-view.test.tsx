import type { ProjectDto, TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { boardColumnDto, projectDto, taskDto, workstreamDto } from '../../test/fixtures';

/** The base daemon (health, head, empty lists, a silent event stream), then this test's overrides. */
function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
  );
  server.use(...overrides);
}

function type(label: string, value: string, scope: HTMLElement): void {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
}

describe('BoardView', () => {
  it('creates a project from the form, sending the parsed areas', async () => {
    let projects: ProjectDto[] = [];
    const posted: unknown[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json(projects)),
      http.post(daemonUrl('/projects'), async ({ request }) => {
        posted.push(await request.json());
        const project = projectDto({
          name: 'demo',
          areas: [
            { name: 'api', globs: ['src/api/**'] },
            { name: 'ui', globs: ['src/ui/**', 'src/shared/**'] },
          ],
        });
        projects = [project];
        return HttpResponse.json(project, { status: 201 });
      }),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');

    expect(await screen.findByText('No projects yet. Create one to start.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    type('Name', 'demo', dialog);
    type('Repository path', '/repos/demo', dialog);
    type('Gate command', 'make gate', dialog);
    type('Areas', 'api: src/api/**\nui: src/ui/**, src/shared/**', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).toEqual({
      name: 'demo',
      repoPath: '/repos/demo',
      gateCommand: 'make gate',
      areas: [
        { name: 'api', globs: ['src/api/**'] },
        { name: 'ui', globs: ['src/ui/**', 'src/shared/**'] },
      ],
      billingMode: 'subscription',
      handoffPct: 40,
      nudgePct: 50,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(await screen.findByText('No tasks yet.')).toBeTruthy();
  });

  it('shows an areas mistake without calling the daemon', async () => {
    let calls = 0;
    serve(
      http.post(daemonUrl('/projects'), () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    type('Areas', 'API: src/**', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(
      await within(dialog).findByText(
        'Line 1: "API" must use lowercase letters, digits and hyphens',
      ),
    ).toBeTruthy();
    expect(calls).toBe(0);
  });

  it("shows the daemon's message when it rejects the project", async () => {
    serve(
      http.post(daemonUrl('/projects'), () =>
        HttpResponse.json(
          { error: 'invalid', message: '/repos/demo is not a git repository' },
          { status: 400 },
        ),
      ),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    type('Name', 'demo', dialog);
    type('Repository path', '/repos/demo', dialog);
    type('Gate command', 'make gate', dialog);
    type('Areas', 'api: src/**', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await within(dialog).findByText('/repos/demo is not a git repository')).toBeTruthy();
  });

  it('shows which project already uses the repository when the daemon answers 409', async () => {
    serve(
      http.post(daemonUrl('/projects'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Project "demo" already uses /repos/demo' },
          { status: 409 },
        ),
      ),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    type('Name', 'demo again', dialog);
    type('Repository path', '/repos/demo', dialog);
    type('Gate command', 'make gate', dialog);
    type('Areas', 'api: src/**', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await within(dialog).findByText('Project "demo" already uses /repos/demo')).toBeTruthy();
    expect(within(dialog).getByText("Couldn't create the project")).toBeTruthy();
  });

  it('starts a ready task', async () => {
    const project = projectDto();
    const alpha = taskDto({
      projectId: project.id,
      title: 'Alpha',
      boardStatus: 'ready',
      workstreamId: null,
    });
    const started: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
      http.post(daemonUrl('/tasks/:taskId/start'), ({ params }) => {
        started.push(String(params['taskId']));
        return HttpResponse.json(
          workstreamDto({ taskId: alpha.id, projectId: project.id, taskTitle: 'Alpha' }),
          { status: 201 },
        );
      }),
    );
    renderApp('/board');

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    const card = within(ready).getByRole('listitem', { name: 'Alpha' });
    fireEvent.click(within(card).getByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start' }));
    await waitFor(() => {
      expect(started).toEqual([alpha.id]);
    });
  });

  it.each([
    ['RUNNING', 'Running', false],
    ['DONE', 'Done', false],
    ['FAILED', 'Failed', true],
    ['CANCELLED', 'Cancelled', true],
  ] as const)(
    'offers Start for a ready task whose latest workstream is %s only when it ended without finishing',
    async (state, label, startable) => {
      const project = projectDto();
      const ws = workstreamDto({ projectId: project.id, state, taskTitle: 'Busy' });
      const busy = taskDto({
        projectId: project.id,
        title: 'Busy',
        boardStatus: 'ready',
        workstreamId: ws.id,
      });
      serve(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
        http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([busy])),
        http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
      );
      renderApp('/board');

      const card = await screen.findByRole('listitem', { name: 'Busy' });
      if (label !== 'Done' && label !== 'Cancelled')
        expect(await within(card).findByText(label)).toBeTruthy();
      fireEvent.click(within(card).getByRole('button', { name: 'Actions for Busy' }));
      await screen.findByRole('menu', { hidden: true });
      // jsdom has no layout, so Mantine leaves an open menu display:none; query it as hidden.
      if (startable)
        expect(await screen.findByRole('menuitem', { name: 'Start', hidden: true })).toBeTruthy();
      else expect(screen.queryByRole('menuitem', { name: 'Start', hidden: true })).toBeNull();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    },
  );

  it("shows the daemon's message, not an empty list, when the projects query fails", async () => {
    serve(
      http.get(daemonUrl('/projects'), () =>
        HttpResponse.json({ error: 'internal', message: 'database is locked' }, { status: 500 }),
      ),
    );
    renderApp('/board');

    expect(await screen.findByText('database is locked')).toBeTruthy();
    expect(screen.queryByText('No projects yet. Create one to start.')).toBeNull();
  });

  it("shows the daemon's message when the tasks query fails", async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json({ error: 'internal', message: 'tasks unavailable' }, { status: 500 }),
      ),
    );
    renderApp('/board');

    expect(await screen.findByText('tasks unavailable')).toBeTruthy();
    expect(screen.queryByText('No tasks yet.')).toBeNull();
  });

  it("shows the daemon's message when the workstreams query fails", async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([taskDto({ projectId: project.id, title: 'Alpha' })]),
      ),
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json(
          { error: 'internal', message: 'workstreams unavailable' },
          { status: 500 },
        ),
      ),
    );
    renderApp('/board');

    expect(await screen.findByText('workstreams unavailable')).toBeTruthy();
  });

  it('falls back to the first project when the remembered id is not a project id', async () => {
    const first = projectDto({ name: 'first-project' });
    window.localStorage.setItem('tendb.project', JSON.stringify('garbage'));
    try {
      serve(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([first])),
        http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
      );
      renderApp('/board');

      expect(await screen.findByText('No tasks yet.')).toBeTruthy();
      expect(screen.getByDisplayValue('first-project')).toBeTruthy();
    } finally {
      window.localStorage.removeItem('tendb.project');
    }
  });

  it('blocks the project form when the handoff field is empty', async () => {
    let calls = 0;
    serve(
      http.post(daemonUrl('/projects'), () => {
        calls += 1;
        return HttpResponse.json({}, { status: 500 });
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    type('Name', 'demo', dialog);
    type('Repository path', '/repos/demo', dialog);
    type('Gate command', 'make gate', dialog);
    type('Areas', 'api: src/**', dialog);
    type('Handoff at %', '', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await within(dialog).findByText('Enter the handoff percentage')).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('creates a task with one criterion per line and the only area preselected', async () => {
    const project = projectDto({ areas: [{ name: 'api', globs: ['src/api/**'] }] });
    const posted: unknown[] = [];
    let tasks: TaskDto[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.post(daemonUrl('/projects/:projectId/tasks'), async ({ request }) => {
        posted.push(await request.json());
        const task = taskDto({ projectId: project.id, title: 'Beta' });
        tasks = [task];
        return HttpResponse.json(task, { status: 201 });
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    type('Title', 'Beta', dialog);
    type('Acceptance criteria', 'It works\n\nIt is tested\n', dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));

    await waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]).toEqual({
      title: 'Beta',
      description: '',
      acceptanceCriteria: ['It works', 'It is tested'],
      areas: ['api'],
      dependsOn: [],
    });
    expect(await screen.findByRole('listitem', { name: 'Beta' })).toBeTruthy();
  });

  it('shows human columns before the system columns, and each task where it belongs', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id, name: 'Icebox' });
    const ws = workstreamDto({ projectId: project.id, taskTitle: 'Base', state: 'RUNNING' });
    const running = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title: 'Base',
      boardStatus: 'in_progress',
      boardOrder: 1,
      workstreamId: ws.id,
    });
    const next = taskDto({
      projectId: project.id,
      title: 'Next',
      boardStatus: 'backlog',
      boardOrder: 2,
      areas: ['api', 'ui'],
      dependsOn: [running.id],
    });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardOrder: 3,
      boardColumnId: icebox.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([running, next, idea]),
      ),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');

    const lists = await screen.findAllByRole('list', { name: / tasks$/ });
    expect(lists.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Icebox tasks',
      'Backlog tasks',
      'Ready tasks',
      'In progress tasks',
      'Blocked tasks',
      'Done tasks',
    ]);
    const inProgress = screen.getByRole('list', { name: 'In progress tasks' });
    expect(
      await within(within(inProgress).getByRole('listitem', { name: 'Base' })).findByText(
        'Running',
      ),
    ).toBeTruthy();
    const nextCard = within(screen.getByRole('list', { name: 'Backlog tasks' })).getByRole(
      'listitem',
      { name: 'Next' },
    );
    expect(within(nextCard).getByText('api')).toBeTruthy();
    expect(within(nextCard).getByText('Waits on Base')).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Icebox tasks' })).getByRole('listitem', {
        name: 'Idea',
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Ready tasks' })).queryByRole('listitem', {
        name: 'Idea',
      }),
    ).toBeNull();
  });

  it('offers no Start on a parked card', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardColumnId: icebox.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([idea])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Idea' }));
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Start' })).toBeNull();
  });

  it('shows the 20 most recent done tasks and the rest on request', async () => {
    const project = projectDto();
    const done = Array.from({ length: 22 }, (_, i) =>
      taskDto({
        projectId: project.id,
        title: `Done ${String(i)}`,
        boardStatus: 'done',
        status: 'done',
        boardOrder: i,
        updatedAt: `2026-10-13T12:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(done)),
    );
    renderApp('/board');

    const column = await screen.findByRole('list', { name: 'Done tasks' });
    expect(within(column).getAllByRole('listitem')).toHaveLength(20);
    expect(within(column).queryByRole('listitem', { name: 'Done 0' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all 22' }));
    expect(within(column).getAllByRole('listitem')).toHaveLength(22);
  });

  it('redirects /tasks to the board', async () => {
    serve();
    const { router } = renderApp('/tasks');
    expect(await screen.findByRole('heading', { name: 'Board', level: 2 })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/board');
  });
});
