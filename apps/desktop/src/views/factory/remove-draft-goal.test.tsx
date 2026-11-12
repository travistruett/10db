import {
  mintId,
  type GoalId,
  type GoalStatus,
  type GoalSummaryDto,
  type ShapeId,
  type TaskDto,
} from '@10db/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto, taskDto } from '../../test/fixtures';
import { goalDigestDto, goalListDto, goalSummaryDto } from '../../test/goal-fixtures';

// Shape spec §11: Remove Draft Goal is in a goal's menu and drawer, for a goal a conversation made
// while none of its tasks has started. The Board's goal line carries the menu; the goal's detail
// (Factory's drawer) carries the button. Both open the confirm the Shape row opens.

const project = projectViewDto({ gateCommand: null, maxLanes: 2 });
const inProject = { projectId: project.id } as const;
const shapeId = mintId('Shape');

/** Every goal is a draft: only the insert writes a goal's state, so its status says how far it got. */
function goalAt(
  title: string,
  status: GoalStatus,
  taskIds: GoalSummaryDto['goal']['taskIds'] = [],
) {
  return goalSummaryDto(
    { ...inProject, title, state: 'draft', taskIds },
    { status, progress: { merged: 0, inReview: 0, total: 2, cancelled: [] } },
  );
}

const firstTask = mintId('Task');
const draft = goalAt('Greet the visitor', 'not_started', [firstTask]);
const greeting = taskDto({
  ...inProject,
  id: firstTask,
  goalId: draft.goal.id,
  title: 'Write the greeting',
});
const looseTask = taskDto({ ...inProject, title: 'Fix a typo' });

interface Daemon {
  /** The goals the daemon was asked to remove. */
  readonly removed: GoalId[];
  /** The goals whose conversation lookup reached the daemon. */
  readonly lookups: string[];
}

