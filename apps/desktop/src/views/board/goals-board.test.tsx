import { PickerProposalDto, type GoalId, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { candidate, projectViewDto, taskDto } from '../../test/fixtures';
import { goalDigestDto, goalListDto, goalSummaryDto } from '../../test/goal-fixtures';

const project = projectViewDto({ gateCommand: null, maxLanes: 2 });
const inProject = { projectId: project.id } as const;

// Greetings: two open tasks and one done. Farewells: one open task. Cleanup: every task done.
const hello = taskDto({ ...inProject, title: 'Say hello', boardOrder: 1 });
const named = taskDto({ ...inProject, title: 'Name the visitor', boardOrder: 2 });
const shipped = taskDto({
  ...inProject,
  title: 'Pick a greeting',
  status: 'done',
  boardStatus: 'done',
});
const bye = taskDto({ ...inProject, title: 'Say goodbye', boardOrder: 3 });
const swept = taskDto({
  ...inProject,
  title: 'Sweep the floor',
  status: 'done',
  boardStatus: 'done',
});
const loose = taskDto({ ...inProject, title: 'Fix a typo', boardOrder: 4 });

const greetings = goalSummaryDto(
  {
    ...inProject,
    title: 'Greet the visitor',
    objective: 'Every visitor is greeted by name.',
    taskIds: [hello.id, named.id, shipped.id],
  },
  { status: 'running', progress: { merged: 1, inReview: 1, total: 3, cancelled: [] } },
);
const farewells = goalSummaryDto(
  { ...inProject, title: 'Say farewell', taskIds: [bye.id] },
  { status: 'not_started', progress: { merged: 0, inReview: 0, total: 1, cancelled: [] } },
);
const cleanup = goalSummaryDto(
  { ...inProject, title: 'Tidy up', taskIds: [swept.id] },
  { status: 'done', progress: { merged: 1, inReview: 0, total: 1, cancelled: [] } },
);

const withGoal = (task: TaskDto, goalId: GoalId): TaskDto => ({ ...task, goalId });
const tasks = [
  withGoal(hello, greetings.goal.id),
  withGoal(named, greetings.goal.id),
  withGoal(shipped, greetings.goal.id),
  withGoal(bye, farewells.goal.id),
  withGoal(swept, cleanup.goal.id),
  loose,
];

function serve(...overrides: RequestHandler[]): void {
  server.use(
    ...overrides,
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    http.get(daemonUrl('/projects/:projectId/goals'), () =>
      HttpResponse.json(goalListDto(greetings, farewells, cleanup)),
    ),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
}

async function chooseGoal(name: string) {
  // The label also names the option list, so take the field itself.
  const input = (await screen.findAllByLabelText('Goal')).find((el) => el.tagName === 'INPUT');
  if (!input) throw new Error('no goal filter');
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    expect(el).not.toBeNull();
    return el ?? document.body;
  });
  fireEvent.click(within(list).getByRole('option', { name, hidden: true }));
}

