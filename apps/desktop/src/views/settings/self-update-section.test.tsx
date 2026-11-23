import { SelfUpdateStatusDto } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

it('is on by default, and says it follows the repository the app was built for', async () => {
  const status = SelfUpdateStatusDto.parse({
    enabled: true,
    isDefault: true,
    runningCommit: '1a2b3c4d5e6f708192a3b4c5d6e7f80910111213',
    availableCommit: null,
    notInstalling: null,
    waitMinutes: 15,
    waitingSince: null,
    draining: false,
    drainingSince: null,
    midSession: { working: 0, waitingOnCard: 0, batches: 0, jobs: 0, shapes: [] },
    blocker: null,
  });
  server.use(
    http.get(daemonUrl('/settings/self-update'), () => HttpResponse.json(status)),
    ...baseHandlers(),
  );
  renderApp('/settings/updates');
  const toggle = await screen.findByRole('switch', { name: 'Update 10db by itself' });
  await waitFor(() => {
    expect((toggle as HTMLInputElement).checked).toBe(true);
  });
});
