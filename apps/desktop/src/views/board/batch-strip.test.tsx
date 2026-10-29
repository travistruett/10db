import type { WorkstreamDto } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { batchDto, workstreamDto } from '../../test/fixtures';
import { BatchStrip, batchTaskCount, sharedBatches } from './batch-strip';

const batch = batchDto();
const member = (state: WorkstreamDto['state'], of = batch) =>
  workstreamDto({ batchId: of.id, projectId: of.projectId, state });

describe('batchTaskCount', () => {
  it('counts a task once, by its latest run, and leaves out cancelled runs', () => {
    const first = member('FAILED');
    const retried = workstreamDto({ ...first, id: workstreamDto().id, state: 'RUNNING' });
    expect(batchTaskCount(batch, [first, retried, member('CANCELLED'), member('DONE')])).toBe(2);
  });

  it('ignores the runs of other batches', () => {
    const other = batchDto();
    expect(batchTaskCount(batch, [member('RUNNING'), member('RUNNING', other)])).toBe(1);
  });
});

describe('sharedBatches', () => {
  it('keeps only the batches that several tasks share', () => {
    const solo = batchDto({ projectId: batch.projectId });
    const result = sharedBatches(
      [batch, solo],
      [member('RUNNING'), member('DONE'), member('RUNNING', solo)],
    );
    expect(result).toEqual([batch]);
  });

  it('shows no strip for one running task', () => {
    expect(sharedBatches([batch], [member('RUNNING')])).toEqual([]);
  });
});

describe('BatchStrip', () => {
  function strip(workstreams: WorkstreamDto[]) {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchStrip batch={batch} workstreams={workstreams} />);
  }

  it('is one line: the branch, the task count and Abandon', async () => {
    strip([member('RUNNING'), member('RUNNING')]);
    expect(await screen.findByText('10db/greetings-0a1b2c3d')).toBeTruthy();
    expect(screen.getByText('2 tasks')).toBeTruthy();
    expect(screen.queryAllByRole('button').map((b) => b.textContent)).toEqual(['Abandon']);
    // The task titles, their states and the batch's name stay out of it.
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Greetings')).toBeNull();
  });

  it('Abandon posts the batch to /abandon', async () => {
    const abandoned: string[] = [];
    server.use(
      http.post(daemonUrl('/batches/:batchId/abandon'), ({ params }) => {
        abandoned.push(String(params['batchId']));
        return HttpResponse.json({ ...batch, state: 'ABANDONED' });
      }),
    );
    strip([member('QUEUED'), member('FAILED')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    await waitFor(() => {
      expect(abandoned).toEqual([batch.id]);
    });
  });

  it('holds Abandon back while a task on the branch is running', async () => {
    strip([member('RUNNING'), member('QUEUED')]);
    const button = await screen.findByRole('button', { name: 'Abandon' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText('Write the greeting is running: cancel it in Factory first.'),
    ).toBeTruthy();
  });

  it('shows the daemon refusal', async () => {
    server.use(
      http.post(daemonUrl('/batches/:batchId/abandon'), () =>
        HttpResponse.json(
          { error: 'conflict', message: 'Batch "Greetings" is shipping' },
          { status: 409 },
        ),
      ),
    );
    strip([member('QUEUED'), member('FAILED')]);
    fireEvent.click(await screen.findByRole('button', { name: 'Abandon' }));
    expect(await screen.findByText('Batch "Greetings" is shipping')).toBeTruthy();
  });
});
