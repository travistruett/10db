import { SystemCheckDto, type BenchmarkSyncWarning } from '@10db/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../daemon/queries';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { SystemAlert } from './system-alert';

const REFUSED_KEY: BenchmarkSyncWarning = {
  outcome: 'unauthorized',
  message: 'Artificial Analysis refused the key',
};
const TITLE = 'Artificial Analysis refused the key';
const BODY =
  'Replace the key in the Keychain; the next sync reads it. Routing uses the last good scores until a sync succeeds.';

function serveSync(read: () => BenchmarkSyncWarning | null): void {
  server.use(
    http.get(daemonUrl('/system'), () =>
      HttpResponse.json(
        SystemCheckDto.parse({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.0', warning: null },
          tools: [],
          benchmarkSync: read(),
        }),
      ),
    ),
    ...baseHandlers(),
  );
}

describe('SystemAlert benchmark sync', () => {
  it('names a refused key, and disappears once a later check reports none', async () => {
    let benchmarkSync: BenchmarkSyncWarning | null = REFUSED_KEY;
    serveSync(() => benchmarkSync);
    const { queryClient } = renderWithDaemon(<SystemAlert />);

    expect(await screen.findByText(TITLE)).toBeTruthy();
    expect(screen.getByText(BODY)).toBeTruthy();

    benchmarkSync = null;
    await queryClient.invalidateQueries({ queryKey: queryKeys.system });
    await waitFor(() => {
      expect(screen.queryByText(TITLE)).toBeNull();
    });
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it.each([
    {
      name: 'a used-up daily limit',
      warning: {
        outcome: 'rate_limited',
        message: 'The daily Artificial Analysis limit is used up',
      },
    },
    {
      name: 'an unreachable server',
      warning: { outcome: 'failed', message: 'Artificial Analysis answered 503' },
    },
  ] satisfies { name: string; warning: BenchmarkSyncWarning }[])(
    'raises no alert for $name, which clears itself',
    async ({ warning }) => {
      serveSync(() => warning);
      const { queryClient } = renderWithDaemon(<SystemAlert />);
      await waitFor(() => {
        expect(queryClient.getQueryState(queryKeys.system)?.status).toBe('success');
      });

      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText(warning.message, { exact: false })).toBeNull();
    },
  );
});
