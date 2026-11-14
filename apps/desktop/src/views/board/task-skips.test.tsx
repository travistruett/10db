import { mintId, SkippedActionDto } from '@10db/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { skipKeys } from '../../daemon/skip-queries';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { TaskSkips } from './task-skips';

// Trust line §5: a task shows what its run skipped while nobody watched, and its questions apart.

const workstreamId = mintId('Workstream');

const row = (over: Partial<SkippedActionDto>): SkippedActionDto =>
  SkippedActionDto.parse({
    id: mintId('SkippedAction'),
    workstreamId,
    toolName: 'Bash',
    summary: 'vercel deploy --prod',
    kind: 'deploy',
    limit: 'writes_live',
    reason: 'a deploy writes to a live system',
    source: 'guard',
    approval: 'exact',
    createdAt: '2026-11-13T10:00:00.000Z',
    ...over,
  });

function serve(rows: SkippedActionDto[]) {
  server.use(
    http.get(daemonUrl('/workstreams/:id/skips'), () => HttpResponse.json(rows)),
    ...baseHandlers(),
  );
}

describe('TaskSkips', () => {
  it('shows the skips and the questions apart', async () => {
    serve([
      row({}),
      row({
        toolName: 'ask_human',
        summary: 'Teal or red?',
        kind: 'question',
        limit: null,
        reason: 'The builder was away.',
        source: 'question',
        approval: 'none',
      }),
    ]);
    renderWithDaemon(<TaskSkips workstreamId={workstreamId} />);
    const skipped = await screen.findByRole('list', { name: 'Skipped calls' });
    expect(within(skipped).getByText('vercel deploy --prod')).toBeTruthy();
    expect(within(skipped).getByText(/a deploy writes to a live system/)).toBeTruthy();
    expect(within(skipped).queryByText('Teal or red?')).toBeNull();
    const asked = screen.getByRole('list', { name: 'Questions it would have asked' });
    expect(within(asked).getByText('Teal or red?')).toBeTruthy();
  });

  it('shows nothing with no rows', async () => {
    serve([]);
    const { queryClient } = renderWithDaemon(<TaskSkips workstreamId={workstreamId} />);
    await waitFor(() => {
      expect(queryClient.getQueryState(skipKeys.of(workstreamId))?.status).toBe('success');
    });
    expect(screen.queryByText('Skipped while nobody was watching')).toBeNull();
  });
});