/** A daemon holding these goals: removing one takes the goal and its tasks out of what it answers. */
function serve(
  madeBy: Record<string, ShapeId | null>,
  goals: readonly GoalSummaryDto[] = [draft],
): Daemon {
  const daemon: Daemon = { removed: [], lookups: [] };
  let summaries = [...goals];
  let tasks: TaskDto[] = [greeting, looseTask];
  server.use(
    http.post(daemonUrl('/goals/:goalId/remove-draft'), ({ params }) => {
      const goalId = String(params['goalId']);
      daemon.removed.push(goalId as GoalId);
      summaries = summaries.filter((s) => s.goal.id !== goalId);
      tasks = tasks.filter((t) => t.goalId !== goalId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(daemonUrl('/goals/:goalId/shape'), ({ params }) => {
      const goalId = String(params['goalId']);
      daemon.lookups.push(goalId);
      return HttpResponse.json({ shapeId: madeBy[goalId] ?? null });
    }),
    http.get(daemonUrl('/goals/:goalId/digest'), ({ params }) => {
      const found = goals.find((s) => s.goal.id === params['goalId']);
      return HttpResponse.json(goalDigestDto(found?.goal.id ?? draft.goal.id, found?.digest));
    }),
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json(tasks)),
    http.get(daemonUrl('/projects/:projectId/goals'), () =>
      HttpResponse.json(goalListDto(...summaries)),
    ),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
  return daemon;
}

/** Waits until the view holds the lookup's answer: only then does an absence say anything. */
async function lookupAnswered(daemon: Daemon, queryClient: QueryClient, summary: GoalSummaryDto) {
  await waitFor(() => {
    expect(daemon.lookups).toContain(summary.goal.id);
    expect(queryClient.getQueryState(['shapes', 'of', summary.goal.id])?.status).toBe('success');
  });
}

/** Opens the goal the way the Board's Open in Factory does, which also reaches a done goal's row. */
async function openInFactory(summary: GoalSummaryDto) {
  const { queryClient } = renderApp(`/factory?goal=${summary.goal.id}`);
  const region = await screen.findByRole('region', { name: summary.goal.title });
  return { queryClient, region };
}

describe('Remove Draft Goal in the goal’s detail', () => {
  it('offers it for a draft goal a conversation made, behind the same confirm as the Shape row', async () => {
    const daemon = serve({ [draft.goal.id]: shapeId });
    const { region } = await openInFactory(draft);

    fireEvent.click(await within(region).findByRole('button', { name: 'Remove Draft Goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Draft Goal' });
    expect(dialog.textContent).toContain('Remove the draft goal “Greet the visitor”?');
    expect(dialog.textContent).toContain('the goal returns to Proposed');
    // Nothing is removed until the confirm.
    expect(daemon.removed).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Draft Goal' }));
    await waitFor(() => {
      expect(daemon.removed).toEqual([draft.goal.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Remove Draft Goal' })).toBeNull();
    });
    // The goal's row goes as soon as the removal lands, with no event to say so.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /^Greet the visitor/ })).toBeNull();
    });
  });

  it('offers nothing and explains nothing for a goal no conversation made', async () => {
    const daemon = serve({});
    const { queryClient, region } = await openInFactory(draft);
    await lookupAnswered(daemon, queryClient, draft);
    expect(within(region).queryByRole('button', { name: 'Remove Draft Goal' })).toBeNull();
    expect(within(region).queryByText(/Remove Draft Goal needs/)).toBeNull();
  });

  it.each<GoalStatus>(['queued', 'running', 'failed', 'waiting_on_you', 'idle'])(
    'says why it is not offered for a %s goal a conversation made',
    async (status) => {
      const goal = goalAt('Say farewell', status);
      serve({ [goal.goal.id]: shapeId }, [goal]);
      const { region } = await openInFactory(goal);
      const why = await within(region).findByText(
        'Remove Draft Goal needs every task unstarted; a task of this goal has started.',
      );
      expect(why).toBeTruthy();
      expect(within(region).queryByRole('button', { name: 'Remove Draft Goal' })).toBeNull();
    },
  );

  it.each<GoalStatus>(['shipping', 'done'])(
    'says nothing about it for a %s goal a conversation made, whose work is finished',
    async (status) => {
      const goal = goalAt('Say farewell', status);
      const daemon = serve({ [goal.goal.id]: shapeId }, [goal]);
      const { queryClient, region } = await openInFactory(goal);
      await lookupAnswered(daemon, queryClient, goal);
      await within(region).findByRole('button', { name: 'Open conversation' });
      expect(within(region).queryByRole('button', { name: 'Remove Draft Goal' })).toBeNull();
      expect(within(region).queryByText(/Remove Draft Goal needs/)).toBeNull();
    },
  );
});

describe('Remove Draft Goal in the Board’s goal menu', () => {
  it('is in the goal line’s menu for a draft goal a conversation made', async () => {
    const daemon = serve({ [draft.goal.id]: shapeId });
    renderApp(`/board?goal=${draft.goal.id}`);
    const line = await screen.findByTestId('goal-line');
    await screen.findByRole('button', { name: 'Write the greeting' });
    fireEvent.click(await within(line).findByRole('button', { name: 'More goal actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove Draft Goal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Draft Goal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Draft Goal' }));
    await waitFor(() => {
      expect(daemon.removed).toEqual([draft.goal.id]);
    });
    // The goal line and the goal's card go as soon as the removal lands, with no event to say so.
    await waitFor(() => {
      expect(screen.queryByTestId('goal-line')).toBeNull();
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Write the greeting' })).toBeNull();
    });
  });

  it('has no goal menu for a goal no conversation made', async () => {
    const daemon = serve({});
    const { queryClient } = renderApp(`/board?goal=${draft.goal.id}`);
    const line = await screen.findByTestId('goal-line');
    await lookupAnswered(daemon, queryClient, draft);
    expect(within(line).queryByRole('button', { name: 'More goal actions' })).toBeNull();
  });

  it('has no goal menu for a goal that has started', async () => {
    const tried = goalAt('Tidy up', 'idle');
    const daemon = serve({ [tried.goal.id]: shapeId }, [tried]);
    const { queryClient } = renderApp(`/board?goal=${tried.goal.id}`);
    const line = await screen.findByTestId('goal-line');
    await lookupAnswered(daemon, queryClient, tried);
    expect(within(line).queryByRole('button', { name: 'More goal actions' })).toBeNull();
  });
});
