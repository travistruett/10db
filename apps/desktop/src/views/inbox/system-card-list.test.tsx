import { SystemCheckDto, type AgentCopy } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

const codex = (over: Partial<AgentCopy>): AgentCopy => ({
  tool: 'codex',
  label: 'Codex',
  pinned: '0.167.0',
  state: 'ready',
  problem: null,
  newerRelease: null,
  ...over,
});

/** Serves an empty inbox and the system check `read` answers, read again on every request. */
function serveCheck(read: (recheck: boolean) => Partial<SystemCheckDto>): void {
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json([])),
    http.get(daemonUrl('/system'), ({ request }) =>
      HttpResponse.json(
        SystemCheckDto.parse({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: null },
          codex: { verifiedOn: '0.167.0', warning: null },
          tools: [],
          ...read(new URL(request.url).searchParams.get('recheck') === '1'),
        }),
      ),
    ),
    ...baseHandlers(),
  );
}

describe('10db cards in the Inbox', () => {
  it('shows a refused copy with Fetch It Again, counts it as open, and drops it once the fetch starts', async () => {
    let rechecked = false;
    serveCheck((recheck) => {
      if (recheck) rechecked = true;
      return {
        agents: [
          codex(
            rechecked
              ? { state: 'fetching' }
              : { state: 'refused', problem: 'Codex 0.167.0 was refused: changed files' },
          ),
        ],
      };
    });
    const { queryClient } = renderApp('/inbox');

    expect(await screen.findByText("Codex 0.167.0 can't be used")).toBeTruthy();
    expect(screen.getByText(/was refused: changed files/)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Inbox.*1 open card/ })).toBeTruthy();
    expect(screen.queryByText('Nothing needs you right now.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fetch It Again' }));
    await waitFor(() => {
      expect(screen.queryByText("Codex 0.167.0 can't be used")).toBeNull();
    });
    expect(rechecked).toBe(true);
    expect(queryClient.getQueryData(queryKeys.system)).toBeTruthy();
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    // The download it started is told in the header, not in the Inbox.
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('status', { name: 'Downloading Codex 0.167.0' })).toBeTruthy();
  });

  it.each([
    {
      name: 'a missing required tool',
      check: {
        tools: [
          { name: 'git' as const, path: null, version: null, required: true, signedIn: null },
        ],
      },
      title: 'git was not found where 10db looks for it',
      body: /Install it there, then restart 10db/,
    },
    {
      name: 'an unreadable login shell',
      check: { loginEnv: { source: 'inherited' as const, warning: 'zsh exited with 1' } },
      title: "10db couldn't read your login shell's environment",
      body: /zsh exited with 1/,
    },
    {
      name: 'a refused Artificial Analysis key',
      check: {
        benchmarkSync: {
          outcome: 'unauthorized' as const,
          message: 'Artificial Analysis refused the key',
        },
      },
      title: 'Artificial Analysis refused the key',
      body: /Replace the key in the Keychain; the next sync reads it/,
    },
  ])('says what to do about $name', async ({ check, title, body }) => {
    serveCheck(() => check);
    renderApp('/inbox');
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Open 1' })).toBeTruthy();
  });

  it('puts nothing above a view for a newer release or a version warning', async () => {
    serveCheck(() => ({
      agents: [codex({ newerRelease: '0.168.0' })],
      codex: { verifiedOn: '0.167.0', warning: 'Codex 0.166.0 is not 0.167.0' },
    }));
    const { queryClient } = renderApp('/board');
    await waitFor(() => {
      expect(queryClient.getQueryState(queryKeys.system)?.status).toBe('success');
    });
    expect(screen.queryByText('Codex 0.168.0 is out')).toBeNull();
    expect(screen.queryByText(/Codex 0\.166\.0 is not 0\.167\.0/)).toBeNull();
    expect(screen.queryByRole('link', { name: /open card/ })).toBeNull();
  });
});
