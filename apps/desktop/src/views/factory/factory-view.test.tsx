import {
  SystemCheckDto,
  type BenchmarkSyncWarning,
  type GoalDigestDto,
  type GoalListDto,
  type GoalSummaryDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { batchDto, projectViewDto, stepDto, workstreamDto } from '../../test/fixtures';
import {
  digestDeviation,
  digestWaitingOn,
  goalDigestDto,
  goalDto,
  goalListDto,
  goalSummaryDto,
  ungroupedDto,
} from '../../test/goal-fixtures';

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function goals(list: GoalListDto): RequestHandler {
  return http.get(daemonUrl('/projects/:projectId/goals'), () => HttpResponse.json(list));
}

/** Answers GET /goals/:goalId/digest from the digests given, recording which goals were opened. */
function digests(opened: string[], ...answers: GoalDigestDto[]): RequestHandler {
  return http.get(daemonUrl('/goals/:goalId/digest'), ({ params }) => {
    const id = String(params['goalId']);
    opened.push(id);
    const digest = answers.find((d) => d.goalId === id);
    return digest
      ? HttpResponse.json(digest)
      : HttpResponse.json({ error: 'not_found', message: 'No such goal' }, { status: 404 });
  });
}

/** Answers GET /workstreams: every workstream, whatever the `active` parameter says. */
function workstreams(...all: WorkstreamDto[]): RequestHandler {
  return http.get(daemonUrl('/workstreams'), () => HttpResponse.json(all));
}

function goal(
  title: string,
  status: GoalDigestDto['status'],
  extra: { digest?: Partial<GoalDigestDto>; goal?: Partial<GoalSummaryDto['goal']> } = {},
): GoalSummaryDto {
  return goalSummaryDto({
    goal: { title, ...extra.goal },
    digest: { status, ...extra.digest },
  });
}

/** The row button of a goal: found by its title, which its accessible name starts with. */
function rowOf(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${title}`) });
}

/** The titles of the collapsed rows on screen, top to bottom: each row's text starts with its title. */
function rowTitles(known: readonly string[]): (string | undefined)[] {
  return within(screen.getByRole('group', { name: 'Goals' }))
    .getAllByRole('button', { expanded: false })
    .map((row) => known.find((title) => row.textContent.startsWith(title)));
}

describe('FactoryView goal list', () => {
  it('guides the builder when the project has no goals, and says nothing is running', async () => {
    serve(goals(goalListDto()));
    renderApp('/factory');

    expect(
      await screen.findByText(
        'Goals are outcomes 10db pursues across many tasks. Adopt a plan to start one, or ask Claude Code to with the 10db-task skill.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ungrouped/ })).toBeNull();
  });

  it('still lists running and failed tasks with no goal under Ungrouped', async () => {
    const running = workstreamDto({ taskTitle: 'Loose run', state: 'RUNNING' });
    const failed = workstreamDto({
      taskTitle: 'Loose break',
      state: 'FAILED',
      failureReason: 'The gate failed 4 times (last exit 2)',
    });
    const ungrouped = ungroupedDto({
      status: 'failed',
      running: 1,
      failed: 1,
      workstreams: [running, failed].map((ws) => ({
        workstreamId: ws.id,
        taskId: ws.taskId,
        taskTitle: ws.taskTitle,
        state: ws.state,
      })),
    });
    serve(goals(goalListDto([], ungrouped)), workstreams(running, failed));
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Ungrouped/ });
    expect(row.textContent).toContain('1 running · 1 failed');
    expect(screen.getByText(/Goals are outcomes 10db pursues/)).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Ungrouped' });
    expect(await within(region).findByText('Loose run')).toBeTruthy();
    expect(within(region).getByText('Loose break')).toBeTruthy();
    expect(within(region).getByText('The gate failed 4 times (last exit 2)')).toBeTruthy();
    expect(within(region).queryByRole('heading', { name: 'Pull requests' })).toBeNull();
  });

  it('orders goals failed, waiting on you, running, not started, Ungrouped, then Done, all collapsed', async () => {
    const loose = workstreamDto({ taskTitle: 'Loose run', state: 'RUNNING' });
    serve(
      goals(
        goalListDto(
          [
            goal('Finished', 'done'),
            goal('Idle', 'not_started'),
            goal('Busy', 'running'),
            goal('Asking', 'waiting_on_you'),
            goal('Broken', 'failed'),
            goal('Landing', 'shipping', { digest: { openPullRequests: 3 } }),
          ],
          ungroupedDto({
            workstreams: [
              {
                workstreamId: loose.id,
                taskId: loose.taskId,
                taskTitle: 'Loose run',
                state: 'RUNNING',
              },
            ],
          }),
        ),
      ),
      workstreams(loose),
    );
    renderApp('/factory');

    await screen.findByRole('button', { name: /^Broken/ });
    expect(rowTitles(['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Ungrouped', 'Done'])).toEqual(
      ['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Ungrouped', 'Done'],
    );
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
    expect(screen.queryAllByRole('region')).toEqual([]);
    // Done goals sit behind one collapsed line and show once it opens.
    expect(screen.queryByRole('button', { name: /^Finished/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(rowOf('Finished').getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the most recently changed goal first within a status', async () => {
    serve(
      goals(
        goalListDto([
          goal('Older', 'running', { goal: { updatedAt: hoursAgo(5) } }),
          goal('Newer', 'running', { goal: { updatedAt: hoursAgo(1) } }),
        ]),
      ),
    );
    renderApp('/factory');
    await screen.findByRole('button', { name: /^Newer/ });
    expect(rowTitles(['Newer', 'Older'])).toEqual(['Newer', 'Older']);
  });

  it.each([
    {
      name: 'a failed goal',
      summary: goal('Real areas', 'failed', { digest: { progress: progress(6, 11) } }),
      line: 'Failed · 6 of 11 tasks done',
    },
    {
      name: 'a goal waiting on cards',
      summary: goal('Real areas', 'waiting_on_you', {
        digest: {
          progress: progress(1, 8),
          waitingOn: {
            recent: [],
            earlier: [digestWaitingOn('Which name reads best?', hoursAgo(2))],
          },
        },
      }),
      line: 'Waiting on you · 1 card · 1 of 8 tasks done',
    },
    {
      name: 'a goal that is shipping',
      summary: goal('Real areas', 'shipping', {
        digest: { progress: progress(11, 11), openPullRequests: 3 },
      }),
      line: 'Shipping · 11 of 11 tasks done · 3 pull requests open',
    },
    {
      name: 'a goal not started',
      summary: goal('Real areas', 'not_started', { digest: { progress: progress(0, 11) } }),
      line: 'Not started · 11 tasks · Start Ready Tasks on the Board',
    },
  ])('says $name in one line', async ({ summary, line }) => {
    serve(goals(goalListDto([summary])));
    renderApp('/factory');
    expect((await screen.findByRole('button', { name: /^Real areas/ })).textContent).toContain(
      line,
    );
  });

  it('ends the line with the news, in plain text, when the goal has new items', async () => {
    const since = hoursAgo(3);
    const item = (n: number) => digestDeviation(`Deviation ${String(n)}`, hoursAgo(1));
    serve(
      goals(
        goalListDto([
          goal('Real areas', 'running', {
            digest: { since, deviations: { recent: [item(1), item(2), item(3)], earlier: [] } },
          }),
          goal('Quiet', 'running'),
        ]),
      ),
    );
    renderApp('/factory');

    expect((await screen.findByRole('button', { name: /^Real areas/ })).textContent).toContain(
      '· 3 new since 3h ago',
    );
    expect(rowOf('Quiet').textContent).not.toContain('new since');
  });
});

function progress(done: number, total: number): GoalDigestDto['progress'] {
  return { done, total, cancelled: [] };
}

describe('FactoryView goal detail', () => {
  function fixtures() {
    const a = goalDto({ title: 'Real areas' });
    const b = goalDto({ title: 'Other goal' });
    const wsA = workstreamDto({ taskTitle: 'Patch route', state: 'RUNNING' });
    const wsB = workstreamDto({ taskTitle: 'Other task', state: 'RUNNING' });
    const project = projectViewDto();
    const batch = batchDto({
      projectId: project.id,
      title: 'Patch route batch',
      state: 'SHIPPED',
      branch: '10db/patch-route',
      prUrl: 'https://github.com/acme/widgets/pull/9',
    });
    const withBatch = { ...wsA, batchId: batch.id };
    const summaryA = goalSummaryDto({
      goal: { ...a, taskIds: [wsA.taskId] },
      digest: { status: 'running', progress: progress(1, 3) },
    });
    const summaryB = goalSummaryDto({
      goal: { ...b, taskIds: [wsB.taskId] },
      digest: { status: 'running' },
    });
    return { a, b, wsA: withBatch, wsB, batch, project, summaryA, summaryB };
  }

  it('opens one goal at a time, showing its digest, Sessions and Pull requests', async () => {
    const { summaryA, summaryB, wsA, wsB, batch, project } = fixtures();
    const opened: string[] = [];
    serve(
      goals(goalListDto([summaryA, summaryB])),
      workstreams(wsA, wsB),
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      digests(opened, summaryA.digest, summaryB.digest),
    );
    renderApp('/factory');

    const rowA = await screen.findByRole('button', { name: /^Real areas/ });
    fireEvent.click(rowA);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(rowA.getAttribute('aria-expanded')).toBe('true');
    expect(rowA.getAttribute('aria-controls')).toBe(region.id);
    expect(within(region).getByRole('heading', { name: 'Sessions' })).toBeTruthy();
    expect(within(region).getByRole('heading', { name: 'Pull requests' })).toBeTruthy();
    // Only the goal's own workstreams are its sessions, and its batch is its pull request.
    expect(await within(region).findByText('Patch route')).toBeTruthy();
    expect(within(region).queryByText('Other task')).toBeNull();
    expect(
      (await within(region).findByRole('link', { name: 'Pull request' })).getAttribute('href'),
    ).toBe('https://github.com/acme/widgets/pull/9');
    expect(opened).toEqual([summaryA.goal.id]);

    // Opening another goal closes the first.
    fireEvent.click(rowOf('Other goal'));
    await screen.findByRole('region', { name: 'Other goal' });
    expect(rowA.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Real areas' })).toBeNull();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(opened).toEqual([summaryA.goal.id, summaryB.goal.id]);
  });

  it('closes an open goal on its row and on Escape', async () => {
    const { summaryA, wsA } = fixtures();
    serve(goals(goalListDto([summaryA])), workstreams(wsA), digests([], summaryA.digest));
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Real areas/ });
    fireEvent.click(row);
    await screen.findByRole('region', { name: 'Real areas' });
    fireEvent.click(row);
    await waitFor(() => {
      expect(screen.queryByRole('region')).toBeNull();
    });
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    fireEvent.keyDown(region, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('region')).toBeNull();
    });
  });

  it('shows the digest rows, Δ rows labelled since the last visit, with Show Earlier for the rest', async () => {
    const { summaryA, wsA } = fixtures();
    const since = hoursAgo(3);
    const digest = goalDigestDto({
      goalId: summaryA.goal.id,
      status: 'running',
      since,
      progress: progress(6, 11),
      workingNow: [
        {
          workstreamId: wsA.id,
          taskId: wsA.taskId,
          taskTitle: 'Patch route',
          persona: 'Implementer',
          model: 'sonnet-5.5',
          effort: 'high',
          stepNumber: 2,
          stepCount: 3,
        },
      ],
      team: [{ persona: 'Reviewer', model: 'opus-5.5', effort: 'high' }],
      next: {
        taskId: wsA.taskId,
        title: 'Edit areas in the drawer',
        waitsOn: [{ taskId: wsA.taskId, title: 'Patch route' }],
      },
      deviations: {
        recent: [digestDeviation('Split the task in two', hoursAgo(1))],
        earlier: [digestDeviation('Old split', hoursAgo(30))],
      },
      cost: { tokens: 412_000, dollars: 3.5, sessions: 14 },
    });
    serve(goals(goalListDto([{ ...summaryA, digest }])), workstreams(wsA), digests([], digest));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(await within(region).findByText('6 of 11 tasks done')).toBeTruthy();
    expect(within(region).getByRole('progressbar', { name: 'Tasks done' })).toBeTruthy();
    expect(within(region).getByText(/Implementer · sonnet-5\.5@high/)).toBeTruthy();
    expect(within(region).getByText(/Patch route · step 2 of 3/)).toBeTruthy();
    expect(within(region).getByText(/Reviewer opus-5\.5/)).toBeTruthy();
    expect(
      within(region).getByText(/Edit areas in the drawer when Patch route is done/),
    ).toBeTruthy();
    expect(within(region).getByText('412k tokens · 14 sessions · $3.50')).toBeTruthy();

    expect(await within(region).findByText('Deviations · since 3h ago')).toBeTruthy();
    expect(within(region).getByText(/Split the task in two/)).toBeTruthy();
    expect(within(region).queryByText(/Old split/)).toBeNull();
    // A row with nothing in it says "None": Waiting on, Decisions and Pull requests here.
    const decisions = within(region).getByText('Decisions · since 3h ago').closest('div');
    expect(decisions && within(decisions).getByText('None')).toBeTruthy();
    expect(within(region).getAllByText('None')).toHaveLength(3);

    fireEvent.click(within(region).getByRole('button', { name: 'Show Earlier' }));
    expect(within(region).getByText(/Old split/)).toBeTruthy();
  });

  it('shows skeleton lines while the digest loads, then an error inside the goal when it fails', async () => {
    const { summaryA, wsA } = fixtures();
    serve(
      goals(goalListDto([summaryA])),
      workstreams(wsA),
      http.get(daemonUrl('/goals/:goalId/digest'), () =>
        HttpResponse.json({ error: 'boom', message: 'The digest broke' }, { status: 500 }),
      ),
    );
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Real areas/ });
    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const alert = await within(region).findByRole('alert');
    expect(within(alert).getByText('The digest broke')).toBeTruthy();
    // The row stays, and the rest of the detail still shows.
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(within(region).getByRole('heading', { name: 'Sessions' })).toBeTruthy();
  });

  it('never shows a queued task as running: no step, no running badge, no running count', async () => {
    const queued = workstreamDto({
      taskTitle: 'Waiting task',
      state: 'QUEUED',
      steps: [stepDto(), stepDto()],
      stepIndex: 0,
      contextPct: null,
    });
    const summary = goalSummaryDto({
      goal: { title: 'Real areas', taskIds: [queued.taskId] },
      digest: { status: 'not_started' },
    });
    serve(goals(goalListDto([summary])), workstreams(queued), digests([], summary.digest));
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Real areas/ });
    expect(row.textContent).not.toMatch(/Running/);
    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const sessions = await within(region).findByRole('table', { name: 'Sessions' });
    const line = within(sessions).getByText('Waiting task').closest('tr');
    if (!line) throw new Error('Waiting task is not in a table row');
    expect(within(line).getByText('Queued')).toBeTruthy();
    expect(within(line).queryByText(/Running/)).toBeNull();
    expect(within(line).queryByText(/1\/2/)).toBeNull();
    expect(within(line).getByText('Waiting for a free lane')).toBeTruthy();
  });
});

describe('FactoryView sessions', () => {
  function open(ws: WorkstreamDto, over: (RequestHandler | WebSocketHandler)[] = []) {
    const summary = goalSummaryDto({
      goal: { title: 'Real areas', taskIds: [ws.taskId] },
      digest: { status: 'failed' },
    });
    serve(goals(goalListDto([summary])), workstreams(ws), digests([], summary.digest), ...over);
    renderApp('/factory');
  }

  async function sessionRow(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const row = (await within(region).findByText(title)).closest('tr');
    if (!row) throw new Error(`${title} is not in a table row`);
    return row;
  }

  it('offers Retry only on a failed session, and shows why it failed', async () => {
    const failed = workstreamDto({
      taskTitle: 'Broken',
      state: 'FAILED',
      failureReason: 'The gate failed 4 times (last exit 2)',
    });
    const retried: string[] = [];
    open(failed, [
      http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
        retried.push(String(params['id']));
        return HttpResponse.json({ ...failed, state: 'QUEUED' });
      }),
    ]);

    const row = await sessionRow('Broken');
    expect(within(row).getByText('The gate failed 4 times (last exit 2)')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(retried).toEqual([failed.id]);
    });
  });

  it('shows a refused retry beside the sessions', async () => {
    const failed = workstreamDto({ taskTitle: 'Broken', state: 'FAILED' });
    open(failed, [
      http.post(daemonUrl('/workstreams/:id/retry'), () =>
        HttpResponse.json({ error: 'conflict', message: 'not retryable now' }, { status: 409 }),
      ),
    ]);
    fireEvent.click(within(await sessionRow('Broken')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('not retryable now')).toBeTruthy();
  });

  it('cancels after confirmation', async () => {
    const ws = workstreamDto({ taskTitle: 'Alpha', state: 'WAITING_HUMAN' });
    const cancelled: string[] = [];
    open(ws, [
      http.post(daemonUrl('/workstreams/:id/cancel'), ({ params }) => {
        cancelled.push(String(params['id']));
        return HttpResponse.json({ ...ws, state: 'CANCELLED' });
      }),
    ]);

    fireEvent.click(within(await sessionRow('Alpha')).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this workstream?' });
    expect(cancelled).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel workstream' }));
    await waitFor(() => {
      expect(cancelled).toEqual([ws.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('shows a refused cancel inside the dialog and clears it when the dialog closes', async () => {
    const ws = workstreamDto({ taskTitle: 'Alpha', state: 'RUNNING' });
    open(ws, [
      http.post(daemonUrl('/workstreams/:id/cancel'), () =>
        HttpResponse.json({ error: 'conflict', message: 'already finished' }, { status: 409 }),
      ),
    ]);

    fireEvent.click(within(await sessionRow('Alpha')).getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this workstream?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel workstream' }));
    expect(await within(dialog).findByText('already finished')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep running' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(screen.queryByText('already finished')).toBeNull();
  });

  it('lists a finished session without Cancel or Retry', async () => {
    const done = workstreamDto({
      taskTitle: 'Shipped',
      state: 'DONE',
      contextPct: null,
      lastActivityAt: null,
    });
    open(done);
    const row = await sessionRow('Shipped');
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });
});

describe('FactoryView loading and errors', () => {
  it('shows a loader while the goals load', async () => {
    serve(http.get(daemonUrl('/projects/:projectId/goals'), () => new Promise(() => undefined)));
    renderApp('/factory');
    expect(await screen.findByLabelText('Loading goals')).toBeTruthy();
  });

  it('shows a failed load as an error, not as the empty guide', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/goals'), () =>
        HttpResponse.json({ error: 'boom', message: 'The goals broke' }, { status: 500 }),
      ),
    );
    renderApp('/factory');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Couldn't load the goals")).toBeTruthy();
    expect(within(alert).getByText('The goals broke')).toBeTruthy();
    expect(screen.queryByText(/Goals are outcomes 10db pursues/)).toBeNull();
  });
});

function systemCheck(benchmarkSync: BenchmarkSyncWarning): RequestHandler {
  return http.get(daemonUrl('/system'), () =>
    HttpResponse.json(
      SystemCheckDto.parse({
        loginEnv: { source: 'login_shell', warning: null },
        claudeCode: { verifiedOn: '2.1.0', warning: null },
        tools: [],
        benchmarkSync,
      }),
    ),
  );
}

describe('FactoryView benchmark sync note', () => {
  it.each([
    {
      name: 'a used-up daily limit',
      warning: {
        outcome: 'rate_limited',
        message: 'The daily Artificial Analysis limit is used up; retry in 3600 s',
      },
    },
    {
      name: 'an unreachable server',
      warning: { outcome: 'failed', message: 'Artificial Analysis answered 503' },
    },
  ] satisfies { name: string; warning: BenchmarkSyncWarning }[])(
    'notes $name as a dimmed line in the header, not an alert',
    async ({ warning }) => {
      serve(systemCheck(warning));
      renderApp('/factory');

      const note = await screen.findByText(
        `${warning.message}. Routing uses the last good scores.`,
      );
      expect(note.closest('[role="alert"]')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('leaves a refused key to the alert above the view', async () => {
    serve(systemCheck({ outcome: 'unauthorized', message: 'Artificial Analysis refused the key' }));
    renderApp('/factory');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Artificial Analysis refused the key')).toBeTruthy();
    expect(screen.queryByText(/Routing uses the last good scores\.$/)).toBeNull();
  });
});
