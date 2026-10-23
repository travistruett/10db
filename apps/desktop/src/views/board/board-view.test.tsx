import { TaskMove, type BoardColumnDto, type ProjectDto, type TaskDto } from '@10db/contracts';
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
    ['RUNNING', 'Running', 'in_progress', false],
    ['DONE', 'Done', 'ready', false],
    ['FAILED', 'Failed', 'blocked', false],
    ['CANCELLED', 'Cancelled', 'ready', true],
  ] as const)(
    'offers Start only when the latest workstream %s leaves the task Backlog or Ready and ended without finishing',
    async (state, label, boardStatus, startable) => {
      const project = projectDto();
      const ws = workstreamDto({ projectId: project.id, state, taskTitle: 'Busy' });
      const busy = taskDto({
        projectId: project.id,
        title: 'Busy',
        boardStatus,
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
    expect(screen.queryByRole('menuitem', { name: 'Start', hidden: true })).toBeNull();
  });

  it('never shows a parked card in a derived column while the columns are still loading', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardColumnId: icebox.id,
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), async () => {
        await gate;
        return HttpResponse.json([icebox]);
      }),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([idea])),
    );
    const { queryClient } = renderApp('/board');
    await screen.findByText(/gate: true/);
    // Wait for the tasks to be in the cache, then check the board still holds back.
    await waitFor(() => {
      expect(queryClient.getQueryState(['tasks', project.id])?.status).toBe('success');
    });
    expect(screen.queryByRole('listitem', { name: 'Idea' })).toBeNull();
    release();
    const parked = await screen.findByRole('list', { name: 'Icebox tasks' });
    expect(within(parked).getByRole('listitem', { name: 'Idea' })).toBeTruthy();
  });

  it('disables Start on a card that waits on a parked dependency, and says why', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardColumnId: icebox.id,
    });
    const next = taskDto({
      projectId: project.id,
      title: 'Next',
      boardStatus: 'backlog',
      dependsOn: [idea.id],
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([idea, next])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Next' }));
    const start = await screen.findByRole('menuitem', { name: /^Start/, hidden: true });
    expect(start.hasAttribute('data-disabled')).toBe(true);
    expect(start.textContent).toContain('Idea is parked');
  });

  it('disables parking a card that a started dependent waits on, and says why', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const base = taskDto({ projectId: project.id, title: 'Base', boardStatus: 'ready' });
    const ws = workstreamDto({ projectId: project.id, state: 'QUEUED', taskTitle: 'Next' });
    const next = taskDto({
      projectId: project.id,
      title: 'Next',
      boardStatus: 'in_progress',
      dependsOn: [base.id],
      workstreamId: ws.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([base, next])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');
    // The workstream arrives on its own query; wait until the card shows it.
    const card = await screen.findByRole('listitem', { name: 'Next' });
    expect(await within(card).findByText('Queued')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Base' }));
    const park = await screen.findByRole('menuitem', { name: /^Move to Icebox/, hidden: true });
    expect(park.hasAttribute('data-disabled')).toBe(true);
    expect(park.textContent).toContain('Next has started and waits on Base');
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

  /** A board whose daemon applies each move, as the real one does, so refetches agree with the UI. */
  function boardWith(
    initial: TaskDto[],
    columns: BoardColumnDto[],
    opts: { readonly refuse?: string } = {},
  ) {
    const project = projectDto();
    let current = initial;
    const moves: { taskId: unknown; body: TaskMove }[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json(columns)),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([...current].sort((a, b) => a.boardOrder - b.boardOrder)),
      ),
      http.post(daemonUrl('/tasks/:taskId/move'), async ({ request, params }) => {
        const body = TaskMove.parse(await request.json());
        moves.push({ taskId: params['taskId'], body });
        if (opts.refuse)
          return HttpResponse.json({ error: 'conflict', message: opts.refuse }, { status: 409 });
        const orderOf = (id: string | null) => current.find((t) => t.id === id)?.boardOrder;
        const before = orderOf(body.before);
        const after = orderOf(body.after);
        current = current.map((t) =>
          t.id === params['taskId']
            ? {
                ...t,
                boardColumnId: body.to,
                boardOrder:
                  before !== undefined
                    ? before - 0.5
                    : after !== undefined
                      ? after + 0.5
                      : t.boardOrder,
              }
            : t,
        );
        return HttpResponse.json(current.find((t) => t.id === params['taskId']));
      }),
    );
    renderApp('/board');
    return moves;
  }
  const titlesIn = (list: HTMLElement) =>
    within(list)
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('aria-label'));

  it('moves a card to the top from its menu, and disables moves that do nothing', async () => {
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const two = taskDto({ title: 'Two', boardStatus: 'ready', boardOrder: 2 });
    const moves = boardWith([one, two], []);

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for One' }));
    // Mantine marks a disabled Menu.Item with data-disabled. jsdom leaves an open menu display:none.
    expect(
      (await screen.findByRole('menuitem', { name: 'Move up', hidden: true })).hasAttribute(
        'data-disabled',
      ),
    ).toBe(true);
    expect(
      screen
        .getByRole('menuitem', { name: 'Move down', hidden: true })
        .hasAttribute('data-disabled'),
    ).toBe(false);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    // The closed menu unmounts after its transition; wait so the next lookup finds one menu.
    await waitFor(() => {
      expect(screen.queryAllByRole('menuitem', { hidden: true })).toHaveLength(0);
    });

    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top', hidden: true }));
    await waitFor(() => {
      expect(titlesIn(ready)).toEqual(['Two', 'One']);
    });
    expect(moves).toEqual([{ taskId: two.id, body: { to: null, after: null, before: one.id } }]);
  });

  it('parks and plans a card from its menu', async () => {
    const icebox = boardColumnDto({ name: 'Icebox' });
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const idea = taskDto({
      title: 'Idea',
      boardStatus: 'ready',
      boardOrder: 2,
      boardColumnId: icebox.id,
    });
    const moves = boardWith([one, idea], [icebox]);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for One' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Icebox', hidden: true }));
    const iceboxList = screen.getByRole('list', { name: 'Icebox tasks' });
    await waitFor(() => {
      expect(titlesIn(iceboxList)).toEqual(['One', 'Idea']);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Idea' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to Ready', hidden: true }));
    await waitFor(() => {
      expect(titlesIn(screen.getByRole('list', { name: 'Ready tasks' }))).toEqual(['Idea']);
    });
    expect(moves.map((m) => m.body)).toEqual([
      { to: icebox.id, after: null, before: idea.id },
      { to: null, after: null, before: null },
    ]);
  });

  it('rolls the placement back and says why when the daemon refuses a move', async () => {
    const one = taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 1 });
    const two = taskDto({ title: 'Two', boardStatus: 'ready', boardOrder: 2 });
    boardWith([one, two], [], { refuse: 'The board changed while you were dragging; try again' });

    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    fireEvent.click(within(ready).getByRole('button', { name: 'Actions for Two' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move to top', hidden: true }));
    expect(
      await screen.findByText('The board changed while you were dragging; try again'),
    ).toBeTruthy();
    expect(titlesIn(ready)).toEqual(['One', 'Two']);
  });

  it('explains why a running or done card can’t be dragged', async () => {
    const running = taskDto({ title: 'Running', boardStatus: 'in_progress' });
    const shipped = taskDto({ title: 'Shipped', boardStatus: 'done', status: 'done' });
    boardWith([running, shipped], []);

    const handle = await screen.findByRole('button', { name: 'Can’t drag Shipped' });
    // Focusable, so a keyboard user reaches the reason; aria-disabled keeps it from acting.
    expect(handle.getAttribute('aria-disabled')).toBe('true');
    expect(handle.hasAttribute('disabled')).toBe(false);
    const described = handle.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described ?? '')?.textContent).toBe(
      'Done cards stay where they finished; they can’t be dragged',
    );
    expect(screen.getByRole('button', { name: 'Can’t drag Running' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Drag Shipped' })).toBeNull();
  });
});
