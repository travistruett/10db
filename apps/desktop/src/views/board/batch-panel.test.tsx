import type { BatchDto, WorkstreamDto } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, workstreamDto } from '../../test/fixtures';
import { BatchPanel } from './batch-panel';

const batch = batchDto();
const member = (taskTitle: string, state: WorkstreamDto['state']) =>
  workstreamDto({ batchId: batch.id, projectId: batch.projectId, taskTitle, state });

function panel(
  b: BatchDto,
  workstreams: WorkstreamDto[] = [],
  extra: { workspaceMode?: 'shared' | 'worktree'; gateCommand?: string | null } = {},
) {
  server.use(...baseHandlers());
  renderWithDaemon(
    <BatchPanel
      batch={b}
      workstreams={workstreams}
      workspaceMode={extra.workspaceMode ?? 'shared'}
      gateCommand={extra.gateCommand ?? null}
    />,
  );
}

const buttons = () => screen.queryAllByRole('button').map((x) => x.textContent);

describe('BatchPanel', () => {
  it('shows the branch and Abandon, and says what Abandon does in one line', async () => {
    panel(batch, [member('Alpha', 'RUNNING')]);
    expect(await screen.findByText('10db/greetings-0a1b2c3d')).toBeTruthy();
    expect(buttons()).toEqual(['Abandon']);
    expect(screen.getByText("Abandon keeps the branch and cancels this task's run.")).toBeTruthy();
  });

  it('links the pull request once it is opened, and not before', async () => {
    panel(batchDto({ state: 'SHIPPED', prUrl: 'https://github.com/acme/widgets/pull/7' }));
    expect((await screen.findByRole('link', { name: 'Pull request' })).getAttribute('href')).toBe(
      'https://github.com/acme/widgets/pull/7',
    );
  });

  it('shows no pull request link before one is opened', async () => {
    panel(batch);
    await screen.findByText('10db/greetings-0a1b2c3d');
    expect(screen.queryByRole('link', { name: 'Pull request' })).toBeNull();
  });

  it.each([
    {
      name: 'open with a failed workstream',
      batch,
      workstreams: [member('Alpha', 'FAILED'), member('Beta', 'DONE')],
      buttons: ['Ship anyway', 'Abandon'],
    },
    {
      name: 'open with work running',
      batch,
      workstreams: [member('Alpha', 'RUNNING')],
      buttons: ['Abandon'],
    },
    {
      name: 'not shipped',
      batch: batchDto({ state: 'FAILED', failure: 'gate_failed' }),
      workstreams: [member('Alpha', 'DONE')],
      buttons: ['Retry', 'Abandon'],
    },
    {
      name: 'shipping',
      batch: batchDto({ state: 'SHIPPING' }),
      workstreams: [],
      buttons: [],
    },
    {
      name: 'abandoned',
      batch: batchDto({ state: 'ABANDONED' }),
      workstreams: [],
      buttons: [],
    },
  ])('offers $buttons when $name', async ({ batch: b, workstreams, buttons: expected }) => {
    panel(b, workstreams);
    await screen.findByText(b.branch ?? 'Greetings');
    expect(buttons()).toEqual(expected);
  });

  it('says why a ship failed in plain words, with the gate step and its log', async () => {
    panel(
      batchDto({
        state: 'FAILED',
        failure: 'gate_failed',
        gateExitCode: 2,
        gateLogPath: '/data/logs/gate/batch-1.log',
      }),
      [member('Alpha', 'DONE')],
      { gateCommand: 'make gate' },
    );
    expect(await screen.findByText('Not shipped: the gate failed')).toBeTruthy();
    expect(screen.getByText('make gate exited with code 2')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gate log' }).getAttribute('href')).toBe(
      'file:///data/logs/gate/batch-1.log',
    );
  });

  it('says why without a gate when the ship failed elsewhere', async () => {
    panel(batchDto({ state: 'FAILED', failure: 'push_rejected' }), [member('Alpha', 'DONE')]);
    expect(await screen.findByText('Not shipped: git push was rejected')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Gate log' })).toBeNull();
  });

  it('Retry and Ship anyway post the batch to /ship', async () => {
    const failed = batchDto({ state: 'FAILED', failure: 'gate_failed' });
    const shipped: string[] = [];
    server.use(
      http.post(daemonUrl('/batches/:batchId/ship'), ({ params }) => {
        shipped.push(String(params['batchId']));
        return HttpResponse.json({ ...failed, state: 'SHIPPING', failure: null });
      }),
    );
    panel(failed, [member('Alpha', 'DONE')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(shipped).toEqual([failed.id]);
    });
  });

  it('Abandon posts the batch to /abandon', async () => {
    const abandoned: string[] = [];
    server.use(
      http.post(daemonUrl('/batches/:batchId/abandon'), ({ params }) => {
        abandoned.push(String(params['batchId']));
        return HttpResponse.json({ ...batch, state: 'ABANDONED' });
      }),
    );
    panel(batch, [member('Alpha', 'RUNNING')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    await waitFor(() => {
      expect(abandoned).toEqual([batch.id]);
    });
  });

  it('shows the daemon refusal beside the actions', async () => {
    server.use(
      http.post(daemonUrl('/batches/:batchId/abandon'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Batch "Greetings" is shipping' },
          { status: 409 },
        ),
      ),
    );
    panel(batch, [member('Alpha', 'RUNNING')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    expect(await screen.findByText('Batch "Greetings" is shipping')).toBeTruthy();
  });

  it('offers a fix task in worktree mode, and not while the batch is shipping', async () => {
    panel(batch, [member('Alpha', 'RUNNING')], { workspaceMode: 'worktree' });
    expect(await screen.findByRole('button', { name: 'Add a fix task' })).toBeTruthy();
  });

  it('offers no fix task on a batch that is shipping', async () => {
    panel(batchDto({ state: 'SHIPPING' }), [], { workspaceMode: 'worktree' });
    await screen.findByText('10db/greetings-0a1b2c3d');
    expect(within(document.body).queryByRole('button', { name: 'Add a fix task' })).toBeNull();
  });
});
