import {
  PickerProposalDto,
  type BatchState,
  type ProjectViewDto,
  type TaskDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../../test/daemon';
import {
  batchDto,
  candidate,
  flowDto,
  projectViewDto,
  taskDto,
  workstreamDto,
} from '../../../test/fixtures';

const local = projectViewDto({ maxLanes: 2, gateCommand: 'make gate', delivery: 'local' });
const one = taskDto({ projectId: local.id, title: 'One', boardStatus: 'ready', boardOrder: 1 });
const two = taskDto({ projectId: local.id, title: 'Two', boardStatus: 'ready', boardOrder: 2 });

const proposalOf = (project: ProjectViewDto, size: number, both = false) =>
  PickerProposalDto.parse({
    projectId: project.id,
    size,
    candidates: [
      candidate(one),
      candidate(
        two,
        both ? {} : { proposed: false, conflict: 'Area src is shared with One, picked before it' },
      ),
    ],
  });

interface Sent {
  readonly path: string;
  readonly body: unknown;
}

/** A daemon with `project` and its two ready tasks; `overrides` come first, so they win. */
function serve(
  project: ProjectViewDto,
  opts: { readonly sizes?: number[]; readonly both?: boolean; readonly tasks?: TaskDto[] } = {},
  ...overrides: RequestHandler[]
): Sent[] {
  const sent: Sent[] = [];
  server.use(
    ...overrides,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () =>
      HttpResponse.json(opts.tasks ?? [one, two]),
    ),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) => {
      const size = Number(new URL(request.url).searchParams.get('size'));
      opts.sizes?.push(size);
      return HttpResponse.json(proposalOf(project, size, opts.both ?? false));
    }),
    http.post(daemonUrl('/tasks/:taskId/start'), async ({ request, params }) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.text() });
      const taskId = String(params['taskId']) === one.id ? one.id : two.id;
      return HttpResponse.json(workstreamDto({ taskId, projectId: project.id }), { status: 201 });
    }),
    http.post(daemonUrl('/projects/:projectId/batches'), async ({ request }) => {
      sent.push({ path: new URL(request.url).pathname, body: await request.json() });
      return HttpResponse.json(
        [project.currentBatch ?? batchDto({ projectId: project.id, state: 'CUTTING' })],
        { status: 202 },
      );
    }),
    ...baseHandlers(),
  );
  return sent;
}

/** Opens a Select or MultiSelect and picks an option from the list it controls; each candidate has its own. */
async function pick(input: HTMLElement, option: string): Promise<void> {
  fireEvent.click(input);
  const listbox = await waitFor(() => {
    const id = input.getAttribute('aria-controls');
    const list = id === null ? null : document.getElementById(id);
    expect(list).not.toBeNull();
    return list ?? document.body;
  });
  fireEvent.click(within(listbox).getByRole('option', { name: option, hidden: true }));
}

async function openSheet() {
  renderApp('/board');
  fireEvent.click(await screen.findByRole('button', { name: 'More board actions' }));
  // The item is disabled until the tasks load, so wait for the count before clicking it.
  const item = await screen.findByRole('menuitem', { name: /\d+ ready/, hidden: true });
  fireEvent.click(item);
  return screen.findByRole('dialog', { name: 'Start a batch' });
}

const pr = (state: BatchState | null) =>
  projectViewDto({
    ...local,
    delivery: 'pull_request',
    prTitlePrefix: 'feat(app)',
    currentBatch:
      state === null ? null : batchDto({ projectId: local.id, title: 'Fix the login', state }),
  });

