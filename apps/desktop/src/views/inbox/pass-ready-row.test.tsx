import { PassSignOffDto, TaskId } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import {
  baseHandlers,
  daemonUrl,
  renderWithDaemon,
  renderWithDaemonAndRouter,
  server,
} from '../../test/daemon';
import { pagesByStatus, passViewDto, readyItem } from '../../test/pass-fixtures';
import { PassReadyRow } from './pass-ready-row';

describe('PassReadyRow', () => {
  it("signs off the page whose Sign Off is clicked, naming that page's pass and task", async () => {
    const sent: { passId: string; taskId: string }[] = [];
    server.use(
      http.post(daemonUrl('/passes/:passId/tasks/:taskId/sign-off'), ({ params }) => {
        const taskId = TaskId.parse(params['taskId']);
        sent.push({ passId: String(params['passId']), taskId });
        return HttpResponse.json(
          PassSignOffDto.parse({ taskId, state: 'signing_off', waitsFor: null }),
          { status: 202 },
        );
      }),
      ...baseHandlers(),
    );
    const { ready, asks } = pagesByStatus();
    const people = { ...asks, state: ready.state, turn: ready.turn };
    const view = passViewDto({ pages: [ready, people] });
    const items = [readyItem(view, ready), readyItem(view, people)] as const;
    renderWithDaemon(<PassReadyRow items={items} selected onSelect={vi.fn()} />);
    const row = (await screen.findByText(items[1].title)).closest('li');
    if (row === null) throw new Error('The page is not listed');
    fireEvent.click(within(row).getByRole('button', { name: 'Sign Off' }));
    await waitFor(() => {
      expect(sent).toEqual([{ passId: view.pass.id, taskId: people.taskId }]);
    });
  });

  it("opens the Workbench in the pass's project, at a page when its title is clicked", async () => {
    server.use(...baseHandlers());
    window.localStorage.removeItem('tendb.project');
    const { ready, asks } = pagesByStatus();
    const people = { ...asks, state: ready.state, turn: ready.turn };
    const view = passViewDto({ pages: [ready, people] });
    const items = [readyItem(view, ready), readyItem(view, people)] as const;
    const { router } = await renderWithDaemonAndRouter(
      <PassReadyRow items={items} selected onSelect={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Workbench' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench');
    });
    expect(JSON.parse(window.localStorage.getItem('tendb.project') ?? 'null')).toBe(
      items[0].projectId,
    );
    fireEvent.click(screen.getByRole('button', { name: items[1].title }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: people.taskId });
    });
  });
});
