import { SystemCheckDto, type BenchmarkSyncWarning } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
          codex: { verifiedOn: '0.154.0', warning: null },
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

describe('SystemAlert pinned agent copies', () => {
  type Agent = NonNullable<SystemCheckDto['agents']>[number];
  const codex = (over: Partial<Agent>): Agent => ({
    tool: 'codex',
    label: 'Codex',
    pinned: '0.167.0',
    state: 'ready',
    problem: null,
    newerRelease: null,
    ...over,
  });
  function serveAgents(read: () => Agent[]): void {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json(
          SystemCheckDto.parse({
            loginEnv: { source: 'login_shell', warning: null },
            claudeCode: { verifiedOn: '2.1.302', warning: null },
            codex: { verifiedOn: '0.167.0', warning: null },
            tools: [
              { name: 'claude', path: null, version: null, required: true },
              { name: 'codex', path: null, version: null, required: false },
            ],
            agents: read(),
          }),
        ),
      ),
      ...baseHandlers(),
    );
  }

  it('names the pinned and the released version when a newer release is out, and clears once the pin has caught up', async () => {
    let agents = [codex({ newerRelease: '0.168.0' })];
    serveAgents(() => agents);
    const { queryClient } = renderWithDaemon(<SystemAlert />);
    expect(await screen.findByText('Codex 0.168.0 is out')).toBeTruthy();
    expect(
      screen.getByText(/10db runs Codex 0\.167\.0, the release it is verified on/),
    ).toBeTruthy();

    agents = [codex({ pinned: '0.168.0' })];
    await queryClient.invalidateQueries({ queryKey: queryKeys.system });
    await waitFor(() => {
      expect(screen.queryByText('Codex 0.168.0 is out')).toBeNull();
    });
  });

  it('says which tool was refused and why, and raises no "not found" alert for it', async () => {
    serveAgents(() => [
      {
        tool: 'claude',
        label: 'Claude Code',
        pinned: '2.1.302',
        state: 'ready',
        problem: null,
        newerRelease: null,
      },
      codex({
        state: 'refused',
        problem: 'Codex 0.167.0 was refused: the files no longer match the recorded checksum',
      }),
    ]);
    renderWithDaemon(<SystemAlert />);
    expect(await screen.findByText("Codex 0.167.0 can't be used")).toBeTruthy();
    expect(
      screen.getByText(/was refused: the files no longer match the recorded checksum/),
    ).toBeTruthy();
    expect(screen.queryByText(/was not found where 10db looks for it/)).toBeNull();
  });

  it('offers to fetch a refused copy afresh, and shows it downloading once asked', async () => {
    let rechecked = false;
    server.use(
      http.get(daemonUrl('/system'), ({ request }) => {
        if (new URL(request.url).searchParams.get('recheck') === '1') rechecked = true;
        return HttpResponse.json(
          SystemCheckDto.parse({
            loginEnv: { source: 'login_shell', warning: null },
            claudeCode: { verifiedOn: '2.1.302', warning: null },
            codex: { verifiedOn: '0.167.0', warning: null },
            tools: [],
            agents: [
              codex(
                rechecked
                  ? { state: 'fetching' }
                  : { state: 'refused', problem: 'Codex 0.167.0 was refused: changed files' },
              ),
            ],
          }),
        );
      }),
      ...baseHandlers(),
    );
    renderWithDaemon(<SystemAlert />);
    expect(await screen.findByText(/downloads a fresh copy/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fetch it again' }));
    expect(await screen.findByText('Codex 0.167.0 is being downloaded')).toBeTruthy();
    expect(rechecked).toBe(true);
  });

  it('says a copy is being downloaded rather than that Claude Code is missing', async () => {
    serveAgents(() => [
      {
        tool: 'claude',
        label: 'Claude Code',
        pinned: '2.1.302',
        state: 'fetching',
        problem: null,
        newerRelease: null,
      },
    ]);
    renderWithDaemon(<SystemAlert />);
    expect(await screen.findByText('Claude Code 2.1.302 is being downloaded')).toBeTruthy();
    expect(screen.queryByText(/was not found where 10db looks for it/)).toBeNull();
  });
});

describe('SystemAlert Codex version', () => {
  // The daemon warns on any version but the verified one, an older one too.
  it('shows the Codex version warning, saying it differs rather than that it is newer', async () => {
    const warning =
      "Codex 0.153.9 is not 0.154.0, the version 10db's ChatGPT-plan checks were verified on.";
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json(
          SystemCheckDto.parse({
            loginEnv: { source: 'login_shell', warning: null },
            claudeCode: { verifiedOn: '2.1.0', warning: null },
            codex: { verifiedOn: '0.154.0', warning },
            tools: [],
            benchmarkSync: null,
          }),
        ),
      ),
      ...baseHandlers(),
    );
    renderWithDaemon(<SystemAlert />);
    expect(
      await screen.findByText(
        "This Codex differs from the one 10db's account checks were verified on",
      ),
    ).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    expect(screen.queryByText(/newer/)).toBeNull();
  });
});
