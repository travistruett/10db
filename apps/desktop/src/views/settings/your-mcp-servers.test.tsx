import {
  ApproveYourMcpServer,
  McpSignInState,
  mintId,
  StartMcpSignIn,
  TRUST_DEFAULTS,
  YourMcpServerState,
  YourMcpSource,
  yourMcpServerKey,
  type McpSignInRowDto,
  type McpSignInsDto,
  type TrustSettingsDto,
  type YourMcpServerDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../../test/daemon';

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
        'It sends no headers. If it signs in with OAuth, sign it in as each agent does: in Claude Code, or below for a Codex account.',
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

// Settings › Trust signs a Codex account in to a server that signs in with OAuth, and tells a Claude plan
// account in its own folder what to run.

const ACCOUNT = mintId('Account');
const OTHER_ACCOUNT = mintId('Account');
const LINEAR = mcp('linear', {
  transport: 'http',
  command: null,
  args: [],
  url: 'https://mcp.linear.app/mcp',
  envNames: [],
  shownEnv: [],
  sendsNoHeaders: true,
  state: YourMcpServerState.Approved,
  on: true,
});

function signInRow(over: Partial<McpSignInRowDto> = {}): McpSignInRowDto {
  return {
    accountId: ACCOUNT,
    accountLabel: 'ChatGPT plan',
    key: LINEAR.key,
    name: 'linear',
    state: McpSignInState.NotSignedIn,
    message: null,
    ...over,
  };
}

function serveSignIns(servers: YourMcpServerDto[], signIns: McpSignInsDto) {
  const started: StartMcpSignIn[] = [];
  let reads = 0;
  serve(servers);
  server.use(
    http.get(daemonUrl('/settings/trust/mcp-sign-ins'), () => {
      reads += 1;
      return HttpResponse.json(signIns);
    }),
    http.post(daemonUrl('/settings/trust/mcp-sign-ins'), async ({ request }) => {
      started.push(StartMcpSignIn.parse(await request.json()));
      return HttpResponse.json(signIns);
    }),
    ...baseHandlers(),
  );
  return { started, reads: () => reads };
}

describe('Settings › Trust: signing in to your MCP servers', () => {
  it.each<{
    name: string;
    row: Partial<McpSignInRowDto>;
    line: string;
    button: string | null;
  }>([
    {
      name: 'signed in',
      row: { state: McpSignInState.SignedIn },
      line: 'ChatGPT plan: Signed in',
      button: null,
    },
    {
      name: 'not signed in',
      row: { state: McpSignInState.NotSignedIn },
      line: 'ChatGPT plan: Not signed in',
      button: 'Sign in',
    },
    {
      name: 'signing in',
      row: { state: McpSignInState.SigningIn },
      line: 'ChatGPT plan: Signing in in your browser…',
      button: 'Open page again',
    },
    {
      name: 'failed',
      row: {
        state: McpSignInState.Failed,
        message: "The sign-in didn't finish. Try Sign in again.",
      },
      line: "ChatGPT plan: The sign-in didn't finish. Try Sign in again.",
      button: 'Sign in',
    },
    {
      name: 'unknown',
      row: { state: McpSignInState.Unknown },
      line: "ChatGPT plan: Couldn't read whether it's signed in.",
      button: 'Sign in',
    },
  ])('shows $name as one line with its button', async ({ row, line, button }) => {
    serveSignIns([LINEAR], { rows: [signInRow(row)], terminal: [] });
    renderApp('/settings/trust');
    expect(await screen.findByText(line)).toBeTruthy();
    const buttons = screen.queryAllByRole('button', { name: /^(Sign in|Open page again)/ });
    expect(buttons.map((b) => b.textContent)).toEqual(button === null ? [] : [button]);
  });

  it.each([
    { name: 'Sign in', state: McpSignInState.NotSignedIn, button: /^Sign in/ },
    { name: 'Open page again', state: McpSignInState.SigningIn, button: /^Open page again/ },
  ])('$name posts the account and the server', async ({ state, button }) => {
    const { started } = serveSignIns([LINEAR], {
      rows: [
        signInRow({ state }),
        signInRow({ accountId: OTHER_ACCOUNT, accountLabel: 'Work plan' }),
      ],
      terminal: [],
    });
    renderApp('/settings/trust');
    await screen.findByText('Work plan: Not signed in');
    fireEvent.click(screen.getAllByRole('button', { name: button })[0] ?? document.body);
    await waitFor(() => {
      expect(started).toEqual([{ accountId: ACCOUNT, key: LINEAR.key }]);
    });
  });

  it('shows a terminal entry once, at the foot of the card, with its command and a Copy button', async () => {
    serveSignIns(
      [
        LINEAR,
        mcp('notion', {
          ...LINEAR,
          name: 'notion',
          key: yourMcpServerKey(YourMcpSource.ClaudeJson, 'notion'),
        }),
      ],
      {
        rows: [],
        terminal: [
          {
            accountId: ACCOUNT,
            accountLabel: 'Own plan',
            command: "CLAUDE_CONFIG_DIR='/a' claude",
          },
        ],
      },
    );
    renderApp('/settings/trust');
    expect(
      await screen.findByText('To sign Own plan in to a server that signs in with OAuth, run:'),
    ).toBeTruthy();
    expect(screen.getAllByText("CLAUDE_CONFIG_DIR='/a' claude")).toHaveLength(1);
    expect(screen.getByText('Then run /mcp and sign in.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy command' })).toBeTruthy();
  });

  it('refetches the rows when an mcp_sign_in.changed event arrives', async () => {
    const sockets: { send(data: string): void }[] = [];
    const { reads } = serveSignIns([LINEAR], { rows: [signInRow()], terminal: [] });
    server.use(
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    renderApp('/settings/trust');
    await screen.findByText('ChatGPT plan: Not signed in');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    // The stream's first open refetches everything; count from there.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const before = reads();
    sockets[0]?.send(
      JSON.stringify({
        seq: 1,
        type: 'mcp_sign_in.changed',
        entityType: 'mcp_sign_in',
        entityId: ACCOUNT,
        data: { accountId: ACCOUNT, key: LINEAR.key, state: McpSignInState.SignedIn },
        at: '2026-11-14T12:00:00.000Z',
      }),
    );
    await waitFor(() => {
      expect(reads()).toBeGreaterThan(before);
    });
  });

  it.each([
    { name: 'a clientId alone', oauth: [{ name: 'clientId', value: 'cid' }], unused: null },
    {
      name: 'an xaa and a metadata url',
      oauth: [
        { name: 'clientId', value: 'cid' },
        { name: 'authServerMetadataUrl', value: 'https://idp.example/.well-known' },
        { name: 'xaa', value: 'true' },
      ],
      unused: "Codex sessions don't use: authServerMetadataUrl, xaa",
    },
  ])(
    'describes $name, and names what Codex does not use only when it is set',
    async ({ oauth, unused }) => {
      serveSignIns([{ ...LINEAR, oauth }], { rows: [], terminal: [] });
      renderApp('/settings/trust');
      expect(await screen.findByText(/^Signs in with OAuth: clientId=cid/)).toBeTruthy();
      if (unused === null) expect(screen.queryByText(/Codex sessions don't use/)).toBeNull();
      else expect(screen.getByText(unused)).toBeTruthy();
    },
  );

  it('the approve modal tells a no-header server how to sign in', async () => {
    serveSignIns([{ ...LINEAR, state: YourMcpServerState.New }], { rows: [], terminal: [] });
    renderApp('/settings/trust');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve linear' }));
    const modal = await screen.findByRole('dialog');
    expect(
      within(modal).getByText(
        'It sends no headers. If it signs in with OAuth, sign it in as each agent does: in Claude Code, or below for a Codex account.',
      ),
    ).toBeTruthy();
  });
});
