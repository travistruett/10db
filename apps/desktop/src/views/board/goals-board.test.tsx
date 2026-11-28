import { toTaskRow, type GoalId, type TaskDto } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto, taskDto } from '../../test/fixtures';
import { goalListDto, goalSummaryDto } from '../../test/goal-fixtures';

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

describe('the Board with goals', () => {
  it('puts the goal title in a badge on its tasks’ cards and leaves a task with no goal bare', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
      http.get(daemonUrl('/projects/:projectId/tasks'), () =>
        HttpResponse.json(tasks.map(toTaskRow)),
      ),
      http.get(daemonUrl('/projects/:projectId/goals'), () =>
        HttpResponse.json(goalListDto(greetings, farewells, cleanup)),
      ),
      ...baseHandlers(),
    );
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
});
