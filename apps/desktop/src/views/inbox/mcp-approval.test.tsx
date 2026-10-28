import {
  MCP_APPROVAL_DETAIL,
  McpApprovalChoice,
  McpTransport,
  type McpServerReview,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../daemon/queries';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';

const review = (overrides: Partial<McpServerReview> = {}): McpServerReview => ({
  name: 'mantine',
  configHash: 'a'.repeat(64),
  transport: McpTransport.Stdio,
  command: 'npx',
  args: ['-y', '@mantine/mcp-server@9.7.2'],
  url: null,
  env: [],
  headers: [],
  variables: [],
  sensitive: [],
  hosts: [],
  ...overrides,
});

const card = (r: McpServerReview, body = 'Runs: npx -y @mantine/mcp-server@9.7.2') =>
  inboxItemDto({
    kind: 'flag',
    title: `Run the repo's MCP server "${r.name}"?`,
    body,
    options: [
      { label: McpApprovalChoice.Approve, description: "Run it in this project's sessions" },
      {
        label: McpApprovalChoice.Deny,
        description: "Leave it out of this project's sessions until its config changes",
      },
    ],
    detail: { [MCP_APPROVAL_DETAIL]: r },
  });

function serveInbox(items: ReturnType<typeof inboxItemDto>[]): { answers: unknown[] } {
  const answers: unknown[] = [];
  server.use(
    http.get(daemonUrl('/inbox'), () => HttpResponse.json(answers.length > 0 ? [] : items)),
    http.post(daemonUrl('/inbox/:id/answer'), async ({ request }) => {
      answers.push(await request.json());
      return HttpResponse.json({ ...items[0], state: 'RESOLVED' });
    }),
    ...baseHandlers(),
  );
  return { answers };
}

describe('MCP approval card', () => {
  it('shows the daemon-built body and what the server reads', async () => {
    serveInbox([card(review({ variables: ['LOG_LEVEL'] }))]);
    renderApp('/inbox');
    expect(await screen.findByText('Run the repo\'s MCP server "mantine"?')).toBeTruthy();
    expect(screen.getByText('MCP server')).toBeTruthy();
    expect(screen.getByText('Runs: npx -y @mantine/mcp-server@9.7.2')).toBeTruthy();
    // The daemon's body already says what the server is and that sessions run without it.
    expect(screen.queryByText(/declares this stdio server/)).toBeNull();
    expect(screen.getByText('LOG_LEVEL')).toBeTruthy();
    expect(screen.queryByText(/Environment it gets/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Approve for this project/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Deny/ })).toBeTruthy();
  });

  it.each([
    [
      'the hosts it may reach',
      ['*.example.org', 'registry.npmjs.org'],
      '*.example.org\nregistry.npmjs.org',
    ],
    ['that it reaches none', [], 'No host'],
  ])('says, for a stdio server, %s', async (_name, hosts, shown) => {
    serveInbox([card(review({ hosts }))]);
    renderApp('/inbox');
    expect(await screen.findByText('Reaches these hosts')).toBeTruthy();
    expect(screen.getByText(shown, { normalizer: (text) => text })).toBeTruthy();
  });

  it('warns about credential-like variables', async () => {
    serveInbox([
      card(
        review({
          name: 'docs',
          transport: McpTransport.Http,
          command: null,
          args: [],
          url: 'https://docs.example/mcp',
          variables: ['DOCS_TOKEN'],
          sensitive: ['DOCS_TOKEN'],
        }),
        'Connects to: https://docs.example/mcp\nSends headers: Authorization=Bearer ${DOCS_TOKEN}',
      ),
    ]);
    renderApp('/inbox');
    expect(await screen.findByText(/Connects to: https:\/\/docs.example\/mcp/)).toBeTruthy();
    const warning = screen.getByRole('alert');
    expect(within(warning).getByText('Approving passes DOCS_TOKEN to this server.')).toBeTruthy();
  });

  it('renders the daemon body verbatim as text, escapes and all', async () => {
    const body =
      'Runs: PATH=./.tools npx -y \\u{202e}evil\nIts env block replaces PATH, so what it runs is looked up and started as shown above.';
    serveInbox([card(review({ env: [{ name: 'PATH', value: './.tools' }] }), body)]);
    renderApp('/inbox');
    expect(
      await screen.findByText((_, el) => el?.tagName === 'PRE' && el.textContent === body),
    ).toBeTruthy();
    expect(screen.getByText(/\\u\{202e\}evil/)).toBeTruthy();
  });

  it('renders markup in the body as text', async () => {
    serveInbox([card(review(), 'Runs: <img src=x onerror=alert(1)> <b>bold</b>')]);
    renderApp('/inbox');
    expect(await screen.findByText('Runs: <img src=x onerror=alert(1)> <b>bold</b>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('main b')).toBeNull();
  });

  it('approves with 1 and Enter, posting the stable choice', async () => {
    const { answers } = serveInbox([card(review())]);
    renderApp('/inbox');
    await screen.findByText('Run the repo\'s MCP server "mantine"?');
    fireEvent.keyDown(document.body, { key: '1' });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => {
      expect(answers).toEqual([{ choice: McpApprovalChoice.Approve }]);
    });
  });

  it('never approves by default: Enter with no choice posts nothing', async () => {
    const { answers } = serveInbox([card(review())]);
    renderApp('/inbox');
    await screen.findByText('Run the repo\'s MCP server "mantine"?');
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(await screen.findByText('Choose an option first (1–4).')).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it('keeps approve with the card it was chosen on when another sorts first', async () => {
    const a = card(review({ name: 'alpha' }));
    const b = card(review({ name: 'beta', configHash: 'b'.repeat(64) }));
    let items = [a];
    const answers: unknown[] = [];
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json(items)),
      http.post(daemonUrl('/inbox/:id/answer'), async ({ params, request }) => {
        answers.push({ id: String(params['id']), body: await request.json() });
        return HttpResponse.json({ ...a, state: 'RESOLVED' });
      }),
      ...baseHandlers(),
    );
    const { queryClient } = renderApp('/inbox');
    await screen.findByText('Run the repo\'s MCP server "alpha"?');
    fireEvent.keyDown(document.body, { key: '1' });
    await waitFor(() => {
      expect(
        screen
          .getByRole('radio', { name: /Approve for this project/ })
          .getAttribute('aria-checked'),
      ).toBe('true');
    });
    items = [b, a];
    await queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    await screen.findByText('Run the repo\'s MCP server "beta"?');
    expect(screen.getAllByRole('radiogroup')).toHaveLength(1);
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => {
      expect(answers).toEqual([{ id: a.id, body: { choice: McpApprovalChoice.Approve } }]);
    });
  });
});
