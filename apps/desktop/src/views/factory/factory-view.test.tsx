import {
  mintId,
  SelfUpdateStatusDto,
  SystemCheckDto,
  type BenchmarkSyncWarning,
  type GoalDigestDto,
  type GoalListDto,
  type GoalSummaryDto,
  type HumanTouchDayDto,
  type TaskDto,
  type WorkstreamDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { batchDto, projectViewDto, stepDto, taskDto, workstreamDto } from '../../test/fixtures';
import {
  digestDeviation,
  digestWaitingOn,
  goalCriterionDto,
  goalDigestDto,
  goalDto,
  goalListDto,
  goalSummaryDto,
  ungroupedDto,
} from '../../test/goal-fixtures';
import { failureLine } from '../board/task-state';

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

/** Answers GET /projects/:id/tasks with the tasks given. */
function tasksOf(...all: TaskDto[]): RequestHandler {
  return http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(all));
}

function goal(
  title: string,
  status: GoalDigestDto['status'],
  extra: {
    digest?: Partial<GoalDigestDto>;
    goal?: Partial<GoalSummaryDto['goal']>;
    newItems?: number;
  } = {},
): GoalSummaryDto {
  return goalSummaryDto({ title, ...extra.goal }, { status, ...extra.digest }, extra.newItems);
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
        'Goals are outcomes 10db pursues across many tasks. Plan Work… to start one, or ask Claude Code to with the 10db-task skill.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Not in a goal/ })).toBeNull();
  });

  it('has Plan Work… as its primary, which opens a new conversation, and no Adopt a Plan…', async () => {
    serve(goals(goalListDto()));
    const { router } = renderApp('/factory');

    const shape = await screen.findByRole('link', { name: 'Plan Work…' });
    expect(screen.queryByText('Adopt a Plan…')).toBeNull();
    fireEvent.click(shape);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/shape');
    });
  });

  it('still lists running and failed tasks with no goal under Not in a goal', async () => {
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
    serve(
      goals({ ...goalListDto(), ungrouped }),
      workstreams(running, failed),
      tasksOf(
        taskDto({ id: running.taskId, workstreamId: running.id }),
        taskDto({ id: failed.taskId, workstreamId: failed.id }),
      ),
    );
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Not in a goal/ });
    expect(row.textContent).toContain('1 running · 1 failed');
    expect(screen.getByText(/Goals are outcomes 10db pursues/)).toBeTruthy();
    expect(row.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Not in a goal' });
    expect(await within(region).findByText('Loose run')).toBeTruthy();
    expect(within(region).getByText('Loose break')).toBeTruthy();
    expect(await within(region).findByText('The run failed. Retry runs it again.')).toBeTruthy();
    expect(within(region).queryByRole('heading', { name: 'Pull requests' })).toBeNull();
  });

  it.each([
    { name: 'parked', task: { boardColumnId: mintId('BoardColumn') }, batch: undefined },
    {
      name: 'replaced by a newer run',
      task: { workstreamId: mintId('Workstream') },
      batch: undefined,
    },
    { name: 'in a batch that shipped without a pull request', task: {}, batch: 'shipped' },
  ])(
    'says only what happened, with no Retry, on a Not in a goal row whose task is $name',
    async ({ task, batch }) => {
      const shipped = batchDto({ state: 'SHIPPED', prUrl: null });
      const failed = workstreamDto({
        taskTitle: 'Loose break',
        state: 'FAILED',
        batchId: batch ? shipped.id : null,
      });
      const ungrouped = ungroupedDto({
        status: 'failed',
        failed: 1,
        workstreams: [
          {
            workstreamId: failed.id,
            taskId: failed.taskId,
            taskTitle: failed.taskTitle,
            state: failed.state,
          },
        ],
      });
      serve(
        goals({ ...goalListDto(), ungrouped }),
        workstreams(failed),
        tasksOf(taskDto({ id: failed.taskId, workstreamId: failed.id, ...task })),
        http.get(daemonUrl('/projects/:projectId/batches'), () =>
          HttpResponse.json(batch ? [shipped] : []),
        ),
      );
      renderApp('/factory');

      fireEvent.click(await screen.findByRole('button', { name: /^Not in a goal/ }));
      const region = await screen.findByRole('region', { name: 'Not in a goal' });
      expect(await within(region).findByText('The run failed.')).toBeTruthy();
      expect(within(region).queryByText(/Retry/)).toBeNull();
      expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
    },
  );

  describe('a Not in a goal row while what decides a retry is unknown', () => {
    const free = workstreamDto({ taskTitle: 'Free break', state: 'FAILED' });
    const batched = workstreamDto({
      taskTitle: 'Batched break',
      state: 'FAILED',
      batchId: mintId('Batch'),
    });
    const ungrouped = ungroupedDto({
      status: 'failed',
      failed: 2,
      workstreams: [free, batched].map((ws) => ({
        workstreamId: ws.id,
        taskId: ws.taskId,
        taskTitle: ws.taskTitle,
        state: ws.state,
      })),
    });
    const refused = () =>
      HttpResponse.json({ error: 'internal', message: 'The list broke' }, { status: 500 });

    async function openRegion(...over: RequestHandler[]): Promise<HTMLElement> {
      serve(goals({ ...goalListDto(), ungrouped }), workstreams(free, batched), ...over);
      renderApp('/factory');
      fireEvent.click(await screen.findByRole('button', { name: /^Not in a goal/ }));
      return screen.findByRole('region', { name: 'Not in a goal' });
    }

    const tasks = tasksOf(
      taskDto({ id: free.taskId, workstreamId: free.id }),
      taskDto({ id: batched.taskId, workstreamId: batched.id }),
    );

    function rowOf(region: HTMLElement, title: string): HTMLElement {
      const row = within(region).getByText(title).closest('tr');
      if (!row) throw new Error(`${title} is not in a table row`);
      return row;
    }

    it.each([
      { name: 'still loading', answer: () => delay('infinite') },
      { name: 'refused', answer: refused },
    ])('promises nothing for a run in a batch while batches are $name', async ({ answer }) => {
      const region = await openRegion(
        tasks,
        http.get(daemonUrl('/projects/:projectId/batches'), answer),
      );

      // The run with no batch gets its Retry, so the tasks have loaded and only the batch is unknown.
      await within(region).findByRole('button', { name: 'Retry' });
      const row = rowOf(region, 'Batched break');
      expect(within(row).getByText('The run failed.')).toBeTruthy();
      expect(within(row).queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('says why when the batches request fails', async () => {
      const region = await openRegion(
        tasks,
        http.get(daemonUrl('/projects/:projectId/batches'), refused),
      );
      expect(await within(region).findByText('The list broke')).toBeTruthy();
    });

    it('says why Retry is gone when the tasks request fails', async () => {
      const region = await openRegion(
        http.get(daemonUrl('/projects/:projectId/tasks'), refused),
        http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([])),
      );
      expect(await within(region).findByText('The list broke')).toBeTruthy();
      expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
    });
  });

  it('orders goals failed, waiting on you, running, not started, Not in a goal, then Done, all collapsed', async () => {
    const loose = workstreamDto({ taskTitle: 'Loose run', state: 'RUNNING' });
    serve(
      goals({
        ...goalListDto(
          goal('Finished', 'done'),
          goal('Idle', 'not_started'),
          goal('Busy', 'running'),
          goal('Asking', 'waiting_on_you'),
          goal('Broken', 'failed'),
          goal('Landing', 'shipping', { digest: { openPullRequests: 3 } }),
        ),
        ungrouped: ungroupedDto({
          workstreams: [
            {
              workstreamId: loose.id,
              taskId: loose.taskId,
              taskTitle: 'Loose run',
              state: 'RUNNING',
            },
          ],
        }),
      }),
      workstreams(loose),
    );
    renderApp('/factory');

    await screen.findByRole('button', { name: /^Broken/ });
    expect(
      rowTitles(['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Not in a goal', 'Done']),
    ).toEqual(['Broken', 'Asking', 'Busy', 'Landing', 'Idle', 'Not in a goal', 'Done']);
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
    expect(screen.queryAllByRole('region')).toEqual([]);
    // Done goals sit behind one collapsed line and show once it opens.
    expect(screen.queryByRole('button', { name: /^Finished/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done (1)' }));
    expect(rowOf('Finished').getAttribute('aria-expanded')).toBe('false');
  });

  it('opens the goal a link names, reading its digest once', async () => {
    const linked = goal('Linked', 'running');
    const other = goal('Other', 'running');
    const opened: string[] = [];
    serve(goals(goalListDto(linked, other)), digests(opened, linked.digest, other.digest));
    renderApp(`/factory?goal=${linked.goal.id}`);

    const row = await screen.findByRole('button', { name: /^Linked/ });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(rowOf('Other').getAttribute('aria-expanded')).toBe('false');
    expect(await screen.findByRole('region', { name: 'Linked' })).toBeTruthy();
    await waitFor(() => {
      expect(opened).toEqual([linked.goal.id]);
    });
  });

  it('opens the Done group for a linked goal that is done', async () => {
    const finished = goal('Finished', 'done');
    serve(goals(goalListDto(finished, goal('Busy', 'running'))), digests([], finished.digest));
    renderApp(`/factory?goal=${finished.goal.id}`);

    const row = await screen.findByRole('button', { name: /^Finished/ });
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens nothing for a link to a goal the project does not have', async () => {
    const opened: string[] = [];
    serve(goals(goalListDto(goal('Busy', 'running'))), digests(opened));
    renderApp(`/factory?goal=${goal('Elsewhere', 'running').goal.id}`);

    await screen.findByRole('button', { name: /^Busy/ });
    expect(screen.queryAllByRole('button', { expanded: true })).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('puts the most recently changed goal first within a status', async () => {
    serve(
      goals(
        goalListDto(
          goal('Older', 'running', { goal: { updatedAt: hoursAgo(5) } }),
          goal('Newer', 'running', { goal: { updatedAt: hoursAgo(1) } }),
        ),
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
      line: 'Failed · 6 of 11 tasks merged',
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
      line: 'Waiting on you · 1 card · 1 of 8 tasks merged',
    },
    {
      name: 'a goal that is shipping',
      summary: goal('Real areas', 'shipping', {
        digest: { progress: progress(8, 11, 3), openPullRequests: 3 },
      }),
      line: 'Shipping · 8 of 11 tasks merged · 3 in review · 3 pull requests open',
    },
    {
      name: 'a goal not started',
      summary: goal('Real areas', 'not_started', { digest: { progress: progress(0, 11) } }),
      line: 'Not started · 11 tasks',
    },
    {
      name: 'a goal with progress and nothing running',
      summary: goal('Real areas', 'idle', { digest: { progress: progress(4, 8, 4) } }),
      line: 'Idle · 4 of 8 tasks merged · 4 in review',
    },
    {
      name: 'a goal whose open tasks are queued',
      summary: goal('Real areas', 'queued', { digest: { progress: progress(6, 11) } }),
      line: 'Queued · 6 of 11 tasks merged · waiting for a lane',
    },
  ])('says $name in one line', async ({ summary, line }) => {
    serve(goals(goalListDto(summary)));
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
        goalListDto(
          goal('Real areas', 'running', {
            digest: { since, deviations: { recent: [item(1), item(2), item(3)], earlier: [] } },
            newItems: 3,
          }),
          goal('Quiet', 'running'),
        ),
      ),
    );
    renderApp('/factory');

    expect((await screen.findByRole('button', { name: /^Real areas/ })).textContent).toContain(
      '· 3 new since 3h ago',
    );
    expect(rowOf('Quiet').textContent).not.toContain('new since');
  });
});

function progress(merged: number, total: number, inReview = 0): GoalDigestDto['progress'] {
  return { merged, inReview, total, cancelled: [] };
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
    const summaryA = goalSummaryDto(
      { ...a, taskIds: [wsA.taskId] },
      { status: 'running', progress: progress(1, 3) },
    );
    const summaryB = goalSummaryDto({ ...b, taskIds: [wsB.taskId] }, { status: 'running' });
    return { a, b, wsA: withBatch, wsB, batch, project, summaryA, summaryB };
  }

  it('opens one goal at a time, showing its task list with the pull request on its row', async () => {
    const { summaryA, summaryB, wsA, wsB, batch, project } = fixtures();
    const opened: string[] = [];
    const taskA = taskDto({ id: wsA.taskId, title: 'Patch route', goalId: summaryA.goal.id });
    const taskB = taskDto({ id: wsB.taskId, title: 'Other task', goalId: summaryB.goal.id });
    serve(
      goals(goalListDto(summaryA, summaryB)),
      workstreams(wsA, wsB),
      tasksOf(taskA, taskB),
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
    expect(within(region).queryByRole('heading', { name: 'Sessions' })).toBeNull();
    expect(within(region).queryByRole('heading', { name: 'Pull requests' })).toBeNull();
    // Only the goal's own tasks are listed, and its batch's pull request is on the row.
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
    serve(goals(goalListDto(summaryA)), workstreams(wsA), digests([], summaryA.digest));
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

  it('orders the zones: bar, Needs you, tasks, collapsed history and brief, then one footer', async () => {
    const { summaryA, wsA } = fixtures();
    const since = hoursAgo(3);
    const card = digestWaitingOn('Approve the plan', hoursAgo(1));
    const digest = goalDigestDto(summaryA.goal.id, {
      status: 'waiting_on_you',
      since,
      progress: progress(6, 11, 2),
      waitingOn: { recent: [card], earlier: [] },
      team: [
        { persona: 'Implementer', model: 'opus', effort: 'high' },
        { persona: 'Implementer', model: 'sonnet', effort: 'medium' },
        { persona: 'Reviewer', model: 'opus', effort: 'medium' },
      ],
      deviations: {
        recent: [digestDeviation('Split the task in two', hoursAgo(1))],
        earlier: [digestDeviation('Old split', hoursAgo(30))],
      },
      cost: { tokens: 412_000, dollars: 3.5, sessions: 14 },
    });
    const task = taskDto({
      id: wsA.taskId,
      title: 'Patch route',
      goalId: summaryA.goal.id,
      boardStatus: 'in_progress',
    });
    serve(
      goals(goalListDto({ ...summaryA, digest })),
      workstreams(wsA),
      tasksOf(task),
      digests([], digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(await within(region).findByText('Patch route')).toBeTruthy();
    expect(
      within(region).getByText('6 merged · 2 in review · 1 in progress · 2 not started'),
    ).toBeTruthy();
    expect(within(region).getByText('Approve the plan')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'Inbox ›' })).toBeTruthy();

    // The order the builder acts in: bar, Needs you, Tasks, Since you last looked, About, footer.
    const text = region.textContent;
    const at = (needle: string) => text.indexOf(needle);
    expect(at('6 merged')).toBeLessThan(at('Needs you'));
    expect(at('Needs you')).toBeLessThan(at('Patch route'));
    expect(at('Patch route')).toBeLessThan(at('Since you last looked'));
    expect(at('Since you last looked')).toBeLessThan(at('About this goal'));
    expect(at('About this goal')).toBeLessThan(at('Implementer opus@high'));

    // Each persona once, with its profiles; then the cost, in one dimmed line.
    expect(
      within(region).getByText(
        'Implementer opus@high, sonnet@medium · Reviewer opus@medium · 412k tokens · 14 sessions · $3.50',
      ),
    ).toBeTruthy();
    // The old rows are gone.
    for (const label of ['Working now', 'Team', 'Next', 'Cost', 'Waiting on']) {
      expect(within(region).queryByText(label)).toBeNull();
    }
  });

  it('draws no Needs you block when nothing needs the builder', async () => {
    const { summaryA, wsA } = fixtures();
    serve(goals(goalListDto(summaryA)), workstreams(wsA), digests([], summaryA.digest));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    await within(region).findByRole('button', { name: /^Since you last looked/ });
    expect(within(region).queryByText('Needs you')).toBeNull();
  });

  it('keeps deviations and decisions behind a collapsed Since you last looked, one clamped line each', async () => {
    const { summaryA, wsA } = fixtures();
    const since = hoursAgo(3);
    const sessionId = 'ses_01abcdef';
    const digest = goalDigestDto(summaryA.goal.id, {
      status: 'running',
      since,
      deviations: {
        recent: [digestDeviation(`Split the task in two (${sessionId})`, hoursAgo(1))],
        earlier: [digestDeviation('Old split', hoursAgo(30))],
      },
      decisions: {
        recent: [
          {
            id: mintId('Decision'),
            question: 'Which name reads best?',
            choice: 'Call it Greeter',
            at: hoursAgo(1),
          },
        ],
        earlier: [],
      },
    });
    serve(goals(goalListDto({ ...summaryA, digest })), workstreams(wsA), digests([], digest));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const toggle = await within(region).findByRole('button', {
      name: 'Since you last looked (3h) 1 deviation · 1 decision',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(region).queryByText(/Split the task in two/)).toBeNull();

    fireEvent.click(toggle);
    const line = within(region).getByText('Split the task in two');
    expect(region.textContent).not.toContain(sessionId);
    expect(within(region).getByText('Call it Greeter')).toBeTruthy();
    expect(within(region).queryByText(/Old split/)).toBeNull();
    // The session id is in the tooltip only.
    fireEvent.mouseEnter(line);
    expect(await screen.findByText(`Split the task in two (${sessionId})`)).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Show Earlier' }));
    expect(within(region).getByText(/Old split/)).toBeTruthy();
  });

  it('keeps the objective and criteria behind a collapsed About this goal', async () => {
    const { summaryA, wsA } = fixtures();
    const about = goalSummaryDto(
      {
        ...summaryA.goal,
        objective: 'Importing a CSV works end to end.',
        criteria: [goalCriterionDto(summaryA.goal.id, { text: 'Bad rows are reported' })],
      },
      { status: 'running' },
    );
    serve(goals(goalListDto(about)), workstreams(wsA), digests([], about.digest));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(within(region).queryByText('Importing a CSV works end to end.')).toBeNull();
    fireEvent.click(await within(region).findByRole('button', { name: /^About this goal/ }));
    expect(within(region).getByText('Importing a CSV works end to end.')).toBeTruthy();
    expect(within(region).getByText('Bad rows are reported')).toBeTruthy();
  });

  it('opens the batch sheet for the goal from Start Ready Tasks…', async () => {
    const { a, wsA } = fixtures();
    const ready = taskDto({ goalId: a.id, boardStatus: 'ready' });
    const summaryA = goalSummaryDto({ ...a, taskIds: [wsA.taskId, ready.id] }, { status: 'idle' });
    const asked: (string | null)[] = [];
    serve(
      goals(goalListDto(summaryA)),
      workstreams(wsA),
      tasksOf(ready),
      digests([], summaryA.digest),
      http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) => {
        asked.push(new URL(request.url).searchParams.get('goalId'));
        return HttpResponse.json(
          { error: 'unavailable', message: 'not in this test' },
          { status: 500 },
        );
      }),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const start = await within(region).findByRole('button', { name: 'Start Ready Tasks…' });
    await waitFor(() => {
      expect(start.hasAttribute('disabled')).toBe(false);
    });
    fireEvent.click(start);
    expect(await screen.findByText('Only tasks of the goal Real areas.')).toBeTruthy();
    await waitFor(() => {
      expect(asked).toEqual([summaryA.goal.id]);
    });
  });

  it('counts a ready task whose run was cancelled as ready, and enables Start Ready Tasks…', async () => {
    const { a } = fixtures();
    const task = taskDto({ goalId: a.id, title: 'Tried once', boardStatus: 'ready' });
    const cancelled = workstreamDto({
      taskId: task.id,
      taskTitle: 'Tried once',
      state: 'CANCELLED',
    });
    const summary = goalSummaryDto({ ...a, taskIds: [task.id] }, { status: 'idle' });
    serve(
      goals(goalListDto(summary)),
      workstreams(cancelled),
      tasksOf(task),
      digests([], summary.digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const row = (await within(region).findByText('Tried once')).closest('[role="listitem"]');
    if (!(row instanceof HTMLElement)) throw new Error('Tried once is not in a list row');
    expect(within(row).getByText(/^Ready/)).toBeTruthy();
    const start = await within(region).findByRole('button', { name: 'Start Ready Tasks…' });
    await waitFor(() => {
      expect(start.hasAttribute('disabled')).toBe(false);
    });
  });

  it('disables Start Ready Tasks… when no task of the goal is ready', async () => {
    const { summaryA, wsA } = fixtures();
    serve(goals(goalListDto(summaryA)), workstreams(wsA), digests([], summaryA.digest));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const start = await within(region).findByRole('button', { name: 'Start Ready Tasks…' });
    expect(start.hasAttribute('disabled')).toBe(true);
  });

  it('shows skeleton lines while the digest loads, then an error inside the goal when it fails', async () => {
    const { summaryA, wsA } = fixtures();
    serve(
      goals(goalListDto(summaryA)),
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
    expect(await within(region).findByText('This goal has no tasks yet.')).toBeTruthy();
  });

  it('never shows a queued task as running: no step, no running badge, no running count', async () => {
    const queued = workstreamDto({
      taskTitle: 'Waiting task',
      state: 'QUEUED',
      steps: [stepDto(), stepDto()],
      stepIndex: 0,
      contextPct: 12,
    });
    const task = taskDto({ id: queued.taskId, title: 'Waiting task', boardStatus: 'in_progress' });
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [queued.taskId] },
      { status: 'queued' },
    );
    serve(
      goals(goalListDto(summary)),
      workstreams(queued),
      tasksOf({ ...task, goalId: summary.goal.id }),
      digests([], summary.digest),
    );
    renderApp('/factory');

    const row = await screen.findByRole('button', { name: /^Real areas/ });
    expect(row.textContent).not.toMatch(/Running/);
    fireEvent.click(row);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const line = (await within(region).findByText('Waiting task')).closest('[role="listitem"]');
    if (!(line instanceof HTMLElement)) throw new Error('Waiting task is not in a list row');
    expect(within(line).getByText('Queued')).toBeTruthy();
    expect(within(line).queryByText(/Running/)).toBeNull();
    expect(within(line).queryByText(/1\/2/)).toBeNull();
    expect(within(line).queryByRole('progressbar')).toBeNull();
  });
});

describe('FactoryView task list', () => {
  /** Opens a goal holding one task with the run given; the task is named for the run's title. */
  function open(
    ws: WorkstreamDto,
    over: (RequestHandler | WebSocketHandler)[] = [],
    task: Partial<TaskDto> = {},
  ) {
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [ws.taskId] },
      { status: 'failed' },
    );
    serve(
      goals(goalListDto(summary)),
      workstreams(ws),
      tasksOf(
        taskDto({
          id: ws.taskId,
          title: ws.taskTitle,
          headline: ws.taskHeadline,
          goalId: summary.goal.id,
          boardStatus: 'in_progress',
          workstreamId: ws.id,
          ...task,
        }),
      ),
      digests([], summary.digest),
      ...over,
    );
    renderApp('/factory');
  }

  /** The row of the task in the open goal. */
  async function sessionRow(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const row = (await within(region).findByText(title)).closest('[role="listitem"]');
    if (!(row instanceof HTMLElement)) throw new Error(`${title} is not in a list row`);
    return row;
  }

  it.each([
    'no_result',
    'gate_failed',
    'session_failed',
    'retry_limit',
    'rejected_at_limit',
    null,
  ] as const)(
    'says a %s failure in the plain line the Board says, with the raw reason as its tooltip',
    async (kind) => {
      const failed = workstreamDto({
        taskTitle: 'Broken',
        state: 'FAILED',
        failureKind: kind,
        failureReason: 'The gate failed 4 times (last exit 2)',
        steps: [stepDto({ status: 'done' }), stepDto({ role: 'review', status: 'failed' })],
        stepIndex: 1,
      });
      open(failed);
      const row = await sessionRow('Broken');
      // The row says it failed; the plain line and Retry are in Needs you.
      expect(within(row).getByText('Failed')).toBeTruthy();
      const region = screen.getByRole('region', { name: 'Real areas' });
      const line = within(region).getByText(`Failed: Broken. ${failureLine(failed, true)}`);
      expect(screen.queryByText('The gate failed 4 times (last exit 2)')).toBeNull();
      fireEvent.mouseEnter(line);
      expect(await screen.findByText('The gate failed 4 times (last exit 2)')).toBeTruthy();
    },
  );

  it('offers Retry in Needs you only for a failed run, and shows why it failed', async () => {
    const failed = workstreamDto({
      taskTitle: 'Broken',
      state: 'FAILED',
      failureKind: 'gate_failed',
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
    const region = screen.getByRole('region', { name: 'Real areas' });
    expect(
      within(region).getByText(
        'Failed: Broken. The checks kept failing and the run ran out of fix attempts. Retry runs it again.',
      ),
    ).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Cancel' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(retried).toEqual([failed.id]);
    });
  });

  it.each([
    { name: 'parked', task: { boardColumnId: mintId('BoardColumn') } },
    { name: 'replaced by a newer run', task: { workstreamId: mintId('Workstream') } },
  ])(
    'says only what happened, with no Retry, when the task is $name and the daemon would refuse',
    async ({ task }) => {
      const failed = workstreamDto({
        taskTitle: 'Broken',
        state: 'FAILED',
        failureKind: 'gate_failed',
      });
      open(failed, [], task);

      await sessionRow('Broken');
      const region = screen.getByRole('region', { name: 'Real areas' });
      expect(
        within(region).getByText(
          'Failed: Broken. The checks kept failing and the run ran out of fix attempts.',
        ),
      ).toBeTruthy();
      expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
    },
  );

  it('says only what happened, with no Retry, when the failed run’s batch shipped without a pull request', async () => {
    const batch = batchDto({ state: 'SHIPPED', prUrl: null });
    const failed = workstreamDto({
      taskTitle: 'Broken',
      state: 'FAILED',
      failureKind: 'gate_failed',
      batchId: batch.id,
    });
    open(failed, [
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
    ]);

    await sessionRow('Broken');
    const region = screen.getByRole('region', { name: 'Real areas' });
    expect(
      await within(region).findByText(
        'Failed: Broken. The checks kept failing and the run ran out of fix attempts.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('says only what happened, with no Retry, while the failed run’s batch has not loaded', async () => {
    const failed = workstreamDto({
      taskTitle: 'Broken',
      state: 'FAILED',
      failureKind: 'gate_failed',
      batchId: mintId('Batch'),
    });
    open(failed, [http.get(daemonUrl('/projects/:projectId/batches'), () => delay('infinite'))]);

    await sessionRow('Broken');
    const region = screen.getByRole('region', { name: 'Real areas' });
    expect(
      within(region).getByText(
        'Failed: Broken. The checks kept failing and the run ran out of fix attempts.',
      ),
    ).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('names a task by its headline, and by its title when it has none', async () => {
    const withHeadline = workstreamDto({
      taskTitle: 'Replace src/greeting/hello.txt with a greeting that names the visitor',
      taskHeadline: 'Greet the visitor by name',
    });
    const without = workstreamDto({ taskTitle: 'Plain title only', taskHeadline: '' });
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [withHeadline.taskId, without.taskId] },
      { status: 'running' },
    );
    serve(
      goals(goalListDto(summary)),
      workstreams(withHeadline, without),
      tasksOf(
        taskDto({
          id: withHeadline.taskId,
          goalId: summary.goal.id,
          title: withHeadline.taskTitle,
          headline: 'Greet the visitor by name',
        }),
        taskDto({
          id: without.taskId,
          goalId: summary.goal.id,
          title: 'Plain title only',
          headline: '',
        }),
      ),
      digests([], summary.digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(await within(region).findByText('Greet the visitor by name')).toBeTruthy();
    expect(within(region).getByText('Plain title only')).toBeTruthy();
    expect(within(region).queryByText(/Replace src\/greeting/)).toBeNull();
  });

  it('links a goal task’s row to the Board with its drawer open and its goal as the filter', async () => {
    const ws = workstreamDto({ taskTitle: 'Alpha', state: 'RUNNING' });
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [ws.taskId] },
      { status: 'running' },
    );
    serve(
      goals(goalListDto(summary)),
      workstreams(ws),
      tasksOf(taskDto({ id: ws.taskId, title: 'Alpha', goalId: summary.goal.id })),
      digests([], summary.digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const link = await within(region).findByRole('link', { name: 'Alpha' });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.pathname).toBe('/board');
    expect(href.searchParams.get('task')).toBe(ws.taskId);
    expect(href.searchParams.get('goal')).toBe(summary.goal.id);
  });

  it('links a row of a task not in a goal to the Board with no goal', async () => {
    const loose = workstreamDto({ taskTitle: 'Loose run', state: 'RUNNING' });
    const ungrouped = ungroupedDto({
      workstreams: [
        {
          workstreamId: loose.id,
          taskId: loose.taskId,
          taskTitle: loose.taskTitle,
          state: loose.state,
        },
      ],
    });
    serve(goals({ ...goalListDto(), ungrouped }), workstreams(loose));
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Not in a goal/ }));
    const region = await screen.findByRole('region', { name: 'Not in a goal' });
    const link = await within(region).findByRole('link', { name: 'Loose run' });
    const href = new URL(link.getAttribute('href') ?? '', 'http://x');
    expect(href.searchParams.get('task')).toBe(loose.taskId);
    expect(href.searchParams.has('goal')).toBe(false);
  });

  it('goes to the Board when the row is clicked, and Retry stays in Factory', async () => {
    const failed = workstreamDto({ taskTitle: 'Broken', state: 'FAILED' });
    const retried: string[] = [];
    open(failed, [
      http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
        retried.push(String(params['id']));
        return HttpResponse.json({ ...failed, state: 'QUEUED' });
      }),
    ]);
    const row = await sessionRow('Broken');
    const region = screen.getByRole('region', { name: 'Real areas' });
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(retried).toEqual([failed.id]);
    });
    expect(screen.getByRole('region', { name: 'Real areas' })).toBeTruthy();

    fireEvent.click(within(row).getByText('Broken'));
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Real areas' })).toBeNull();
    });
  });

  it('shows a refused retry beside the Retry button', async () => {
    const failed = workstreamDto({ taskTitle: 'Broken', state: 'FAILED' });
    open(failed, [
      http.post(daemonUrl('/workstreams/:id/retry'), () =>
        HttpResponse.json({ error: 'conflict', message: 'not retryable now' }, { status: 409 }),
      ),
    ]);
    await sessionRow('Broken');
    const region = screen.getByRole('region', { name: 'Real areas' });
    fireEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('not retryable now')).toBeTruthy();
  });

  it.each(['WAITING_HUMAN', 'RUNNING', 'QUEUED'] as const)(
    'puts no Cancel on a %s task: a run is cancelled from its card or drawer',
    async (state) => {
      open(workstreamDto({ taskTitle: 'Alpha', state }));

      const row = await sessionRow('Alpha');
      expect(within(row).queryByRole('button')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    },
  );

  it('shows step, model and context on a running row only', async () => {
    const running = workstreamDto({
      taskTitle: 'Alpha',
      state: 'RUNNING',
      steps: [stepDto({ role: 'implement', model: 'sonnet' }), stepDto({ role: 'review' })],
      stepIndex: 0,
      contextPct: 34,
    });
    open(running);
    const row = await sessionRow('Alpha');
    expect(within(row).getByText('Implement 1/2 · sonnet')).toBeTruthy();
    expect(within(row).getByText('34%')).toBeTruthy();
  });

  it('shows a task’s state, its pull request once for a shared branch, and its last activity', async () => {
    const batch = batchDto({
      state: 'SHIPPED',
      title: 'Greetings',
      prUrl: 'https://github.com/acme/widgets/pull/9',
    });
    const a = workstreamDto({
      taskTitle: 'First',
      state: 'DONE',
      batchId: batch.id,
      lastActivityAt: hoursAgo(2),
    });
    const b = workstreamDto({ taskTitle: 'Second', state: 'DONE', batchId: batch.id });
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [a.taskId, b.taskId] },
      { status: 'idle' },
    );
    serve(
      goals(goalListDto(summary)),
      workstreams(a, b),
      tasksOf(
        taskDto({
          id: a.taskId,
          title: 'First',
          goalId: summary.goal.id,
          status: 'done',
          boardStatus: 'in_review',
        }),
        taskDto({
          id: b.taskId,
          title: 'Second',
          goalId: summary.goal.id,
          status: 'done',
          boardStatus: 'in_review',
        }),
      ),
      http.get(daemonUrl('/projects/:projectId/batches'), () => HttpResponse.json([batch])),
      digests([], summary.digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    const links = await within(region).findAllByRole('link', { name: 'Pull request' });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/9');
    expect(within(region).getAllByText('Shared branch')).toHaveLength(2);
    const first = (await within(region).findByText('First')).closest('[role="listitem"]');
    if (!(first instanceof HTMLElement)) throw new Error('First is not in a list row');
    expect(within(first).getByText(/^In review/)).toBeTruthy();
    expect(within(first).getByText('2 hours ago')).toBeTruthy();
  });

  it('tags the digest’s next task and counts what a waiting task waits on', async () => {
    const first = taskDto({ title: 'Ready one', boardStatus: 'ready' });
    const second = taskDto({
      title: 'Later one',
      boardStatus: 'backlog',
      dependsOn: [first.id],
    });
    const summary = goalSummaryDto(
      { title: 'Real areas', taskIds: [first.id, second.id] },
      {
        status: 'not_started',
        next: { taskId: first.id, title: 'Ready one', headline: 'Do the ready one', waitsOn: [] },
      },
    );
    serve(
      goals(goalListDto(summary)),
      tasksOf(
        { ...first, goalId: summary.goal.id, headline: 'Do the ready one' },
        { ...second, goalId: summary.goal.id },
      ),
      digests([], summary.digest),
    );
    renderApp('/factory');

    fireEvent.click(await screen.findByRole('button', { name: /^Real areas/ }));
    const region = await screen.findByRole('region', { name: 'Real areas' });
    expect(await within(region).findByText('Ready · next')).toBeTruthy();
    expect(within(region).getByText('Do the ready one')).toBeTruthy();
    expect(within(region).getByText('Waits on 1')).toBeTruthy();
  });

  it('lists a finished session without Cancel or Retry', async () => {
    const done = workstreamDto({
      taskTitle: 'Shipped',
      state: 'DONE',
      contextPct: null,
      lastActivityAt: null,
    });
    open(done, [], { boardStatus: 'done', status: 'done' });
    const row = await sessionRow('Shipped');
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(within(row).queryByRole('button')).toBeNull();
    // A finished task shows no step and no context gauge.
    expect(within(row).queryByRole('progressbar')).toBeNull();
    expect(within(row).queryByText(/\d\/\d/)).toBeNull();
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

function selfUpdateStatus(over: Partial<SelfUpdateStatusDto>): SelfUpdateStatusDto {
  return SelfUpdateStatusDto.parse({
    enabled: true,
    isDefault: true,
    runningCommit: '1'.repeat(40),
    availableCommit: '2'.repeat(40),
    waitMinutes: 15,
    waitingSince: '2026-11-03T12:00:00.000Z',
    draining: false,
    drainingSince: null,
    blocker: null,
    ...over,
  });
}

function selfUpdate(over: Partial<SelfUpdateStatusDto>): RequestHandler {
  return http.get(daemonUrl('/settings/self-update'), () =>
    HttpResponse.json(selfUpdateStatus(over)),
  );
}

describe('FactoryView waiting update', () => {
  it('says why lanes paused while the factory drains for an update, and since when', async () => {
    serve(selfUpdate({ draining: true, drainingSince: '2026-11-03T12:15:00.000Z' }));
    renderApp('/factory');

    const note = await screen.findByRole('status', { name: 'Update draining the factory' });
    expect(note.textContent).toMatch(/lanes are paused/i);
    expect(note.textContent).toMatch(/since 2026-11-03/);
    expect(note.textContent).toMatch(/2222222/);
    const link = within(note).getByRole('link', { name: 'Update settings' });
    expect(link.getAttribute('href')).toBe('/settings/updates');
  });

  it('says an update is waiting, and since when, while it only waits for an idle moment', async () => {
    serve(selfUpdate({}));
    renderApp('/factory');

    const note = await screen.findByRole('status', { name: 'Update waiting' });
    expect(note.textContent).toMatch(/waiting since 2026-11-03/);
    expect(note.textContent).toMatch(/2222222/);
    expect(note.textContent).toMatch(/15 minutes/);
    expect(note.textContent).not.toMatch(/lanes are paused/i);
    const link = within(note).getByRole('link', { name: 'Update settings' });
    expect(link.getAttribute('href')).toBe('/settings/updates');
    expect(screen.queryByRole('status', { name: 'Update draining the factory' })).toBeNull();
  });

  it('says one thing at a time: a drain, not the wait before it', async () => {
    serve(selfUpdate({ draining: true, drainingSince: '2026-11-03T12:15:00.000Z' }));
    renderApp('/factory');

    await screen.findByRole('status', { name: 'Update draining the factory' });
    expect(screen.queryByRole('status', { name: 'Update waiting' })).toBeNull();
  });

  it.each([
    ['main has no update', { availableCommit: null, waitingSince: null }],
    ['the build of an update is not staged yet', { waitingSince: null }],
    ['the switch is off', { enabled: false, isDefault: false, draining: true }],
  ])('says nothing while %s', async (_name, over) => {
    serve(selfUpdate(over));
    renderApp('/factory');

    await screen.findByRole('heading', { name: 'Factory' });
    expect(screen.queryByRole('status', { name: 'Update draining the factory' })).toBeNull();
    expect(screen.queryByRole('status', { name: 'Update waiting' })).toBeNull();
  });

  describe('on a view left open', () => {
    /**
     * Serves the status the test last set, and counts how often it was asked. The event stream never
     * opens: its opening refetches every query, which would show a change with no poll at all.
     */
    function statusThatChanges(first: Partial<SelfUpdateStatusDto>) {
      const served = { asked: 0, now: first, projectKnown: false };
      serve(
        http.get(daemonUrl('/settings/self-update'), () => {
          served.asked += 1;
          return HttpResponse.json(selfUpdateStatus(served.now));
        }),
        http.get(daemonUrl('/events/head'), () => delay('infinite')),
        http.get(daemonUrl('/projects/:projectId/goals'), () => {
          served.projectKnown = true;
          return HttpResponse.json({ goals: [], ungrouped: null });
        }),
      );
      return served;
    }

    /**
     * Opens the view and waits until it stops asking. It mounts again once the project is known, and
     * that mount asks for the status too, so a change made before then shows with no poll.
     */
    async function opened(served: ReturnType<typeof statusThatChanges>): Promise<void> {
      const { queryClient } = renderApp('/factory');
      await vi.waitFor(
        () => {
          expect(served.projectKnown).toBe(true);
          expect(queryClient.isFetching({ queryKey: ['self-update'] })).toBe(0);
        },
        { timeout: 10_000 },
      );
    }

    const NOTHING = { availableCommit: null, waitingSince: null };
    const DRAINING = { draining: true, drainingSince: '2026-11-03T12:15:00.000Z' };

    // The view polls by interval: the test moves that clock by hand and every other timer stays real.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows a drain that begins after it opened with no update', async () => {
      const served = statusThatChanges(NOTHING);
      await opened(served);
      expect(screen.queryByRole('status', { name: 'Update draining the factory' })).toBeNull();

      served.now = DRAINING;
      await vi.advanceTimersByTimeAsync(60_000);

      await screen.findByRole('status', { name: 'Update draining the factory' });
    });

    it('shows sooner that lanes paused for an update it already said was waiting', async () => {
      const served = statusThatChanges({});
      await opened(served);
      await screen.findByRole('status', { name: 'Update waiting' });

      served.now = DRAINING;
      await vi.advanceTimersByTimeAsync(15_000);

      await screen.findByRole('status', { name: 'Update draining the factory' });
    });

    it('stops looking with the switch off, where nothing waits or drains by itself', async () => {
      const served = statusThatChanges({ ...NOTHING, enabled: false, isDefault: false });
      await opened(served);
      const { asked } = served;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(served.asked).toBe(asked);
    });

    it('stops looking in a run from source, which never updates itself', async () => {
      const served = statusThatChanges({ ...NOTHING, runningCommit: null });
      await opened(served);
      const { asked } = served;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(served.asked).toBe(asked);
    });
  });
});

describe('FactoryView human-touch panel', () => {
  const day = (overrides: Partial<HumanTouchDayDto>): HumanTouchDayDto => ({
    day: '2026-11-03',
    permission: 0,
    question: 0,
    workstreamFailed: 0,
    flag: 0,
    proposal: 0,
    review: 0,
    check: 0,
    cards: 0,
    tasksRan: 0,
    cardsPerTask: null,
    waitingMinutes: 0,
    ...overrides,
  });

  function humanTouch(days: HumanTouchDayDto[]): RequestHandler {
    return http.get(daemonUrl('/projects/:projectId/human-touch'), () =>
      HttpResponse.json({ days }),
    );
  }

  it('shows each day with its cards by kind, cards per task and the minutes work waited', async () => {
    serve(
      goals(goalListDto()),
      humanTouch([
        day({
          day: '2026-11-03',
          permission: 15,
          question: 10,
          workstreamFailed: 19,
          flag: 14,
          proposal: 2,
          cards: 60,
          tasksRan: 24,
          cardsPerTask: 2.5,
          waitingMinutes: 137.4,
        }),
        day({ day: '2026-11-02' }),
      ]),
    );
    renderApp('/factory');

    const table = await screen.findByRole('table', { name: 'How often a person was needed' });
    const rows = within(table).getAllByRole('row');
    // The header and one row per day, today first.
    expect(rows).toHaveLength(3);
    const [busy, quiet] = rows.slice(1).map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((c) => c.textContent),
    );
    expect(busy).toEqual(['Nov 3', '15', '10', '19', '14', '2', '0', '0', '60', '2.5', '137 min']);
    // A day with no task running has no cards per task to show.
    expect(quiet).toEqual(['Nov 2', '0', '0', '0', '0', '0', '0', '0', '0', '–', '0 min']);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual([
      'Day',
      'Permission',
      'Question',
      'Workstream failed',
      'Other flag',
      'Proposal',
      'Review',
      'Check',
      'Cards',
      'Per task',
      'Waited',
    ]);
  });

  it('says so when the human-touch numbers cannot be loaded', async () => {
    serve(
      goals(goalListDto()),
      http.get(daemonUrl('/projects/:projectId/human-touch'), () =>
        HttpResponse.json({ error: 'internal', message: 'boom' }, { status: 500 }),
      ),
    );
    renderApp('/factory');

    expect(await screen.findByText("Couldn't load how often a person was needed")).toBeTruthy();
  });
});
