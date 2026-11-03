import type { ShapeViewDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectViewDto, taskDto } from '../../test/fixtures';
import { goalListDto, goalSummaryDto } from '../../test/goal-fixtures';
import { shapeDto, shapeViewDto } from '../../test/shape-fixtures';

// Shape spec §12: a goal's and a task's drawer offer Open conversation when a conversation made them,
// and it opens that conversation in the Shape view. Work filed by hand has none.

const project = projectViewDto({ gateCommand: null });

function conversation(): ShapeViewDto {
  return shapeViewDto({ shape: shapeDto({ projectId: project.id, state: 'converted', round: 1 }) });
}

function serve(view: ShapeViewDto, ...overrides: RequestHandler[]): void {
  server.use(
    http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
    http.get(daemonUrl('/flows'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/board-columns'), () => HttpResponse.json([])),
    http.get(daemonUrl('/projects/:projectId/shapes'), () => HttpResponse.json([view.shape])),
    http.get(daemonUrl('/shapes/:shapeId'), () => HttpResponse.json(view)),
    ...overrides,
    ...baseHandlers(),
  );
}

describe('Open conversation, in a task’s drawer', () => {
  it('opens the conversation that made the task in the Shape view', async () => {
    const view = conversation();
    const task = taskDto({ projectId: project.id, title: 'Compact density' });
    serve(
      view,
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
      http.get(daemonUrl('/tasks/:taskId/shape'), ({ params }) =>
        HttpResponse.json({ shapeId: params['taskId'] === task.id ? view.shape.id : null }),
      ),
    );
    const { router } = renderApp(`/board?task=${task.id}`);
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Open conversation' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
    });
  });

  it('is not offered for a task filed by hand', async () => {
    const task = taskDto({ projectId: project.id, title: 'By hand' });
    let asked = false;
    serve(
      conversation(),
      http.get(daemonUrl('/projects/:projectId/tasks'), () => HttpResponse.json([task])),
      http.get(daemonUrl('/tasks/:taskId/shape'), () => {
        asked = true;
        return HttpResponse.json({ shapeId: null });
      }),
    );
    renderApp(`/board?task=${task.id}`);
    const drawer = await screen.findByRole('dialog', { name: 'Task' });
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(within(drawer).queryByRole('button', { name: 'Open conversation' })).toBeNull();
  });
});

describe('Open conversation, in a goal in Factory', () => {
  /** Serves one goal, made by the conversation or not; `asked` turns true once the drawer asked. */
  function serveGoal(madeByConversation: boolean) {
    const view = conversation();
    const summary = goalSummaryDto({ projectId: project.id, title: 'Real areas' });
    const lookup = { asked: false };
    serve(
      view,
      http.get(daemonUrl('/projects/:projectId/goals'), () =>
        HttpResponse.json(goalListDto(summary)),
      ),
      http.get(daemonUrl('/goals/:goalId/digest'), () => HttpResponse.json(summary.digest)),
      http.get(daemonUrl('/goals/:goalId/shape'), ({ params }) => {
        lookup.asked = true;
        return HttpResponse.json({
          shapeId:
            madeByConversation && params['goalId'] === summary.goal.id ? view.shape.id : null,
        });
      }),
    );
    return { view, summary, lookup };
  }

  it('opens the conversation that made the goal in the Shape view', async () => {
    const { view, summary } = serveGoal(true);
    const { router } = renderApp(`/factory?goal=${summary.goal.id}`);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    fireEvent.click(await within(region).findByRole('button', { name: 'Open conversation' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/shape/${view.shape.id}`);
    });
  });

  it('is not offered for a goal no conversation made', async () => {
    const { summary, lookup } = serveGoal(false);
    renderApp(`/factory?goal=${summary.goal.id}`);
    const region = await screen.findByRole('region', { name: 'Real areas' });
    await waitFor(() => {
      expect(lookup.asked).toBe(true);
    });
    expect(within(region).queryByRole('button', { name: 'Open conversation' })).toBeNull();
  });
});
