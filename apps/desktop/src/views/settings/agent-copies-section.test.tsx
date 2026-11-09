import { SystemCheckDto, type AgentCopy } from '@10db/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

const claude: AgentCopy = {
  tool: 'claude',
  label: 'Claude Code',
  pinned: '2.1.302',
  state: 'ready',
  problem: null,
  newerRelease: null,
};

function serveAgents(
  agents: AgentCopy[],
  warnings: { readonly claude?: string; readonly codex?: string } = {},
): void {
  server.use(
    http.get(daemonUrl('/system'), () =>
      HttpResponse.json(
        SystemCheckDto.parse({
          loginEnv: { source: 'login_shell', warning: null },
          claudeCode: { verifiedOn: '2.1.302', warning: warnings.claude ?? null },
          codex: { verifiedOn: '0.167.0', warning: warnings.codex ?? null },
          tools: [],
          agents,
        }),
      ),
    ),
    ...baseHandlers(),
  );
}

describe('Settings › Updates agents', () => {
  it('names the release 10db runs, and a newer one with nothing for the builder to do', async () => {
    serveAgents([{ ...claude, newerRelease: '2.1.319' }]);
    renderApp('/settings/updates');
    const section = await screen.findByRole('region', { name: 'Claude Code and Codex' });
    expect(within(section).getByText('Claude Code')).toBeTruthy();
    expect(
      within(section).getByText(/Runs 2\.1\.302, the release 10db is verified on\./),
    ).toBeTruthy();
    expect(
      within(section).getByText(
        /2\.1\.319 is out\. Nothing to do: a 10db update moves to it once it has passed its live test on 2\.1\.319\./,
      ),
    ).toBeTruthy();
  });

  it.each([
    {
      name: 'Codex',
      agent: { ...claude, tool: 'codex' as const, label: 'Codex', pinned: '0.167.0' },
      warnings: { codex: 'Codex 0.166.0 is not 0.167.0' },
      warning: /Codex 0\.166\.0 is not 0\.167\.0/,
    },
    {
      name: 'Claude Code',
      agent: claude,
      warnings: { claude: 'Claude Code 3.0.0 is a newer major version.' },
      warning: /Claude Code 3\.0\.0 is a newer major version\./,
    },
  ])(
    "says nothing about a newer release when the pin is current, and shows $name's version warning on its row",
    async ({ agent, warnings, warning }) => {
      serveAgents([agent], warnings);
      renderApp('/settings/updates');
      const section = await screen.findByRole('region', { name: 'Claude Code and Codex' });
      expect(
        within(section).getByText(new RegExp(`Runs ${agent.pinned.replaceAll('.', '\\.')}`)),
      ).toBeTruthy();
      expect(within(section).queryByText(/is out/)).toBeNull();
      expect(within(section).getByText(warning)).toBeTruthy();
    },
  );
});
