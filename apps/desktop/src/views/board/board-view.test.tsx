import { TaskMove, type BoardColumnDto, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import {
  batchDto,
  boardColumnDto,
  inboxItemDto,
  projectDto,
  projectViewDto,
  stepDto,
  taskDto,
  workstreamDto,
} from '../../test/fixtures';

/** The base daemon (health, head, empty lists, a silent event stream), then this test's overrides. */
function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
  );
  server.use(...overrides);
}

function type(label: string | RegExp, value: string, scope: HTMLElement): void {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
}

describe('BoardView', () => {
  it('says a failed ship once, on the card, and retries it from the drawer', async () => {
    const batch = batchDto({
      state: 'FAILED',
      failure: 'gate_failed',
      gateExitCode: 2,
      gateLogPath: '/data/logs/gate/b.log',
    });
    const project = projectViewDto({
      id: batch.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      gateCommand: 'make gate',
      currentBatch: batch,
    });
    const ws = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Alpha',
      state: 'DONE',
    });
    const alpha = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title: 'Alpha',
      boardStatus: 'in_progress',
      workstreamId: ws.id,
    });
    const shipped: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
      http.post(daemonUrl('/batches/:batchId/ship'), ({ params }) => {
        shipped.push(String(params['batchId']));
        return HttpResponse.json({ ...batch, state: 'SHIPPING', failure: null });
      }),
    );
    renderApp('/board');

    expect(await screen.findByText('Not shipped: the gate failed')).toBeTruthy();
    // The failure is on the card alone: no strip, no NOT SHIPPED panel, no Retry until the drawer opens.
    expect(screen.queryByTestId('board-above-columns')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Batches (1)' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    expect(within(drawer).getByText('make gate exited with code 2')).toBeTruthy();
    expect(within(drawer).getByRole('link', { name: 'Gate log' })).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(shipped).toEqual([batch.id]);
    });
  });

  it('shows nothing above the columns for one running task', async () => {
    const batch = batchDto();
    const project = projectViewDto({
      id: batch.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      currentBatch: batch,
    });
    const ws = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Alpha',
      state: 'RUNNING',
      steps: [stepDto(), stepDto()],
    });
    const alpha = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title: 'Alpha',
      boardStatus: 'in_progress',
      workstreamId: ws.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');

    expect(await screen.findAllByText('Building · step 1 of 2')).toHaveLength(1);
    expect(screen.queryByTestId('board-above-columns')).toBeNull();
    expect(screen.queryByText(batch.branch ?? '')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Abandon' })).toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('OPEN')).toBeNull();
  });

  it('shows one line above the columns when several tasks share a branch', async () => {
    const batch = batchDto();
    const project = projectViewDto({
      id: batch.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      currentBatch: batch,
    });
    const wss = ['Alpha', 'Beta'].map((taskTitle) =>
      workstreamDto({ projectId: project.id, batchId: batch.id, taskTitle, state: 'QUEUED' }),
    );
    const tasks = wss.map((ws) =>
      taskDto({
        id: ws.taskId,
        projectId: project.id,
        title: ws.taskTitle,
        boardStatus: 'in_progress',
        workstreamId: ws.id,
      }),
    );
    const abandoned: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json(wss)),
      http.post(daemonUrl('/batches/:batchId/abandon'), ({ params }) => {
        abandoned.push(String(params['batchId']));
        return HttpResponse.json({ ...batch, state: 'ABANDONED' });
      }),
    );
    renderApp('/board');

    const above = await screen.findByTestId('board-above-columns');
    expect(within(above).getByText('10db/greetings-0a1b2c3d')).toBeTruthy();
    expect(within(above).getByText('2 tasks')).toBeTruthy();
    expect(within(above).queryByText('Alpha')).toBeNull();
    fireEvent.click(within(above).getByRole('button', { name: 'Abandon' }));
    await waitFor(() => {
      expect(abandoned).toEqual([batch.id]);
    });
  });

  it('shows no strip for open batches of one task each in worktree mode, and no batch history', async () => {
    const first = batchDto({ title: 'First', worktreePath: '/wt/first' });
    const batches = [first, 'Second', 'Third'].map((b) =>
      typeof b === 'string'
        ? batchDto({ projectId: first.projectId, title: b, worktreePath: `/wt/${b}` })
        : b,
    );
    const shipped = batchDto({ projectId: first.projectId, title: 'Done one', state: 'SHIPPED' });
    const project = projectViewDto({
      id: first.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      workspaceMode: 'worktree',
      currentBatch: first,
      openBatches: batches,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/batches'), () =>
        HttpResponse.json([...batches, shipped]),
      ),
    );
    renderApp('/board');

    const columns = await screen.findByTestId('board-columns');
    expect(columns.style.minHeight).toContain('20rem');
    expect(screen.queryByTestId('board-above-columns')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Batches/ })).toBeNull();
    expect(screen.queryByText('Done one')).toBeNull();
  });

  it.each([
    {
      name: 'shows the pull request of the batch that shipped it',
      batchState: 'SHIPPED' as const,
      prUrl: 'https://github.com/acme/widgets/pull/1',
      link: 'https://github.com/acme/widgets/pull/1',
    },
    {
      name: 'shows no pull request while its batch has not shipped',
      batchState: 'OPEN' as const,
      prUrl: null,
      link: null,
    },
  ])('a finished task $name', async ({ batchState, prUrl, link }) => {
    const batch = batchDto({ title: 'Alpha first', state: batchState, prUrl });
    const project = projectViewDto({
      id: batch.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      currentBatch: batch,
    });
    const ws = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Alpha',
      state: 'DONE',
    });
    const done = taskDto({
      projectId: project.id,
      title: 'Alpha',
      boardStatus: 'done',
      status: 'done',
      boardOrder: 1,
      workstreamId: ws.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([done])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
    );
    renderApp('/board');

    const card = within(await screen.findByRole('list', { name: 'Done tasks' })).getByRole(
      'listitem',
      { name: 'Alpha' },
    );
    const hrefs = within(card)
      .queryAllByRole('link', { name: 'Pull request' })
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(link === null ? [] : [link]);
  });

  describe('where a task lands', () => {
    /** One project with a ready task of each landing; `delivery` is the project's. */
    function serveLandings(delivery: 'pull_request' | 'local') {
      const project = projectViewDto({ delivery, prTitlePrefix: 'feat(app)', baseBranch: 'main' });
      const tasks = [
        taskDto({ projectId: project.id, title: 'Alpha', landing: { kind: 'base' } }),
        taskDto({
          projectId: project.id,
          title: 'Beta',
          landing: { kind: 'branch', branch: 'feature/x' },
        }),
        taskDto({ projectId: project.id, title: 'Gamma', landing: { kind: 'hold' } }),
      ];
      serve(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
        http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
        http.get(daemonUrl('/workstreams'), () => HttpResponse.json([])),
      );
    }

    it('says on each card where its work will land', async () => {
      serveLandings('pull_request');
      renderApp('/board');
      const lines = await screen.findAllByTestId('landing-line');
      expect(lines.map((l) => l.textContent)).toEqual([
        'Merges into main when checks pass',
        'Merges into feature/x when checks pass',
        'Held for your review: pull request against main',
      ]);
      // A screen reader hears it with the rest of the card.
      expect(
        screen.getByText(/criterion\. Merges into feature\/x when checks pass\./),
      ).toBeTruthy();
    });

    it('says nothing on a project that commits directly', async () => {
      serveLandings('local');
      renderApp('/board');
      await screen.findByRole('button', { name: 'Alpha' });
      expect(screen.queryByTestId('landing-line')).toBeNull();
    });

    it('lets the drawer change it, starting from the task', async () => {
      serveLandings('pull_request');
      renderApp('/board');
      fireEvent.click(await screen.findByRole('button', { name: 'Gamma' }));
      const drawer = await screen.findByRole('dialog', { name: 'Task' });
      expect(
        within(drawer).getByRole<HTMLInputElement>('radio', { name: 'Hold for my review' }).checked,
      ).toBe(true);
      expect(within(drawer).getByRole('radio', { name: 'Merge into main' })).toBeTruthy();
    });
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

  it('keeps each card’s Start beside the Start Ready Tasks item', async () => {
    const project = projectDto();
    const ready = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([ready])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Start' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More board actions' }));
    expect(
      await screen.findByRole('menuitem', { name: /Start Ready Tasks/, hidden: true }),
    ).toBeTruthy();
  });

  it('says on the card why the daemon rejected a start, not as a move', async () => {
    const project = projectDto();
    const alpha = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
      http.post(daemonUrl('/tasks/:taskId/start'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Task Alpha already has an active workstream' },
          { status: 409 },
        ),
      ),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start', hidden: true }));
    const card = within(await screen.findByRole('list', { name: 'Ready tasks' })).getByRole(
      'listitem',
      { name: 'Alpha' },
    );
    expect(
      await within(card).findByText('Not started: Task Alpha already has an active workstream'),
    ).toBeTruthy();
    expect(screen.queryByText("Couldn't move the task")).toBeNull();
    // Nothing for the builder to open: the daemon raised no card for a rejected request.
    expect(within(card).queryByRole('link', { name: 'Open in Inbox' })).toBeNull();
  });

  describe('a start the daemon accepts and then refuses', () => {
    const project = projectDto();
    const alpha = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    const refusal = inboxItemDto({
      projectId: project.id,
      kind: 'flag',
      title: 'Batch not started: the checkout has uncommitted changes',
      options: [],
      detail: { taskIds: [alpha.id] },
    });

    function serveStart(
      open: () => boolean,
      onStart: () => Promise<void> = () => Promise.resolve(),
    ) {
      const posts: string[] = [];
      serve(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
        http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([alpha])),
        http.get(daemonUrl('/inbox'), () => HttpResponse.json(open() ? [refusal] : [])),
        http.post(daemonUrl('/tasks/:taskId/start'), async ({ params }) => {
          posts.push(String(params['taskId']));
          await onStart();
          return HttpResponse.json(batchDto({ projectId: project.id, state: 'CUTTING' }), {
            status: 202,
          });
        }),
      );
      return posts;
    }

    async function readyCard(): Promise<HTMLElement> {
      return within(await screen.findByRole('list', { name: 'Ready tasks' })).getByRole(
        'listitem',
        { name: 'Alpha' },
      );
    }

    async function clickStart(card: HTMLElement, name: string | RegExp = 'Start'): Promise<void> {
      fireEvent.click(within(card).getByRole('button', { name: 'Actions for Alpha' }));
      fireEvent.click(await screen.findByRole('menuitem', { name, hidden: true }));
    }

    it('shows the reason on the card, with a link to the Inbox', async () => {
      let refused = false;
      const posts = serveStart(() => refused);
      renderApp('/board');
      const card = await readyCard();

      refused = true;
      await clickStart(card);

      expect(await within(card).findByText(refusal.title)).toBeTruthy();
      expect(within(card).getByRole('link', { name: 'Open in Inbox' }).getAttribute('href')).toBe(
        '/inbox',
      );
      expect(within(card).queryByText('Starting…')).toBeNull();
      expect(posts).toEqual([alpha.id]);
    });

    it('says Starting while the request is out, and Start can not be pressed again', async () => {
      let release: () => void = () => undefined;
      const answered = new Promise<void>((resolve) => {
        release = resolve;
      });
      const posts = serveStart(
        () => false,
        () => answered,
      );
      renderApp('/board');
      const card = await readyCard();

      await clickStart(card);
      expect(await within(card).findByText('Starting…')).toBeTruthy();

      fireEvent.click(within(card).getByRole('button', { name: 'Actions for Alpha' }));
      const again = await screen.findByRole('menuitem', { name: /Starting/, hidden: true });
      expect(again.getAttribute('data-disabled')).toBe('true');
      fireEvent.click(again);
      release();
      await waitFor(() => {
        expect(posts).toEqual([alpha.id]);
      });
    });

    it('shows a refusal that was already open when the board loaded', async () => {
      serveStart(() => true);
      renderApp('/board');
      const card = await readyCard();
      expect(await within(card).findByText(refusal.title)).toBeTruthy();
    });
  });

  it.each([
    ['RUNNING', 'Building', 'in_progress', false],
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

      expect(
        await screen.findByRole('button', { name: 'Project: first-project. Switch project' }),
      ).toBeTruthy();
    } finally {
      window.localStorage.removeItem('tendb.project');
    }
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

    fireEvent.click(await screen.findByRole('button', { name: 'New Task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Task' });
    type('Title', 'Beta', dialog);
    type('Acceptance criteria', 'It works\n\nIt is tested\n', dialog);
    const create = within(dialog).getByRole('button', { name: 'Create Task' });
    // The button is in the modal's footer, outside the form, and submits it by id.
    expect(create.closest('form')).toBeNull();
    expect(create.getAttribute('form')).toBe(dialog.querySelector('form')?.id);
    fireEvent.click(create);

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
        'Building',
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
    await screen.findByRole('button', { name: `Project: ${project.name}. Switch project` });
    // Wait for the tasks to be in the cache, then check the board still holds back.
    await waitFor(() => {
      expect(queryClient.getQueryState(['tasks', project.id])?.status).toBe('success');
    });
    expect(screen.queryByRole('listitem', { name: 'Idea' })).toBeNull();
    release();
    const parked = await screen.findByRole('list', { name: 'Icebox tasks' });
    expect(within(parked).getByRole('listitem', { name: 'Idea' })).toBeTruthy();
  });

  it('still shows planned and running cards when the columns query fails, and keeps parked ones out of derived columns', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const alpha = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    const busy = taskDto({ projectId: project.id, title: 'Busy', boardStatus: 'in_progress' });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardColumnId: icebox.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () =>
        HttpResponse.json({ error: 'internal', message: 'columns unavailable' }, { status: 500 }),
      ),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json([alpha, busy, idea]),
      ),
    );
    renderApp('/board');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/columns unavailable/)).toBeTruthy();
    expect(within(alert).getByText(/Parked tasks are hidden/)).toBeTruthy();
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    expect(within(ready).getByRole('listitem', { name: 'Alpha' })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'In progress tasks' })).getByRole('listitem', {
        name: 'Busy',
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'Idea' })).toBeNull();
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

  it('an empty column shows its hint and a dashed border', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    expect(screen.getAllByText('Next up. Start Ready Tasks picks from here.')).toHaveLength(1);
    const paper = ready.closest('.mantine-Paper-root');
    expect(paper?.getAttribute('style')).toContain('dashed');
  });

  it('a column with a card hides its hint and has a solid border', async () => {
    const project = projectDto();
    const task = taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
    );
    renderApp('/board');
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    expect(await within(ready).findByRole('listitem', { name: 'Alpha' })).toBeTruthy();
    expect(screen.queryByText('Next up. Start Ready Tasks picks from here.')).toBeNull();
    const style = ready.closest('.mantine-Paper-root')?.getAttribute('style');
    expect(style).toContain('solid');
    expect(style).not.toContain('dashed');
  });

  it.each([
    [1, '1 task'],
    [2, '2 tasks'],
  ])('reads a count of %i as "%s" to assistive tech', async (n, spoken) => {
    const project = projectDto();
    const tasks = Array.from({ length: n }, (_, i) =>
      taskDto({ projectId: project.id, title: `T${String(i)}`, boardStatus: 'ready' }),
    );
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    );
    renderApp('/board');
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    const paper = ready.closest<HTMLElement>('.mantine-Paper-root');
    if (!paper) throw new Error('Ready has no column');
    const number = within(paper).getByText(String(n), { selector: 'p' });
    expect(number.textContent).toBe(spoken);
    expect(number.hasAttribute('aria-label')).toBe(false);
  });

  it('scrolls the cards in their own region and keeps Show all outside it', async () => {
    const project = projectDto();
    const done = Array.from({ length: 22 }, (_, i) =>
      taskDto({
        projectId: project.id,
        title: `Done ${String(i)}`,
        boardStatus: 'done',
        status: 'done',
        boardOrder: i,
      }),
    );
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(done)),
    );
    renderApp('/board');
    const list = await screen.findByRole('list', { name: 'Done tasks' });
    const cardsViewport = list.closest('[data-scrollbars="y"]');
    expect(cardsViewport).not.toBeNull();
    const more = screen.getByRole('button', { name: 'Show all 22' });
    expect(cardsViewport?.contains(more)).toBe(false);
  });

  it('Ready ends in Add Task, which opens New Task', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    const ready = await screen.findByRole('list', { name: 'Ready tasks' });
    const paper = ready.closest<HTMLElement>('.mantine-Paper-root');
    if (!paper) throw new Error('Ready has no column');
    const add = within(paper).getByRole('button', { name: 'Add Task' });
    expect(screen.getAllByRole('button', { name: 'Add Task' })).toHaveLength(1);
    fireEvent.click(add);
    expect(await screen.findByRole('dialog', { name: 'New Task' })).toBeTruthy();
  });

  it('shows no lock icon on system columns', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    await screen.findByRole('list', { name: 'Ready tasks' });
    expect(screen.queryByText("Follows the task's state")).toBeNull();
  });

  it('shows no "No tasks yet" line', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    expect(await screen.findByRole('button', { name: 'New Task' })).toBeTruthy();
    expect(screen.queryByText('No tasks yet.')).toBeNull();
  });

  it('disables Start Ready Tasks with "Nothing in Ready" when Ready is empty', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'More board actions' }));
    const item = await screen.findByRole('menuitem', { name: /Start Ready Tasks/, hidden: true });
    expect(item.hasAttribute('disabled') || item.getAttribute('data-disabled') === 'true').toBe(
      true,
    );
    expect(within(item).getByText('Nothing in Ready')).toBeTruthy();
  });

  it('shows "2 ready" on Start Ready Tasks and opens the batch sheet', async () => {
    const project = projectDto();
    const tasks = [
      taskDto({ projectId: project.id, title: 'Alpha', boardStatus: 'ready' }),
      taskDto({ projectId: project.id, title: 'Beta', boardStatus: 'ready' }),
    ];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    );
    renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'More board actions' }));
    const item = await screen.findByRole('menuitem', { name: /Start Ready Tasks/, hidden: true });
    expect(await within(item).findByText('2 ready')).toBeTruthy();
    fireEvent.click(item);
    expect(await screen.findByRole('dialog', { name: 'Start a batch' })).toBeTruthy();
  });

  it('opens Settings at Board columns from Add Column', async () => {
    const project = projectDto();
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    const { router } = renderApp('/board');
    fireEvent.click(await screen.findByRole('button', { name: 'More board actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Add Column/, hidden: true }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/board-columns');
    });
  });

  it('has no page title or metadata line', async () => {
    const project = projectDto({ gateCommand: 'make gate-marker' });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([])),
    );
    renderApp('/board');
    expect(await screen.findByRole('button', { name: 'New Task' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Board' })).toBeNull();
    expect(screen.queryByText(/make gate-marker/)).toBeNull();
  });

  it('redirects /tasks to the board', async () => {
    serve();
    const { router } = renderApp('/tasks');
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/board');
    });
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

  it('a locked card names why on focus', async () => {
    const running = taskDto({ title: 'Running', boardStatus: 'in_progress' });
    const shipped = taskDto({ title: 'Shipped', boardStatus: 'done', status: 'done' });
    boardWith([running, shipped], []);

    const card = await screen.findByRole('button', { name: 'Running' });
    const reasonOf = (button: HTMLElement): string | undefined =>
      document.getElementById(button.getAttribute('aria-describedby')?.split(' ').at(-1) ?? '')
        ?.textContent;
    expect(reasonOf(card)).toBe('In progress cards follow their workstream; they can’t be dragged');
    const done = screen.getByRole('button', { name: 'Shipped' });
    expect(reasonOf(done)).toBe('Done cards stay where they finished; they can’t be dragged');
  });

  it('has no drag handle', async () => {
    boardWith([taskDto({ title: 'One', boardStatus: 'ready' })], []);
    await screen.findByRole('button', { name: 'One' });
    expect(screen.queryByRole('button', { name: 'Drag One' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Can’t drag One' })).toBeNull();
  });

  it('clicking a card opens its details', async () => {
    boardWith([taskDto({ title: 'One', boardStatus: 'ready' })], []);
    fireEvent.click(await screen.findByRole('button', { name: 'One' }));
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    expect(within(drawer).getByLabelText<HTMLInputElement>('Title').value).toBe('One');
  });

  it('Enter on a focused card opens its details', async () => {
    boardWith([taskDto({ title: 'One', boardStatus: 'ready' })], []);
    fireEvent.keyDown(await screen.findByRole('button', { name: 'One' }), { key: 'Enter' });
    expect(await screen.findByRole('dialog', { name: 'Task' })).toBeTruthy();
  });

  it('Enter or Space on the card menu does not open the card', async () => {
    boardWith([taskDto({ title: 'One', boardStatus: 'ready' })], []);
    const menu = await screen.findByRole('button', { name: 'Actions for One' });
    for (const key of ['Enter', ' ']) fireEvent.keyDown(menu, { key });
    fireEvent.click(menu);
    expect(await screen.findByRole('menu')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Task' })).toBeNull();
  });

  describe('a shipped card with a pull request', () => {
    const url = 'https://github.com/acme/widgets/pull/1';
    function shippedCard(): void {
      const batch = batchDto({ title: 'Alpha first', state: 'SHIPPED', prUrl: url });
      const project = projectViewDto({
        id: batch.projectId,
        delivery: 'pull_request',
        prTitlePrefix: 'feat(app)',
        currentBatch: batch,
      });
      const ws = workstreamDto({
        projectId: project.id,
        batchId: batch.id,
        taskTitle: 'Alpha',
        state: 'DONE',
      });
      const done = taskDto({
        projectId: project.id,
        title: 'Alpha',
        boardStatus: 'done',
        status: 'done',
        boardOrder: 1,
        workstreamId: ws.id,
      });
      serve(
        http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
        http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([done])),
        http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
        http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      );
      renderApp('/board');
    }

    it('keeps the link out of the card button', async () => {
      shippedCard();
      const card = await screen.findByRole('button', { name: 'Alpha' });
      const done = screen.getByRole('list', { name: 'Done tasks' });
      const link = within(done).getByRole('link', { name: 'Pull request' });
      expect(card.contains(link)).toBe(false);
      expect(link.getAttribute('href')).toBe(url);
    });

    it('opens no details when the link is clicked', async () => {
      shippedCard();
      await screen.findByRole('button', { name: 'Alpha' });
      const done = screen.getByRole('list', { name: 'Done tasks' });
      fireEvent.click(within(done).getByRole('link', { name: 'Pull request' }));
      expect(screen.queryByRole('dialog', { name: 'Task' })).toBeNull();
    });
  });

  it('describes a card by what it shows and, when locked, why it cannot move', async () => {
    const dep = taskDto({ title: 'Base', boardStatus: 'ready', boardOrder: 1 });
    const task = taskDto({
      title: 'Wired',
      boardStatus: 'ready',
      boardOrder: 2,
      areas: ['api', 'ui'],
      acceptanceCriteria: ['one', 'two'],
      dependsOn: [dep.id],
    });
    const running = taskDto({ title: 'Running', boardStatus: 'in_progress' });
    boardWith([dep, task, running], []);

    const describedBy = (name: string): string =>
      (screen.getByRole('button', { name }).getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' | ');
    await screen.findByRole('button', { name: 'Wired' });
    expect(describedBy('Wired')).toBe('Areas: api, ui. 2 criteria. Waits on Base.');
    expect(describedBy('Running')).toBe(
      'Areas: src. 1 criterion. | In progress cards follow their workstream; they can’t be dragged',
    );
  });

  it('the card menu retries a failed task and abandons its batch', async () => {
    const batch = batchDto();
    const project = projectViewDto({
      id: batch.projectId,
      delivery: 'pull_request',
      prTitlePrefix: 'feat(app)',
      currentBatch: batch,
    });
    const failed = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Broken',
      state: 'FAILED',
    });
    const fine = workstreamDto({
      projectId: project.id,
      batchId: null,
      taskTitle: 'Fine',
      state: 'DONE',
    });
    const tasks = [failed, fine].map((ws) =>
      taskDto({
        id: ws.taskId,
        projectId: project.id,
        title: ws.taskTitle,
        boardStatus: 'blocked',
        workstreamId: ws.id,
      }),
    );
    const retried: string[] = [];
    const abandoned: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([failed, fine])),
      http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
        retried.push(String(params['id']));
        return HttpResponse.json({ ...failed, state: 'QUEUED' });
      }),
      http.post(daemonUrl('/batches/:batchId/abandon'), ({ params }) => {
        abandoned.push(String(params['batchId']));
        return HttpResponse.json({ ...batch, state: 'ABANDONED' });
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Fine' }));
    await screen.findByRole('menu', { hidden: true });
    expect(screen.queryByRole('menuitem', { name: 'Retry', hidden: true })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Abandon', hidden: true })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Broken' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry', hidden: true }));
    await waitFor(() => {
      expect(retried).toEqual([failed.id]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Broken' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Abandon', hidden: true }));
    await waitFor(() => {
      expect(abandoned).toEqual([batch.id]);
    });
  });

  it('the card menu closes a failed task with a line on its branch, and a refusal names the blockers', async () => {
    const batch = batchDto();
    const project = projectViewDto({ id: batch.projectId, currentBatch: batch });
    const failed = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Broken',
      state: 'FAILED',
    });
    const fine = workstreamDto({ projectId: project.id, taskTitle: 'Fine', state: 'DONE' });
    const tasks = [failed, fine].map((ws) =>
      taskDto({
        id: ws.taskId,
        projectId: project.id,
        title: ws.taskTitle,
        boardStatus: ws === failed ? 'blocked' : 'done',
        workstreamId: ws.id,
      }),
    );
    const closed: string[] = [];
    let refuse = true;
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([failed, fine])),
      http.post(daemonUrl('/tasks/:taskId/close'), ({ params }) => {
        closed.push(String(params['taskId']));
        return refuse
          ? HttpResponse.json(
              { error: 'conflict', message: "Task Broken can't be closed while Child waits on it" },
              { status: 409 },
            )
          : HttpResponse.json({ ...tasks[0], status: 'cancelled' });
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Fine' }));
    await screen.findByRole('menu', { hidden: true });
    expect(screen.queryByRole('menuitem', { name: 'Close', hidden: true })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Broken' }));
    expect(
      await screen.findByText('Close keeps the branch 10db/greetings-0a1b2c3d as it is.'),
    ).toBeTruthy();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close', hidden: true }));
    expect(await screen.findByText("Couldn't close the task")).toBeTruthy();
    expect(screen.getByText("Task Broken can't be closed while Child waits on it")).toBeTruthy();

    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Broken' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Close', hidden: true }));
    await waitFor(() => {
      expect(closed).toEqual([failed.taskId, failed.taskId]);
    });
    await waitFor(() => {
      expect(screen.queryByText("Couldn't close the task")).toBeNull();
    });
  });

  it('the card menu holds Abandon back while the task is running', async () => {
    const batch = batchDto();
    const project = projectViewDto({ id: batch.projectId, currentBatch: batch });
    const ws = workstreamDto({
      projectId: project.id,
      batchId: batch.id,
      taskTitle: 'Busy',
      state: 'RUNNING',
    });
    const task = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title: 'Busy',
      boardStatus: 'in_progress',
      workstreamId: ws.id,
    });
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Busy' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Abandon (Busy is running: cancel it in Factory first)',
      hidden: true,
    });
    expect(item.hasAttribute('data-disabled')).toBe(true);
  });

  it('the card menu opens with its items', async () => {
    const project = projectDto();
    const icebox = boardColumnDto({ projectId: project.id });
    const ready = taskDto({ projectId: project.id, title: 'Go', boardStatus: 'ready' });
    const idea = taskDto({
      projectId: project.id,
      title: 'Idea',
      boardStatus: 'ready',
      boardColumnId: icebox.id,
    });
    const started: unknown[] = [];
    const moved: unknown[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([icebox])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([ready, idea])),
      http.post(daemonUrl('/tasks/:taskId/start'), ({ params }) => {
        started.push(params['taskId']);
        return HttpResponse.json(ready);
      }),
      http.post(daemonUrl('/tasks/:taskId/move'), ({ params }) => {
        moved.push(params['taskId']);
        return HttpResponse.json(idea);
      }),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Go' }));
    expect(await screen.findByRole('menuitem', { name: 'Start', hidden: true })).toBeTruthy();
    expect((await screen.findAllByRole('menuitem', { hidden: true })).length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Start', hidden: true }));
    await waitFor(() => {
      expect(started).toEqual([ready.id]);
    });
    expect(screen.queryByRole('dialog', { name: 'Task' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Idea' }));
    const move = await screen.findByRole('menuitem', { name: 'Move to Ready', hidden: true });
    fireEvent.click(move);
    await waitFor(() => {
      expect(moved).toEqual([idea.id]);
    });
    expect(screen.queryByRole('dialog', { name: 'Task' })).toBeNull();
  });

  it('the card shows areas as labels and the criteria count', async () => {
    boardWith(
      [
        taskDto({
          title: 'Two',
          boardStatus: 'ready',
          areas: ['api', 'ui'],
          acceptanceCriteria: ['a', 'b'],
        }),
        taskDto({ title: 'One', boardStatus: 'ready', boardOrder: 9, acceptanceCriteria: ['a'] }),
      ],
      [],
    );
    const two = await screen.findByRole('button', { name: 'Two' });
    expect(within(two).getByText('2 criteria')).toBeTruthy();
    expect(within(two).getByText('api')).toBeTruthy();
    expect(within(two).getByText('ui')).toBeTruthy();
    expect(
      within(screen.getByRole('button', { name: 'One' })).getByText('1 criterion'),
    ).toBeTruthy();
  });
});

describe('BoardView holding a started task', () => {
  const fresh = { sessionCount: 0, attempt: 0, recoveryAttempts: 0 } as const;

  /** One task with a run in `state`, served with the Hold, Start and Remove routes recording their calls. */
  function serveRun(
    state: 'QUEUED' | 'HELD' | 'RUNNING',
    title = 'Alpha',
    over: Partial<Parameters<typeof workstreamDto>[0]> = {},
  ) {
    const project = projectViewDto();
    const ws = workstreamDto({ projectId: project.id, taskTitle: title, state, ...fresh, ...over });
    const task = taskDto({
      id: ws.taskId,
      projectId: project.id,
      title,
      boardStatus: state === 'HELD' ? 'blocked' : 'in_progress',
      workstreamId: ws.id,
    });
    const calls: string[] = [];
    serve(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
      http.get(daemonUrl('/workstreams'), () => HttpResponse.json([ws])),
      http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
      http.post(daemonUrl('/tasks/:taskId/hold'), ({ params }) => {
        calls.push(`hold ${String(params['taskId'])}`);
        return HttpResponse.json({ ...ws, state: 'HELD' });
      }),
      http.post(daemonUrl('/tasks/:taskId/start'), ({ params }) => {
        calls.push(`start ${String(params['taskId'])}`);
        return HttpResponse.json({ ...ws, state: 'QUEUED' }, { status: 201 });
      }),
      http.post(daemonUrl('/tasks/:taskId/remove'), ({ params }) => {
        calls.push(`remove ${String(params['taskId'])}`);
        return HttpResponse.json({ ...task, status: 'cancelled' });
      }),
    );
    return { task, ws, calls };
  }

  it('holds a queued task from its card menu', async () => {
    const { task, calls } = serveRun('QUEUED');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hold', hidden: true }));
    await waitFor(() => {
      expect(calls).toEqual([`hold ${task.id}`]);
    });
  });

  it('holds back Hold on a task that is running, and says why', async () => {
    const { calls } = serveRun('RUNNING', 'Busy');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Busy' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Hold (Busy is running: cancel it in Factory first)',
      hidden: true,
    });
    expect(item.hasAttribute('data-disabled')).toBe(true);
    fireEvent.click(item);
    expect(calls).toEqual([]);
  });

  it('holds back Hold on a queued task that already ran, and says why', async () => {
    serveRun('QUEUED', 'Again', { sessionCount: 1 });
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Again' }));
    const item = await screen.findByRole('menuitem', {
      name: 'Hold (Again has already run: cancel it in Factory first)',
      hidden: true,
    });
    expect(item.hasAttribute('data-disabled')).toBe(true);
  });

  it('shows a held task as held, with Start and Remove in its menu and no Hold', async () => {
    const { task, calls } = serveRun('HELD');
    renderApp('/board');

    const blocked = await screen.findByRole('list', { name: 'Blocked tasks' });
    expect(within(blocked).getByText('Held: not in the queue')).toBeTruthy();
    fireEvent.click(within(blocked).getByRole('button', { name: 'Actions for Alpha' }));
    expect(await screen.findByRole('menuitem', { name: 'Remove', hidden: true })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /^Hold/, hidden: true })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Start', hidden: true }));
    await waitFor(() => {
      expect(calls).toEqual([`start ${task.id}`]);
    });
  });

  it('removes a held task from its card menu', async () => {
    const { task, calls } = serveRun('HELD');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove', hidden: true }));
    await waitFor(() => {
      expect(calls).toEqual([`remove ${task.id}`]);
    });
  });

  it('shows the daemon’s refusal when a hold is refused', async () => {
    serveRun('QUEUED');
    server.use(
      http.post(daemonUrl('/tasks/:taskId/hold'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Alpha is running: cancel it in Factory instead' },
          { status: 409 },
        ),
      ),
    );
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Alpha' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Hold', hidden: true }));
    expect(await screen.findByText("Couldn't hold the task")).toBeTruthy();
    expect(screen.getByText('Alpha is running: cancel it in Factory instead')).toBeTruthy();
  });

  it('offers Hold in the drawer of a queued task', async () => {
    const { task, calls } = serveRun('QUEUED');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hold' }));
    await waitFor(() => {
      expect(calls).toEqual([`hold ${task.id}`]);
    });
  });

  it('explains in the drawer why a running task can’t be held', async () => {
    serveRun('RUNNING', 'Busy');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Busy' }));
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    const hold = within(drawer).getByRole('button', { name: 'Hold' });
    expect(hold.hasAttribute('disabled')).toBe(true);
    expect(within(drawer).getByText('Busy is running: cancel it in Factory first.')).toBeTruthy();
  });

  it('starts and removes a held task from the drawer', async () => {
    const { task, calls } = serveRun('HELD');
    renderApp('/board');

    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }));
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    expect(within(drawer).getByText(/keeps its worktree/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(calls).toEqual([`start ${task.id}`]);
    });
    // Both buttons wait while a request is out.
    await waitFor(() => {
      expect(within(drawer).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(
        false,
      );
    });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Remove' }));
    await waitFor(() => {
      expect(calls).toEqual([`start ${task.id}`, `remove ${task.id}`]);
    });
  });
});
