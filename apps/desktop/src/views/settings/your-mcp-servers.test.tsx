import {
  ApproveYourMcpServer,
  TRUST_DEFAULTS,
  YourMcpServerState,
  YourMcpSource,
  yourMcpServerKey,
  type TrustSettingsDto,
  type YourMcpServerDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';

// Settings › Trust lists the builder's own MCP servers: Approve once, then a switch.

const HASH = 'a'.repeat(64);

const github: YourMcpServerDto = {
  key: yourMcpServerKey(YourMcpSource.ClaudeJson, 'github'),
  name: 'github',
  source: YourMcpSource.ClaudeJson,
  pluginId: null,
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'pkg'],
  cwd: null,
  url: null,
  envNames: ['PATH', 'TOKEN'],
  headerNames: [],
  shownEnv: [{ name: 'PATH', value: '/usr/bin' }],
  configHash: HASH,
  state: YourMcpServerState.New,
  reason: null,
  on: false,
  codexOnly: [],
  enabledTools: null,
  disabledTools: [],
  oauth: [],
  sendsNoHeaders: false,
};

function serve(servers: YourMcpServerDto[]) {
  const approved: ApproveYourMcpServer[] = [];
  const settings: TrustSettingsDto = {
    switches: TRUST_DEFAULTS,
    plugins: [],
    judges: [],
    tendbReady: false,
    mcpServers: servers,
    mcpNotice: null,
  };
  server.use(
    http.get(daemonUrl('/settings/trust'), () => HttpResponse.json(settings)),
    http.post(daemonUrl('/settings/trust/mcp-servers/approve'), async ({ request }) => {
      const body = ApproveYourMcpServer.parse(await request.json());
      approved.push(body);
      return HttpResponse.json({
        ...settings,
        mcpServers: servers.map((s) =>
          s.key === body.key ? { ...s, state: YourMcpServerState.Approved, on: true } : s,
        ),
      });
    }),
    ...baseHandlers(),
  );
  return { approved };
}

describe("Settings › Trust: the builder's MCP servers", () => {
  it('shows a new server with Approve, and approving sends its key and hash', async () => {
    const { approved } = serve([github]);
    renderApp('/settings/trust');
    expect(await screen.findByText('New')).toBeTruthy();
    expect(screen.getByText('Runs npx -y pkg')).toBeTruthy();
    expect(screen.getByText('Sets PATH, TOKEN')).toBeTruthy();
    expect(screen.getByText('PATH=/usr/bin')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve github' }));
    const modal = await screen.findByRole('dialog');
    expect(within(modal).getByText(/runs outside 10db's sandbox/)).toBeTruthy();
    expect(within(modal).queryByText(/signs in with OAuth/)).toBeNull();
    fireEvent.click(within(modal).getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(approved).toEqual([{ key: github.key, configHash: HASH }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'github' })).toHaveProperty('checked', true);
    });
  });
});
