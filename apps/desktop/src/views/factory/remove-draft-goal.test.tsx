import { mintId, type GoalSummaryDto, type ShapeId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
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

const draft = goalSummaryDto(
  { ...inProject, title: 'Greet the visitor', state: 'draft', taskIds: [] },
  { status: 'not_started', progress: { merged: 0, inReview: 0, total: 2, cancelled: [] } },
);
const running = goalSummaryDto(
  { ...inProject, title: 'Say farewell', state: 'running', taskIds: [] },
  { status: 'running', progress: { merged: 0, inReview: 0, total: 2, cancelled: [] } },
);
// A draft whose task has run: its state has not moved, but its status has.
const tried = goalSummaryDto(
  { ...inProject, title: 'Tidy up', state: 'draft', taskIds: [] },
  { status: 'idle', progress: { merged: 0, inReview: 0, total: 2, cancelled: [] } },
);

function serve(madeBy: Record<string, ShapeId | null>, ...overrides: RequestHandler[]): void {
  const summaries: GoalSummaryDto[] = [draft, running, tried];
  server.use(
    ...overrides,
    http.get(daemonUrl('/goals/:goalId/shape'), ({ params }) =>
      HttpResponse.json({ shapeId: madeBy[String(params['goalId'])] ?? null }),
    ),
    http.get(daemonUrl('/goals/:goalId/digest'), ({ params }) => {
      const found = summaries.find((s) => s.goal.id === params['goalId']);
      return HttpResponse.json(goalDigestDto(found?.goal.id ?? draft.goal.id, found?.digest));
    }),
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/tasks'), () =>
      HttpResponse.json([taskDto({ ...inProject, title: 'Fix a typo' })]),
    ),
    http.get(daemonUrl('/projects/:projectId/goals'), () =>
      HttpResponse.json(goalListDto(...summaries)),
    ),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    ...baseHandlers(),
  );
}

describe('Remove Draft Goal in the goal’s detail', () => {
  it('offers it for a draft goal a conversation made, behind the same confirm as the Shape row', async () => {
    const removed: string[] = [];
    serve(
      { [draft.goal.id]: shapeId },
      http.post(daemonUrl('/goals/:goalId/remove-draft'), ({ params }) => {
        removed.push(String(params['goalId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp('/factory');
    fireEvent.click(await screen.findByRole('button', { name: /^Greet the visitor/ }));
    const region = await screen.findByRole('region', { name: 'Greet the visitor' });

    fireEvent.click(await within(region).findByRole('button', { name: 'Remove Draft Goal…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Draft Goal' });
    expect(dialog.textContent).toContain('Remove the draft goal “Greet the visitor”?');
    expect(dialog.textContent).toContain('the goal returns to Proposed');
    // Nothing is removed until the confirm.
    expect(removed).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Draft Goal' }));
    await waitFor(() => {
      expect(removed).toEqual([draft.goal.id]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Remove Draft Goal' })).toBeNull();
    });
  });

  it('offers nothing for a goal no conversation made', async () => {
    serve({});
    renderApp('/factory');
    fireEvent.click(await screen.findByRole('button', { name: /^Greet the visitor/ }));
    const region = await screen.findByRole('region', { name: 'Greet the visitor' });
    // The conversation lookup has answered once the Open conversation button is absent and settled.
    await waitFor(() => {
      expect(within(region).queryByRole('button', { name: 'Remove Draft Goal…' })).toBeNull();
    });
  });

  it('offers nothing once a task has run, and says why', async () => {
    serve({ [tried.goal.id]: shapeId, [running.goal.id]: shapeId });
    renderApp('/factory');
    fireEvent.click(await screen.findByRole('button', { name: /^Tidy up/ }));
    const region = await screen.findByRole('region', { name: 'Tidy up' });
    expect(
      await within(region).findByText(/Remove Draft Goal needs every task unstarted/),
    ).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Remove Draft Goal…' })).toBeNull();
  });

  it('offers nothing for a goal that is no longer a draft', async () => {
    serve({ [running.goal.id]: shapeId });
    renderApp('/factory');
    fireEvent.click(await screen.findByRole('button', { name: /^Say farewell/ }));
    const region = await screen.findByRole('region', { name: 'Say farewell' });
    await within(region).findByRole('button', { name: 'Open conversation' });
    expect(within(region).queryByRole('button', { name: 'Remove Draft Goal…' })).toBeNull();
  });
});

describe('Remove Draft Goal in the Board’s goal menu', () => {
  it('is in the goal line’s menu for a draft goal a conversation made', async () => {
    const removed: string[] = [];
    serve(
      { [draft.goal.id]: shapeId },
      http.post(daemonUrl('/goals/:goalId/remove-draft'), ({ params }) => {
        removed.push(String(params['goalId']));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp(`/board?goal=${draft.goal.id}`);
    const line = await screen.findByTestId('goal-line');
    fireEvent.click(await within(line).findByRole('button', { name: 'More goal actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove Draft Goal…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove Draft Goal' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Draft Goal' }));
    await waitFor(() => {
      expect(removed).toEqual([draft.goal.id]);
    });
  });

  it('has no goal menu for a goal that has started', async () => {
    serve({ [tried.goal.id]: shapeId });
    renderApp(`/board?goal=${tried.goal.id}`);
    const line = await screen.findByTestId('goal-line');
    // Let the conversation lookup settle before asserting an absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(within(line).queryByRole('button', { name: 'More goal actions' })).toBeNull();
  });
});
