import type { ProjectDto, TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { projectDto, taskDto, workstreamDto } from '../../test/fixtures';

/** The base daemon (health, head, empty lists, a silent event stream), then this test's overrides. */
function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

function type(label: string, value: string, scope: HTMLElement): void {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
}

describe('TasksView', () => {
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
    renderApp('/tasks');

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
    renderApp('/tasks');

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
    renderApp('/tasks');

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
    renderApp('/tasks');

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
    renderApp('/tasks');

    const row = (await screen.findByText('Alpha')).closest('tr');
    if (!row) throw new Error('Alpha is not in a table row');
    expect(within(row).getByText('Ready')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Start' }));
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
      renderApp('/tasks');

      const row = (await screen.findByText('Busy')).closest('tr');
      if (!row) throw new Error('Busy is not in a table row');
      expect(await within(row).findByText(label)).toBeTruthy();
      expect(within(row).queryByRole('button', { name: 'Start' }) !== null).toBe(startable);
    },
  );

  it("shows the daemon's message, not an empty list, when the projects query fails", async () => {
    serve(
      http.get(daemonUrl('/projects'), () =>
        HttpResponse.json({ error: 'internal', message: 'database is locked' }, { status: 500 }),
      ),
    );
    renderApp('/tasks');

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
    renderApp('/tasks');

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
    renderApp('/tasks');

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
      renderApp('/tasks');

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
    renderApp('/tasks');

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
    renderApp('/tasks');

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
    expect(await screen.findByText('Beta')).toBeTruthy();
  });
});
