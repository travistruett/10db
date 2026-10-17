import type { WorkstreamDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, type RequestHandler, type WebSocketHandler } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';
import { workstreamDto } from '../../test/fixtures';

function serve(...overrides: (RequestHandler | WebSocketHandler)[]): void {
  server.use(
    ...baseHandlers(),
    eventStream.addEventListener('connection', () => undefined),
  );
  server.use(...overrides);
}

/** Answers GET /workstreams from two lists, chosen by the `active` query parameter. */
function workstreams(active: WorkstreamDto[], all: WorkstreamDto[] = active): RequestHandler {
  return http.get(daemonUrl('/workstreams'), ({ request }) =>
    HttpResponse.json(new URL(request.url).searchParams.get('active') === 'false' ? all : active),
  );
}

async function rowFor(title: string): Promise<HTMLElement> {
  const row = (await screen.findByText(title)).closest('tr');
  if (!row) throw new Error(`${title} is not in a table row`);
  return row;
}

describe('FactoryView', () => {
  it('lists active workstreams with state, context, sessions and last activity', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    serve(
      workstreams([
        workstreamDto({
          taskTitle: 'Alpha',
          state: 'RUNNING',
          contextPct: 42,
          sessionCount: 2,
          lastActivityAt: fiveMinutesAgo,
        }),
      ]),
    );
    renderApp('/factory');

    const row = await rowFor('Alpha');
    expect(within(row).getByText('Running')).toBeTruthy();
    expect(within(row).getByText('42%')).toBeTruthy();
    expect(within(row).getByRole('progressbar', { name: 'Context used' })).toBeTruthy();
    expect(within(row).getByText('2')).toBeTruthy();
    expect(within(row).getByText('5 minutes ago')).toBeTruthy();
  });

  it('says so when nothing is running', async () => {
    serve(workstreams([]));
    renderApp('/factory');
    expect(await screen.findByText('No workstreams are running.')).toBeTruthy();
  });

  it('shows a failed load as an error, not as an empty list', async () => {
    serve(
      http.get(daemonUrl('/workstreams'), () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    renderApp('/factory');
    expect(await screen.findByText("Couldn't load the workstreams")).toBeTruthy();
    expect(screen.queryByText('No workstreams are running.')).toBeNull();
  });

  it('cancels after confirmation', async () => {
    const ws = workstreamDto({ taskTitle: 'Alpha', state: 'WAITING_HUMAN' });
    const cancelled: string[] = [];
    serve(
      workstreams([ws]),
      http.post(daemonUrl('/workstreams/:id/cancel'), ({ params }) => {
        cancelled.push(String(params['id']));
        return HttpResponse.json({ ...ws, state: 'CANCELLED' });
      }),
    );
    renderApp('/factory');

    fireEvent.click(within(await rowFor('Alpha')).getByRole('button', { name: 'Cancel' }));
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

  it('offers Retry only on a failed workstream, and shows why it failed', async () => {
    const failed = workstreamDto({
      taskTitle: 'Broken',
      state: 'FAILED',
      failureReason: 'The gate failed 4 times (last exit 2)',
    });
    const running = workstreamDto({ taskTitle: 'Fine', state: 'RUNNING' });
    const retried: string[] = [];
    serve(
      workstreams([failed, running]),
      http.post(daemonUrl('/workstreams/:id/retry'), ({ params }) => {
        retried.push(String(params['id']));
        return HttpResponse.json({ ...failed, state: 'QUEUED' });
      }),
    );
    renderApp('/factory');

    const broken = await rowFor('Broken');
    expect(within(broken).getByText('The gate failed 4 times (last exit 2)')).toBeTruthy();
    expect(within(await rowFor('Fine')).queryByRole('button', { name: 'Retry' })).toBeNull();
    fireEvent.click(within(broken).getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(retried).toEqual([failed.id]);
    });
  });

  it('shows finished workstreams when asked', async () => {
    const done = workstreamDto({
      taskTitle: 'Shipped',
      state: 'DONE',
      contextPct: null,
      lastActivityAt: null,
    });
    serve(workstreams([], [done]));
    renderApp('/factory');

    expect(await screen.findByText('No workstreams are running.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show finished' }));
    const row = await rowFor('Shipped');
    expect(within(row).getByText('Done')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });
});
