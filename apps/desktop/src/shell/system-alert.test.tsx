import { SystemCheckDto, type BenchmarkSyncWarning } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../daemon/queries';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { SystemAlert } from './system-alert';

const FAILED_SYNC: BenchmarkSyncWarning = {
  outcome: 'rate_limited',
  message: 'Artificial Analysis is rate limiting this key',
};
const TITLE = 'Artificial Analysis sync failed (rate_limited)';
const BODY = `${FAILED_SYNC.message}. Routing uses the last good scores until a sync succeeds.`;

describe('SystemAlert benchmark sync', () => {
  it('names a failed sync, and disappears once a later check reports none', async () => {
    let benchmarkSync: BenchmarkSyncWarning | null = FAILED_SYNC;
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json(
          SystemCheckDto.parse({
            loginEnv: { source: 'login_shell', warning: null },
            tools: [],
            benchmarkSync,
          }),
        ),
      ),
      ...baseHandlers(),
    );
    const { queryClient } = renderWithDaemon(<SystemAlert />);
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.system)?.status).toBe('success');
    });

    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();

    benchmarkSync = null;
    await queryClient.invalidateQueries({ queryKey: queryKeys.system });
    await waitFor(() => {
      expect(screen.queryByText(TITLE)).toBeNull();
    });
    expect(screen.queryByText(BODY)).toBeNull();
  });
});
