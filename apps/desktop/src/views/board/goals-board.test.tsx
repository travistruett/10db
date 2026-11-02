import { mintId, PickerProposalDto, type GoalId, type TaskDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { candidate, projectViewDto, taskDto } from '../../test/fixtures';
import { goalCriterionDto, goalListDto, goalSummaryDto } from '../../test/goal-fixtures';

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
  { status: 'running', progress: { done: 1, total: 3, cancelled: [] } },
);
const farewells = goalSummaryDto(
  { ...inProject, title: 'Say farewell', taskIds: [bye.id] },
  { status: 'not_started', progress: { done: 0, total: 1, cancelled: [] } },
);
const cleanup = goalSummaryDto(
  { ...inProject, title: 'Tidy up', taskIds: [swept.id] },
  { status: 'done', progress: { done: 1, total: 1, cancelled: [] } },
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

async function openBoard() {
  renderApp('/board');
  return screen.findByTestId('board-above-columns');
}

describe('the Board with goals', () => {
  it('shows each goal with open tasks as one strip above the columns, and no goal as a card', async () => {
    serve();
    const above = await openBoard();
    const strips = within(above).getAllByRole('button');
    expect(strips.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Greet the visitor',
      'Say farewell',
    ]);
    // A strip says where the goal stands: "1 of 3 tasks" and the status dot's color and word.
    const strip = within(above).getByRole('button', { name: 'Greet the visitor' });
    expect(within(strip).getByText('1 of 3 tasks')).toBeTruthy();
    expect(within(strip).getByTestId('goal-dot').getAttribute('data-color')).toBe('blue');
    expect(
      within(within(above).getByRole('button', { name: 'Say farewell' }))
        .getByTestId('goal-dot')
        .getAttribute('data-color'),
    ).toBe('gray');
    // The finished goal has no open task, so no strip; and no goal sits among the task cards.
    expect(within(above).queryByText('Tidy up')).toBeNull();
    const columns = screen.getByTestId('board-columns');
    expect(within(columns).queryByRole('button', { name: 'Greet the visitor' })).toBeNull();
  });

  it('shows no strip area for a project with no goals', async () => {
    serve(
      http.get(daemonUrl('/projects/:projectId/goals'), () => HttpResponse.json(goalListDto())),
    );
    renderApp('/board');
    await screen.findByRole('button', { name: 'Fix a typo' });
    expect(screen.queryByTestId('board-above-columns')).toBeNull();
  });

  it('puts the goal title on its tasks’ cards and leaves a task with no goal bare', async () => {
    serve();
    renderApp('/board');
    await screen.findByRole('button', { name: 'Fix a typo' });
    // Five of the six cards belong to a goal; the sixth ("Fix a typo") has none, so it has no label.
    expect(screen.getAllByTestId('task-card')).toHaveLength(6);
    expect(screen.getAllByTestId('task-card-goal').map((n) => n.textContent)).toEqual([
      'Greet the visitor',
      'Greet the visitor',
      'Say farewell',
      'Greet the visitor',
      'Tidy up',
    ]);
  });

  describe('the goal drawer', () => {
    const criterion = goalCriterionDto(greetings.goal.id, {
      text: 'The greeting names the visitor',
    });
    const detailed = {
      ...greetings,
      goal: { ...greetings.goal, criteria: [criterion] },
      digest: {
        ...greetings.digest,
        waitingOn: {
          recent: [
            {
              inboxItemId: mintId('InboxItem'),
              taskId: named.id,
              title: 'Which name format?',
              assigneeId: null,
              assigneeName: 'You',
              at: '2026-10-31T12:00:00.000Z',
            },
          ],
          earlier: [],
        },
      },
    };

    it('opens on a click with the objective, criteria, tasks and what blocks it', async () => {
      serve(
        http.get(daemonUrl('/projects/:projectId/goals'), () =>
          HttpResponse.json(goalListDto(detailed, farewells)),
        ),
      );
      const above = await openBoard();
      fireEvent.click(within(above).getByRole('button', { name: 'Greet the visitor' }));
      const drawer = await screen.findByRole('dialog', { name: 'Goal' });
      expect(within(drawer).getByText('Greet the visitor')).toBeTruthy();
      expect(within(drawer).getByText('Every visitor is greeted by name.')).toBeTruthy();
      // Criteria are read-only text, not inputs.
      expect(within(drawer).getByText('The greeting names the visitor')).toBeTruthy();
      expect(within(drawer).queryAllByRole('checkbox')).toEqual([]);
      for (const title of ['Say hello', 'Name the visitor', 'Pick a greeting']) {
        expect(within(drawer).getByText(title)).toBeTruthy();
      }
      expect(within(drawer).queryByText('Say goodbye')).toBeNull();
      expect(within(drawer).getByText('Which name format?')).toBeTruthy();
    });

    it('says nothing blocks a goal with no card and no failed task', async () => {
      serve();
      const above = await openBoard();
      fireEvent.click(within(above).getByRole('button', { name: 'Greet the visitor' }));
      const drawer = await screen.findByRole('dialog', { name: 'Goal' });
      expect(within(drawer).getByText('Nothing is blocking this goal.')).toBeTruthy();
    });

    it('starts only that goal’s ready tasks from Start Ready Tasks', async () => {
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
      const above = await openBoard();
      fireEvent.click(within(above).getByRole('button', { name: 'Greet the visitor' }));
      const drawer = await screen.findByRole('dialog', { name: 'Goal' });
      fireEvent.click(within(drawer).getByRole('button', { name: 'Start Ready Tasks…' }));
      const sheet = await screen.findByRole('dialog', { name: 'Start a batch' });
      expect(await within(sheet).findByRole('checkbox', { name: 'Say hello' })).toBeTruthy();
      expect(within(sheet).getByText(/Greet the visitor/)).toBeTruthy();
      expect(asked).toEqual([greetings.goal.id]);
    });

    it('offers no Start Ready Tasks when none of the goal’s tasks is ready', async () => {
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
      const above = await openBoard();
      fireEvent.click(within(above).getByRole('button', { name: 'Greet the visitor' }));
      const drawer = await screen.findByRole('dialog', { name: 'Goal' });
      expect(within(drawer).getByRole('button', { name: 'Start Ready Tasks…' })).toHaveProperty(
        'disabled',
        true,
      );
    });
  });

  describe('the goal filter', () => {
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
});
