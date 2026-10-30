import { mintId, RiskTag, type TaskPatch } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, flowDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import { RISK_LABEL } from './risk-labels';
import { TaskDrawer } from './task-drawer';

const peers = new Map();

function serve(...overrides: Parameters<typeof server.use>) {
  server.use(
    ...overrides,
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
}

interface Opts {
  /** The base branch of a project that delivers by pull request. */
  readonly pullRequestBase?: string;
  readonly task?: Parameters<typeof taskDto>[0];
  readonly workstream?: ReturnType<typeof workstreamDto>;
  readonly batch?: ReturnType<typeof batchDto>;
  readonly gateCommand?: string;
  readonly workstreams?: ReturnType<typeof workstreamDto>[];
  readonly place?: number;
}

function open(opts: Opts = {}): { closed: () => number } {
  let closes = 0;
  renderWithDaemon(
    <TaskDrawer
      task={taskDto(opts.task)}
      columnName="Ready"
      peers={peers}
      {...(opts.workstream ? { workstream: opts.workstream } : {})}
      {...(opts.batch ? { batch: opts.batch } : {})}
      {...(opts.gateCommand ? { gateCommand: opts.gateCommand } : {})}
      {...(opts.workstreams ? { workstreams: opts.workstreams } : {})}
      {...(opts.place ? { place: opts.place } : {})}
      {...(opts.pullRequestBase ? { pullRequestBase: opts.pullRequestBase } : {})}
      onClose={() => {
        closes += 1;
      }}
    />,
  );
  return { closed: () => closes };
}

async function dialog(): Promise<HTMLElement> {
  return screen.findByRole('dialog', { name: 'Task' });
}

async function edit(label: string, value: string): Promise<void> {
  fireEvent.change(within(await dialog()).getByLabelText(label), { target: { value } });
}

function discardPrompt(): HTMLElement | null {
  return screen.queryByText('Discard your changes to this task?');
}

describe('TaskDrawer', () => {
  it('shows the title, column, areas and waits-on', async () => {
    const other = taskDto({ title: 'Set up the repo' });
    const map = new Map([[other.id, { title: other.title }]]);
    serve();
    renderWithDaemon(
      <TaskDrawer
        task={taskDto({ title: 'Ship it', areas: ['api', 'ui'], dependsOn: [other.id] })}
        columnName="Ready"
        peers={map}
        onClose={() => undefined}
      />,
    );
    const d = await dialog();
    expect(within(d).getByLabelText<HTMLInputElement>('Title').value).toBe('Ship it');
    expect(within(d).getByText('Ready')).toBeTruthy();
    expect(within(d).getByText('api')).toBeTruthy();
    expect(within(d).getByText('ui')).toBeTruthy();
    expect(within(d).getByText('Waits on Set up the repo')).toBeTruthy();
  });

  it('saves the five fields', async () => {
    const flow = flowDto({ name: 'quick' });
    const patched: TaskPatch[] = [];
    const task = taskDto();
    server.use(
      http.get(daemonUrl('/flows'), () => HttpResponse.json([flow])),
      http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
        patched.push((await request.json()) as TaskPatch);
        return HttpResponse.json(task);
      }),
      ...baseHandlers(),
    );
    const { closed } = open({ task });
    await edit('Title', '  New title ');
    await edit('Description', ' Some words ');
    await edit('Acceptance criteria', ' first \n\n second ');
    const d = await dialog();
    fireEvent.click(within(d).getByRole('combobox', { name: 'Flow' }));
    fireEvent.click(await screen.findByRole('option', { name: /Quick/, hidden: true }));
    fireEvent.click(within(d).getByLabelText('Risks'));
    fireEvent.click(
      await screen.findByRole('option', { name: 'Database migration', hidden: true }),
    );
    fireEvent.click(within(d).getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    expect(patched[0]).toEqual({
      title: 'New title',
      description: 'Some words',
      acceptanceCriteria: ['first', 'second'],
      flowId: flow.id,
      riskTags: [RiskTag.Migration],
    });
    await waitFor(() => {
      expect(closed()).toBe(1);
    });
  });

  describe('where the work lands', () => {
    /** Serves the patch route and records what was sent. */
    function serveSaves(): TaskPatch[] {
      const patched: TaskPatch[] = [];
      serve(
        http.patch(daemonUrl('/tasks/:taskId'), async ({ request }) => {
          patched.push((await request.json()) as TaskPatch);
          return HttpResponse.json(taskDto());
        }),
      );
      return patched;
    }
    const choice = async (name: string) =>
      within(await dialog()).getByRole<HTMLInputElement>('radio', { name });
    const save = async () =>
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));

    it('starts from the task and names the base branch', async () => {
      serveSaves();
      open({ pullRequestBase: 'develop', task: { landing: { kind: 'hold' } } });
      expect((await choice('Hold for my review')).checked).toBe(true);
      expect((await choice('Merge into develop')).checked).toBe(false);
    });

    it('shows the branch a task merges into', async () => {
      serveSaves();
      open({
        pullRequestBase: 'main',
        task: { landing: { kind: 'branch', branch: 'feature/x' } },
      });
      expect((await choice('Merge into another branch')).checked).toBe(true);
      expect(
        within(await dialog()).getByLabelText<HTMLInputElement>('Branch to merge into').value,
      ).toBe('feature/x');
    });

    it('sends a changed landing with the other fields', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Hold for my review'));
      await save();
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]).toMatchObject({ landing: { kind: 'hold' } });
    });

    it('sends nothing about it when it did not change', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      await edit('Title', 'Another');
      await save();
      await waitFor(() => {
        expect(patched).toHaveLength(1);
      });
      expect(patched[0]).not.toHaveProperty('landing');
    });

    it('counts a changed landing as an edit to discard', async () => {
      serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Hold for my review'));
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
    });

    it('asks for a branch name before saving', async () => {
      const patched = serveSaves();
      open({ pullRequestBase: 'main' });
      fireEvent.click(await choice('Merge into another branch'));
      await save();
      expect(await screen.findByText('Name the branch this task merges into')).toBeTruthy();
      expect(patched).toEqual([]);
    });

    it('says where a started task will land, and offers no change', async () => {
      serveSaves();
      open({
        pullRequestBase: 'main',
        task: { workstreamId: workstreamDto().id },
        batch: batchDto({ baseBranch: 'release', autoMerge: true }),
        workstream: workstreamDto({ state: 'RUNNING' }),
      });
      const d = await dialog();
      expect(within(d).getByText('Merges into release when checks pass')).toBeTruthy();
      expect(within(d).queryByRole('radio')).toBeNull();
    });

    it('shows nothing for a project that commits directly', async () => {
      serveSaves();
      open();
      await dialog();
      expect(screen.queryByRole('radio')).toBeNull();
      expect(screen.queryByText('Where it lands')).toBeNull();
    });
  });

  it('refuses an empty title', async () => {
    let requests = 0;
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () => {
        requests += 1;
        return HttpResponse.json(taskDto());
      }),
    );
    open();
    await edit('Title', '   ');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Give the task a title')).toBeTruthy();
    expect(requests).toBe(0);
  });

  it('refuses no criteria', async () => {
    let requests = 0;
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () => {
        requests += 1;
        return HttpResponse.json(taskDto());
      }),
    );
    open();
    await edit('Acceptance criteria', ' \n ');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Add at least one acceptance criterion')).toBeTruthy();
    expect(requests).toBe(0);
  });

  it("shows the daemon's refusal beside Save", async () => {
    serve(
      http.patch(daemonUrl('/tasks/:taskId'), () =>
        HttpResponse.json({ error: 'task is archived' }, { status: 409 }),
      ),
    );
    open();
    await edit('Title', 'Another');
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText(/^Couldn't save: /)).toBeTruthy();
  });

  it('says changes apply next session while a workstream runs', async () => {
    serve();
    open({ workstream: workstreamDto({ state: 'RUNNING' }) });
    expect(await screen.findByText("Changes apply from the task's next session.")).toBeTruthy();
  });

  it('says nothing about sessions when there is no live workstream', async () => {
    serve();
    open({ workstream: workstreamDto({ state: 'DONE' }) });
    await dialog();
    expect(screen.queryByText("Changes apply from the task's next session.")).toBeNull();
  });

  describe('closing', () => {
    it('with edits asks first; Keep Editing keeps the drawer and the edit', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));

      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
      expect(closed()).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Keep Editing' }));
      await waitFor(() => {
        expect(discardPrompt()).toBeNull();
      });
      expect(closed()).toBe(0);
      expect(screen.getByLabelText<HTMLInputElement>('Title').value).toBe('Changed');
    });

    it('Discard closes the drawer', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      await screen.findByText('Discard your changes to this task?');
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(closed()).toBe(1);
    });

    it('Escape with edits asks too', async () => {
      serve();
      const { closed } = open();
      await edit('Title', 'Changed');
      fireEvent.keyDown(await dialog(), { key: 'Escape' });
      expect(await screen.findByText('Discard your changes to this task?')).toBeTruthy();
      expect(closed()).toBe(0);
    });

    it('with no edits closes at once', async () => {
      serve();
      const { closed } = open();
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Cancel' }));
      expect(closed()).toBe(1);
      expect(discardPrompt()).toBeNull();
    });
  });

  it('reads risk options in plain words', () => {
    expect(RISK_LABEL).toEqual({
      [RiskTag.Security]: 'Security',
      [RiskTag.Auth]: 'Sign-in and permissions',
      [RiskTag.Migration]: 'Database migration',
      [RiskTag.Dependency]: 'Dependencies',
    });
  });

  describe('delivery', () => {
    it('shows the branch, the pull request and Abandon with what Abandon does', async () => {
      serve();
      const batch = batchDto({ prUrl: 'https://github.com/acme/widgets/pull/9' });
      const ws = workstreamDto({ batchId: batch.id, state: 'QUEUED' });
      open({ workstream: ws, batch, workstreams: [ws] });
      const d = await dialog();
      expect(within(d).getByText('10db/greetings-0a1b2c3d')).toBeTruthy();
      expect(within(d).getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(
        'https://github.com/acme/widgets/pull/9',
      );
      expect(within(d).getByRole('button', { name: 'Abandon' })).toBeTruthy();
      expect(
        within(d).getByText('Abandon keeps the branch and cancels its unfinished task.'),
      ).toBeTruthy();
    });

    it('says why a ship failed, links the gate log and offers Retry', async () => {
      serve();
      const batch = batchDto({
        state: 'FAILED',
        failure: 'gate_failed',
        gateExitCode: 1,
        gateLogPath: '/data/logs/gate/b.log',
      });
      open({
        workstream: workstreamDto({ state: 'DONE', batchId: batch.id }),
        batch,
        gateCommand: 'make gate',
      });
      const d = await dialog();
      expect(within(d).getByText('Not shipped: the gate failed')).toBeTruthy();
      expect(within(d).getByText('make gate exited with code 1')).toBeTruthy();
      expect(within(d).getByRole('link', { name: 'Gate log' })).toBeTruthy();
      expect(within(d).getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it('shows no delivery section for a task with no batch', async () => {
      serve();
      open({ workstream: workstreamDto() });
      const d = await dialog();
      expect(within(d).queryByRole('button', { name: 'Abandon' })).toBeNull();
    });
  });

  describe('workstream state', () => {
    it('a failed task shows Failed, its reason and Retry', async () => {
      serve();
      open({
        workstream: workstreamDto({ state: 'FAILED', failureReason: 'The gate failed twice' }),
      });
      const d = await dialog();
      expect(within(d).getByText('Failed')).toBeTruthy();
      expect(within(d).getByText('The gate failed twice')).toBeTruthy();
      const retry = within(d).getByRole('button', { name: 'Retry' });
      expect((retry as HTMLButtonElement).disabled).toBe(false);
    });

    it('a queued task shows its place in line and Run Next, which says what it waits on', async () => {
      const ws = workstreamDto({ state: 'QUEUED' });
      const asked: string[] = [];
      serve(
        http.post(daemonUrl('/tasks/:taskId/run-next'), ({ params }) => {
          asked.push(String(params['taskId']));
          return HttpResponse.json({ workstream: ws, waitingOn: ['Base'] });
        }),
      );
      open({ task: { id: ws.taskId, title: 'Urgent fix' }, workstream: ws, place: 4 });
      const d = await dialog();
      expect(within(d).getByText('4th in line')).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Run Next' }));
      expect(
        await within(d).findByText(
          'Urgent fix will run once Base is done, before the other queued tasks.',
        ),
      ).toBeTruthy();
      expect(asked).toEqual([ws.taskId]);
    });

    it('offers no Run Next to a task that is running, or one parked in a column', async () => {
      serve();
      open({ workstream: workstreamDto({ state: 'RUNNING' }) });
      expect(within(await dialog()).queryByRole('button', { name: 'Run Next' })).toBeNull();
    });

    it('offers no Run Next to a parked task whose run is queued', async () => {
      serve();
      open({
        task: { boardColumnId: mintId('BoardColumn') },
        workstream: workstreamDto({ state: 'QUEUED' }),
      });
      expect(within(await dialog()).queryByRole('button', { name: 'Run Next' })).toBeNull();
    });

    it('Retry posts /workstreams/:id/retry', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const retried: string[] = [];
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
          retried.push(String(params['id']));
          return HttpResponse.json({ ...ws, state: 'QUEUED' });
        }),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(retried).toEqual([ws.id]);
      });
    });

    it('Retry posts the note the builder wrote, and no note when the field is empty', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const bodies: unknown[] = [];
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), async ({ request }) => {
          bodies.push(await request.json());
          return HttpResponse.json({ ...ws, state: 'QUEUED' });
        }),
      );
      open({ workstream: ws });
      const d = await dialog();
      // A gate failure, not a review: the note still reaches the next session, and says so.
      expect(
        within(d).getByText(
          'The session the retry starts gets this note, and the review’s findings too when a review sent the work back.',
        ),
      ).toBeTruthy();
      fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(bodies).toEqual([{}]);
      });
      fireEvent.change(within(d).getByLabelText('Note for the next session (optional)'), {
        target: { value: 'Use the existing card.' },
      });
      fireEvent.click(within(d).getByRole('button', { name: 'Retry' }));
      await waitFor(() => {
        expect(bodies).toEqual([{}, { note: 'Use the existing card.' }]);
      });
    });

    it('a retry refusal shows beside Retry', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      serve(
        http.post(daemonUrl('/workstreams/:id/retry'), () =>
          HttpResponse.json({ error: 'nope' }, { status: 409 }),
        ),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText(/^Couldn't retry: /)).toBeTruthy();
    });

    it('a failed task offers Close with what happens to its branch and worktree', async () => {
      serve();
      const batch = batchDto({ worktreePath: '/tmp/wt' });
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom', batchId: batch.id });
      open({ workstream: ws, batch, workstreams: [ws] });
      const d = await dialog();
      expect(within(d).getByRole('button', { name: 'Close task' })).toBeTruthy();
      expect(
        within(d).getByText(
          'Close keeps the branch 10db/greetings-0a1b2c3d and its worktree as they are.',
        ),
      ).toBeTruthy();
    });

    it('Close posts /tasks/:id/close and closes the drawer', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      const task = taskDto({ workstreamId: ws.id });
      const closed: string[] = [];
      serve(
        http.post(daemonUrl('/tasks/:taskId/close'), ({ params }) => {
          closed.push(String(params['taskId']));
          return HttpResponse.json({ ...task, status: 'cancelled' });
        }),
      );
      const drawer = open({ task, workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close task' }));
      await waitFor(() => {
        expect(closed).toEqual([task.id]);
      });
      await waitFor(() => {
        expect(drawer.closed()).toBe(1);
      });
    });

    describe('when the pull request closed without merging', () => {
      const closedPr = () =>
        batchDto({
          state: 'SHIPPED',
          prUrl: 'https://github.com/acme/widgets/pull/4',
          pr: {
            state: 'closed',
            checks: 'passing',
            failingChecks: [],
            checkedAt: '2026-10-29T12:00:00.000Z',
            unknownReason: null,
          },
        });

      it('says so, and posts /reopen from Reopen task and /close from Close task', async () => {
        const batch = closedPr();
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'blocked' });
        const calls: string[] = [];
        serve(
          http.post(daemonUrl('/tasks/:taskId/reopen'), ({ params }) => {
            calls.push(`reopen ${String(params['taskId'])}`);
            return HttpResponse.json({ ...task, status: 'open' });
          }),
          http.post(daemonUrl('/tasks/:taskId/close'), ({ params }) => {
            calls.push(`close ${String(params['taskId'])}`);
            return HttpResponse.json({ ...task, status: 'cancelled' });
          }),
        );
        open({ task, workstream: ws, batch, workstreams: [ws] });
        const d = await dialog();
        expect(within(d).getByText('The pull request closed without merging.')).toBeTruthy();
        fireEvent.click(within(d).getByRole('button', { name: 'Reopen task' }));
        await waitFor(() => {
          expect(calls).toEqual([`reopen ${task.id}`]);
        });
        fireEvent.click(within(d).getByRole('button', { name: 'Close task' }));
        await waitFor(() => {
          expect(calls).toEqual([`reopen ${task.id}`, `close ${task.id}`]);
        });
      });

      it('offers neither while the pull request is open', async () => {
        const batch = batchDto({
          state: 'SHIPPED',
          prUrl: 'https://github.com/acme/widgets/pull/4',
        });
        const ws = workstreamDto({ state: 'DONE', batchId: batch.id });
        const task = taskDto({ workstreamId: ws.id, status: 'done', boardStatus: 'in_review' });
        serve();
        open({ task, workstream: ws, batch, workstreams: [ws] });
        const d = await dialog();
        expect(within(d).queryByRole('button', { name: 'Reopen task' })).toBeNull();
        expect(within(d).queryByRole('button', { name: 'Close task' })).toBeNull();
      });
    });

    it('a refusal to close names what blocks it', async () => {
      const ws = workstreamDto({ state: 'FAILED', failureReason: 'boom' });
      serve(
        http.post(daemonUrl('/tasks/:taskId/close'), () =>
          HttpResponse.json(
            { error: 'conflict', message: "Task A can't be closed while Child waits on it" },
            { status: 409 },
          ),
        ),
      );
      open({ workstream: ws });
      fireEvent.click(within(await dialog()).getByRole('button', { name: 'Close task' }));
      expect(
        await screen.findByText("Couldn't close: Task A can't be closed while Child waits on it"),
      ).toBeTruthy();
    });

    it.each(['QUEUED', 'RUNNING', 'WAITING_HUMAN', 'DONE', 'CANCELLED'] as const)(
      'a %s workstream offers no Close',
      async (state) => {
        serve();
        open({ workstream: workstreamDto({ state }) });
        const d = await dialog();
        expect(within(d).queryByRole('button', { name: 'Close task' })).toBeNull();
      },
    );

    it.each(['DONE', 'CANCELLED'] as const)(
      'a %s workstream shows no state line',
      async (state) => {
        serve();
        open({ workstream: workstreamDto({ state }) });
        const d = await dialog();
        expect(within(d).queryByText(state === 'DONE' ? 'Done' : 'Cancelled')).toBeNull();
        expect(within(d).queryByRole('button', { name: 'Retry' })).toBeNull();
      },
    );

    it('an absent workstream shows no state line', async () => {
      serve();
      open();
      const d = await dialog();
      expect(within(d).queryByRole('button', { name: 'Retry' })).toBeNull();
      expect(within(d).queryByText('Failed')).toBeNull();
    });
  });

  describe('review rounds', () => {
    const round = (d: HTMLElement, index: number): HTMLElement => {
      const found = within(d).getAllByTestId('review-round')[index];
      if (!found) throw new Error(`no round ${String(index)}`);
      return found;
    };
    const result = (verdict: 'approve' | 'reject', at: string, summary: string) => ({
      summary,
      verdict,
      sessionId: mintId('Session'),
      at,
    });
    const reviewed = (state: 'FAILED' | 'DONE') =>
      workstreamDto({
        state,
        steps: [
          stepDto(),
          stepDto({
            role: 'review',
            personaName: 'Reviewer',
            tools: 'read_only',
            earlier: [
              result('reject', '2026-10-29T10:00:00.000Z', '1. BLOCKING src/a.ts:12 no test.'),
            ],
            result: result('approve', '2026-10-29T11:00:00.000Z', 'Looks right.'),
          }),
        ],
      });

    it('lists every round with its verdict and findings, newest first', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await dialog();
      expect(within(d).getAllByTestId('review-round')).toHaveLength(2);
      expect(within(round(d, 0)).getByText('Approved')).toBeTruthy();
      expect(within(round(d, 1)).getByText('Sent back')).toBeTruthy();
      expect(within(round(d, 1)).getByText('BLOCKING')).toBeTruthy();
      expect(within(round(d, 1)).getByText('src/a.ts:12')).toBeTruthy();
    });

    it('keeps the full review one click away', async () => {
      serve();
      open({ workstream: reviewed('DONE') });
      const d = await dialog();
      const sentBack = round(d, 1);
      expect(within(sentBack).queryByText('1. BLOCKING src/a.ts:12 no test.')).toBeNull();
      fireEvent.click(within(sentBack).getByRole('button', { name: 'Show the full review' }));
      expect(within(sentBack).getByText('1. BLOCKING src/a.ts:12 no test.')).toBeTruthy();
    });

    it('shows no section for a task nobody reviewed', async () => {
      serve();
      open({ workstream: workstreamDto({ steps: [stepDto()] }) });
      await dialog();
      expect(screen.queryByTestId('review-round')).toBeNull();
    });
  });
});
