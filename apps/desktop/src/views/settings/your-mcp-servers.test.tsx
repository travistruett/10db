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

function mcp(name: string, over: Partial<YourMcpServerDto> = {}): YourMcpServerDto {
  return {
    key: yourMcpServerKey(YourMcpSource.ClaudeJson, name),
    name,
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
    ...over,
  };
}

function serve(servers: YourMcpServerDto[], mcpNotice: string | null = null) {
  const approved: ApproveYourMcpServer[] = [];
  const settings: TrustSettingsDto = {
    switches: TRUST_DEFAULTS,
    plugins: [],
    judges: [],
    tendbReady: false,
    mcpServers: servers,
    mcpNotice,
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
    const github = mcp('github');
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

  it('warns about OAuth when approving a server that sends no headers', async () => {
    serve([
      mcp('linear', {
        transport: 'http',
        command: null,
        args: [],
        url: 'https://mcp.linear.app/mcp',
        envNames: [],
        shownEnv: [],
        sendsNoHeaders: true,
      }),
    ]);
    renderApp('/settings/trust');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve linear' }));
    const modal = await screen.findByRole('dialog');
    expect(
      within(modal).getByText(
        "It sends no headers. If it signs in with OAuth, it won't connect in 10db yet.",
      ),
    ).toBeTruthy();
  });

  it('a changed server shows Changed and Approve', async () => {
    serve([mcp('github', { state: YourMcpServerState.Changed })]);
    renderApp('/settings/trust');
    expect(await screen.findByText('Changed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve github' })).toBeTruthy();
  });

  it('a left-out server shows its reason and no switch', async () => {
    serve([
      mcp('local', {
        state: YourMcpServerState.LeftOut,
        reason: "Its command points at a project's folder, which an agent can write.",
      }),
    ]);
    renderApp('/settings/trust');
    expect(await screen.findByText(/Its command points at a project's folder/)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'local' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve local' })).toBeNull();
  });

  it('shows the notice above the list, a plugin’s owner and the Codex-only keys', async () => {
    serve(
      [
        mcp('plugin_p_s', {
          key: yourMcpServerKey(YourMcpSource.Plugin, 's', 'p@m'),
          source: YourMcpSource.Plugin,
          pluginId: 'p@m',
          state: YourMcpServerState.Approved,
          on: true,
        }),
        mcp('c', {
          key: yourMcpServerKey(YourMcpSource.CodexConfig, 'c'),
          source: YourMcpSource.CodexConfig,
          state: YourMcpServerState.Approved,
          codexOnly: ['enabled_tools'],
          enabledTools: ['a'],
          disabledTools: ['b'],
          cwd: '/Users/me/work',
        }),
      ],
      'Your shell sets CLAUDE_CONFIG_DIR. 10db reads your servers from ~/.claude.json, not from there.',
    );
    renderApp('/settings/trust');
    expect(await screen.findByText(/Your shell sets CLAUDE_CONFIG_DIR/)).toBeTruthy();
    expect(screen.getByText('Comes with p@m')).toBeTruthy();
    expect(screen.getByText('Codex only: enabled_tools')).toBeTruthy();
    // What the hash covers is shown, so a Changed badge has a visible cause.
    expect(screen.getByText('Only tools: a')).toBeTruthy();
    expect(screen.getByText('Without tools: b')).toBeTruthy();
    expect(screen.getByText('Starts in /Users/me/work')).toBeTruthy();
  });
});