describe('the Board with goals', () => {
  it('has no goal strip rows and no goal drawer, and no goal sits among the cards', async () => {
    serve();
    renderApp('/board');
    await screen.findByRole('button', { name: 'Fix a typo' });
    expect(screen.queryByTestId('board-above-columns')).toBeNull();
    expect(screen.queryByTestId('goal-strip')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Goal' })).toBeNull();
    const columns = screen.getByTestId('board-columns');
    expect(within(columns).queryByRole('button', { name: 'Greet the visitor' })).toBeNull();
  });

  it('puts the goal title in a badge on its tasks’ cards and leaves a task with no goal bare', async () => {
    serve();
    renderApp('/board');
    await screen.findByRole('button', { name: 'Fix a typo' });
    // Five of the six cards belong to a goal; the sixth ("Fix a typo") has none, so it has no badge.
    expect(screen.getAllByTestId('task-card')).toHaveLength(6);
    expect(screen.getAllByTestId('indicator-goal').map((n) => n.textContent)).toEqual([
      'Greet the visitor',
      'Greet the visitor',
      'Say farewell',
      'Greet the visitor',
      'Tidy up',
    ]);
  });

  it('shows no goal badge while the Goal filter selects a goal', async () => {
    serve();
    renderApp(`/board?goal=${greetings.goal.id}`);
    await screen.findByRole('button', { name: 'Say hello' });
    expect(screen.queryByRole('button', { name: 'Say farewell' })).toBeNull();
    expect(screen.queryByTestId('indicator-goal')).toBeNull();
  });

  describe('the goal filter', () => {
    it('shows only the chosen goal’s tasks, and every task again once cleared', async () => {
      serve();
      renderApp('/board');
      await screen.findByRole('button', { name: 'Fix a typo' });
      await chooseGoal('Say farewell');
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Fix a typo' })).toBeNull();
      });
      expect(screen.getByRole('button', { name: 'Say goodbye' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Say hello' })).toBeNull();

      await chooseGoal('All goals');
      expect(await screen.findByRole('button', { name: 'Fix a typo' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Say hello' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Say goodbye' })).toBeTruthy();
    });

    it('is absent when the project has no goals', async () => {
      serve(
        http.get(daemonUrl('/projects/:projectId/goals'), () => HttpResponse.json(goalListDto())),
      );
      renderApp('/board');
      await screen.findByRole('button', { name: 'Fix a typo' });
      expect(screen.queryByLabelText('Goal')).toBeNull();
    });
  });

  describe('the chosen goal’s line', () => {
    it('shows nothing while All goals is selected', async () => {
      serve();
      renderApp('/board');
      await screen.findByRole('button', { name: 'Fix a typo' });
      expect(screen.queryByTestId('goal-line')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start Ready…' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Open in Factory/ })).toBeNull();
    });

    it('says the goal’s status and counts once one is chosen, and drops away when cleared', async () => {
      serve();
      renderApp('/board');
      await screen.findByRole('button', { name: 'Fix a typo' });
      await chooseGoal('Greet the visitor');
      const line = await screen.findByTestId('goal-line');
      // Running, one task in review (the digest) and two in Ready (the board's tasks).
      expect(line.textContent).toContain('Running · 1 in review · 2 ready');
      expect(within(line).getByTestId('goal-dot').getAttribute('data-color')).toBe('blue');
      expect(within(line).getByRole('button', { name: 'Start Ready…' })).toBeTruthy();
      expect(within(line).getByRole('button', { name: /^Open in Factory/ })).toBeTruthy();

      await chooseGoal('All goals');
      await waitFor(() => {
        expect(screen.queryByTestId('goal-line')).toBeNull();
      });
    });

    it('also shows for a goal chosen by a link', async () => {
      serve();
      renderApp(`/board?goal=${farewells.goal.id}`);
      const line = await screen.findByTestId('goal-line');
      expect(line.textContent).toContain('Not started · 1 ready');
      expect(line.textContent).not.toContain('in review');
    });

    it('starts only that goal’s ready tasks from Start Ready…', async () => {
      const asked: (string | null)[] = [];
      serve(
        http.get(daemonUrl('/projects/:projectId/candidates'), ({ request }) => {
          const url = new URL(request.url);
          asked.push(url.searchParams.get('goalId'));
          return HttpResponse.json(
            PickerProposalDto.parse({
              projectId: project.id,
              size: Number(url.searchParams.get('size')),
              candidates: [candidate(withGoal(hello, greetings.goal.id))],
            }),
          );
        }),
      );
      renderApp(`/board?goal=${greetings.goal.id}`);
      const line = await screen.findByTestId('goal-line');
      fireEvent.click(within(line).getByRole('button', { name: 'Start Ready…' }));
      const sheet = await screen.findByRole('dialog', { name: 'Start a batch' });
      expect(await within(sheet).findByRole('checkbox', { name: 'Say hello' })).toBeTruthy();
      expect(within(sheet).getByText(/Greet the visitor/)).toBeTruthy();
      expect(asked).toEqual([greetings.goal.id]);
    });

    it('disables Start Ready… when none of the goal’s tasks is ready', async () => {
      serve(
        http.get(daemonUrl('/projects/:projectId/tasks'), () =>
          HttpResponse.json(
            tasks.map((t) =>
              t.id === hello.id
                ? { ...t, boardStatus: 'backlog' }
                : t.id === named.id
                  ? { ...t, boardStatus: 'in_progress' }
                  : t,
            ),
          ),
        ),
      );
      renderApp(`/board?goal=${greetings.goal.id}`);
      const line = await screen.findByTestId('goal-line');
      expect(line.textContent).not.toContain('ready');
      expect(within(line).getByRole('button', { name: 'Start Ready…' })).toHaveProperty(
        'disabled',
        true,
      );
    });

    it('opens Factory with that goal expanded from Open in Factory', async () => {
      const opened: string[] = [];
      serve(
        http.get(daemonUrl('/goals/:goalId/digest'), ({ params }) => {
          opened.push(String(params['goalId']));
          return HttpResponse.json(goalDigestDto(farewells.goal.id, farewells.digest));
        }),
      );
      renderApp('/board');
      await screen.findByRole('button', { name: 'Fix a typo' });
      await chooseGoal('Say farewell');
      const line = await screen.findByTestId('goal-line');
      fireEvent.click(within(line).getByRole('button', { name: /^Open in Factory/ }));
      const row = await screen.findByRole('button', { name: /^Say farewell/ });
      await waitFor(() => {
        expect(row.getAttribute('aria-expanded')).toBe('true');
      });
      expect(await screen.findByRole('region', { name: 'Say farewell' })).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Factory' })).toBeTruthy();
      expect(opened).toEqual([farewells.goal.id]);
    });
  });
});