describe('BatchSheet', () => {
  it('in a local project, shows the proposal at the lane cap and starts each ticked task in order', async () => {
    const sizes: number[] = [];
    const sent = serve(local, { sizes });
    const sheet = await openSheet();
    expect(await within(sheet).findByRole('checkbox', { name: 'One' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(sheet).getByRole('checkbox', { name: 'Two' })).toHaveProperty('checked', false);
    expect(within(sheet).getByText('Area src is shared with One, picked before it')).toBeTruthy();
    expect(within(sheet).getByText('make gate')).toBeTruthy();
    expect(within(sheet).getByText(/The PM review isn’t built yet/)).toBeTruthy();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    expect(sizes[0]).toBe(2);

    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Two' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Start 2 tasks' }));
    await waitFor(() => {
      expect(sent.map((s) => s.path)).toEqual([`/tasks/${one.id}/start`, `/tasks/${two.id}/start`]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });

  it.each([
    { name: 'no batch yet', state: null },
    { name: 'a shipped batch', state: 'SHIPPED' },
  ] satisfies { name: string; state: BatchState | null }[])(
    'with $name, starts a new batch titled after the first ticked task',
    async ({ state }) => {
      const sent = serve(pr(state), { both: true });
      const sheet = await openSheet();
      const titleField = await within(sheet).findByLabelText('Batch title');
      expect(titleField).toHaveProperty('value', 'One');
      fireEvent.change(titleField, { target: { value: 'Greeting and readme' } });
      fireEvent.click(within(sheet).getByRole('button', { name: 'Start a batch of 2 tasks' }));
      await waitFor(() => {
        expect(sent).toEqual([
          {
            path: `/projects/${local.id}/batches`,
            body: { title: 'Greeting and readme', taskIds: [one.id, two.id] },
          },
        ]);
      });
      // The route answers at once; cutting finishes in the background and its refusals arrive as cards.
      await waitFor(() => {
        expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
      });
    },
  );

  it('says nothing is run for verification when the project has no gate command', async () => {
    serve(projectViewDto({ ...local, gateCommand: null }));
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText(
        'Verification: none. Each finished task waits for you to check it.',
      ),
    ).toBeTruthy();
    expect(within(sheet).queryByText(/10db runs/)).toBeNull();
  });

  it('starts tasks in worktrees with one request', async () => {
    const sent = serve(
      projectViewDto({
        ...pr(null),
        workspaceMode: 'worktree',
        currentBatch: batchDto({ projectId: local.id, title: 'Fix the login', state: 'SHIPPING' }),
      }),
      { both: true },
    );
    const sheet = await openSheet();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    fireEvent.click(
      await within(sheet).findByRole('button', { name: 'Start 2 tasks in worktrees' }),
    );
    await waitFor(() => {
      expect(sent).toEqual([
        {
          path: `/projects/${local.id}/batches`,
          body: { title: 'One', taskIds: [one.id, two.id] },
        },
      ]);
    });
  });

  it('refuses a new batch with no title', async () => {
    const sent = serve(pr(null));
    const sheet = await openSheet();
    fireEvent.change(await within(sheet).findByLabelText('Batch title'), {
      target: { value: ' ' },
    });
    expect(within(sheet).getByRole('button', { name: 'Start a batch of 1 task' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(sheet).getByText('Name the batch')).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('adds the ticked tasks to an open batch in one request', async () => {
    const sent = serve(pr('OPEN'), { both: true });
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText('These tasks join Fix the login, on its branch.'),
    ).toBeTruthy();
    expect(within(sheet).queryByLabelText('Batch title')).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add 2 tasks to Fix the login' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          path: `/projects/${local.id}/batches`,
          body: { title: 'Fix the login', taskIds: [one.id, two.id] },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Start a batch' })).toBeNull();
    });
  });

  it('says that starting reopens a failed batch as a fix, and sends the fix tasks to it', async () => {
    const sent = serve(pr('FAILED'));
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText(
        'Fix the login failed to ship. Starting these tasks reopens it as a fix.',
      ),
    ).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add 1 fix task to Fix the login' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          path: `/projects/${local.id}/batches`,
          body: { title: 'Fix the login', taskIds: [one.id] },
        },
      ]);
    });
  });

  it.each([
    {
      state: 'CUTTING',
      reason: 'Fix the login is still cutting its branch; start when it is open',
    },
    { state: 'SHIPPING', reason: 'Fix the login is shipping; start once it has shipped' },
  ] satisfies { state: BatchState; reason: string }[])(
    'disables Start while the batch is $state and says why',
    async ({ state, reason }) => {
      const sent = serve(pr(state));
      const sheet = await openSheet();
      expect(await within(sheet).findByText(reason)).toBeTruthy();
      expect(
        within(sheet).getByRole('button', { name: 'Add 1 task to Fix the login' }),
      ).toHaveProperty('disabled', true);
      expect(sent).toEqual([]);
    },
  );

  it("shows the daemon's message when the batch is refused, and stays open", async () => {
    serve(
      pr(null),
      {},
      http.post(daemonUrl('/projects/:projectId/batches'), () =>
        HttpResponse.json(
          {
            error: 'conflict',
            message:
              'Batch "Fix the login" is shipping; start again once it is open or has shipped',
          },
          { status: 409 },
        ),
      ),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Start a batch of 1 task' }));
    expect(
      await within(sheet).findByText(
        'Batch "Fix the login" is shipping; start again once it is open or has shipped',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Start a batch' })).toBeTruthy();
  });

  it('stops at the first refused start and says which started', async () => {
    const tried: string[] = [];
    serve(
      local,
      { both: true },
      http.post(daemonUrl('/tasks/:taskId/start'), ({ params }) => {
        tried.push(String(params['taskId']));
        return String(params['taskId']) === one.id
          ? HttpResponse.json(workstreamDto({ taskId: one.id }), { status: 201 })
          : HttpResponse.json(
              { error: 'conflict', message: 'Task Two is already running' },
              { status: 409 },
            );
      }),
    );
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Start 2 tasks' }));
    expect(
      await within(sheet).findByText(
        'Started 1 of 2; Two was refused: Task Two is already running',
      ),
    ).toBeTruthy();
    expect(tried).toEqual([one.id, two.id]);
  });

  it('shows each step’s persona, profile and why', async () => {
    serve(local);
    const sheet = await openSheet();
    const steps = await within(sheet).findByRole('table', { name: 'Steps for One' });
    const rows = within(steps)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    const why = 'cheapest profile at or above 40 coding';
    expect(rows).toEqual([
      ['Implementer', 'Implementer', 'sonnet@high', why],
      ['Reviewer', 'Reviewer', 'sonnet@high', why],
    ]);
  });

  it('refetches the proposal when the batch size changes', async () => {
    const sizes: number[] = [];
    serve(local, { sizes });
    const sheet = await openSheet();
    fireEvent.change(await within(sheet).findByLabelText('Batch size'), { target: { value: '1' } });
    await waitFor(() => {
      expect(sizes).toContain(1);
    });
  });

  it('disables Start and says why when nothing is ticked', async () => {
    const sent = serve(local);
    const sheet = await openSheet();
    fireEvent.click(await within(sheet).findByRole('checkbox', { name: 'One' }));
    expect(within(sheet).getByRole('button', { name: 'Start 0 tasks' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(sheet).getByText('Tick at least one task')).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it('shows why nothing can start when the picker proposes no task', async () => {
    serve(
      local,
      // Start Ready Tasks is only enabled with a task in Ready, so one is there though none is proposed.
      { tasks: [one] },
      http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) =>
        HttpResponse.json(
          PickerProposalDto.parse({
            projectId: local.id,
            size: Number(new URL(request.url).searchParams.get('size')),
            candidates: [],
          }),
        ),
      ),
    );
    const sheet = await openSheet();
    expect(
      await within(sheet).findByText(
        'No ready tasks. A task is ready when everything it depends on is done.',
      ),
    ).toBeTruthy();
  });

  it('changes a task’s flow from the sheet', async () => {
    const quick = flowDto({ name: 'quick' });
    const patched: unknown[] = [];
    serve(
      local,
      {},
      http.get(daemonUrl('/flows'), () => HttpResponse.json([quick])),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(one);
      }),
    );
    const sheet = await openSheet();
    await pick(await within(sheet).findByLabelText('Flow for One'), 'quick');
    await waitFor(() => {
      expect(patched).toEqual([{ flowId: quick.id }]);
    });
  });

  it('changes a task’s risk tags from the sheet', async () => {
    const patched: unknown[] = [];
    serve(
      local,
      {},
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push(await request.json());
        return HttpResponse.json(one);
      }),
    );
    const sheet = await openSheet();
    await pick(await within(sheet).findByLabelText('Risk tags for One'), 'auth');
    await waitFor(() => {
      expect(patched).toEqual([{ riskTags: ['auth'] }]);
    });
  });
});
