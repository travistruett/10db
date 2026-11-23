import { AgentCopyState, SystemCheckDto, ToolName } from '@10db/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

describe('Settings › Updates agents', () => {
  it('names the release 10db runs, and a newer one with nothing for the builder to do', async () => {
    server.use(
      http.get(daemonUrl('/system'), () =>
        HttpResponse.json(
          SystemCheckDto.parse({
            loginEnv: { source: 'login_shell', warning: null },
            claudeCode: { verifiedOn: '2.1.302', warning: null },
            codex: { verifiedOn: '0.167.0', warning: null },
            tools: [],
            agents: [
              {
                tool: ToolName.Claude,
                label: 'Claude Code',
                pinned: '2.1.302',
                state: AgentCopyState.Ready,
                problem: null,
                newerRelease: '2.1.319',
              },
            ],
          }),
        ),
      ),
      ...baseHandlers(),
    );
    renderApp('/settings/updates');
    const section = await screen.findByRole('region', { name: 'Harnesses' });
    expect(within(section).getByText('Claude Code')).toBeTruthy();
    expect(within(section).getByText('2.1.302')).toBeTruthy();
    expect(within(section).getByText('2.1.319 Out')).toBeTruthy();
  });
});
