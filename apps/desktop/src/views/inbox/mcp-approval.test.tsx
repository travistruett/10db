import { MCP_APPROVAL_DETAIL, McpApprovalChoice, McpTransport } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { inboxItemDto } from '../../test/fixtures';
import { findText, getText, queryText, serveOpenRows } from '../../test/inbox-page-fixtures';

describe('MCP approval card', () => {
  it('shows the daemon-built body and what the server reads', async () => {
    const card = inboxItemDto({
      kind: 'flag',
      title: `Run the repo's MCP server "mantine"?`,
      body: 'Runs: npx -y @mantine/mcp-server@9.7.2',
      options: [
        { label: McpApprovalChoice.Approve, description: "Run it in this project's sessions" },
        {
          label: McpApprovalChoice.Deny,
          description: "Leave it out of this project's sessions until its config changes",
        },
      ],
      detail: {
        [MCP_APPROVAL_DETAIL]: {
          name: 'mantine',
          configHash: 'a'.repeat(64),
          transport: McpTransport.Stdio,
          command: 'npx',
          args: ['-y', '@mantine/mcp-server@9.7.2'],
          url: null,
          env: [],
          headers: [],
          variables: ['LOG_LEVEL'],
          sensitive: [],
          hosts: [],
        },
      },
    });
    server.use(
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([card])),
      ...baseHandlers(),
    );
    serveOpenRows(() => [card]);
    renderApp('/inbox');
    expect(await findText('Run the repo\'s MCP server "mantine"?')).toBeTruthy();
    expect(getText('MCP server')).toBeTruthy();
    expect(getText('Runs: npx -y @mantine/mcp-server@9.7.2')).toBeTruthy();
    // The daemon's body already says what the server is and that sessions run without it.
    expect(queryText(/declares this stdio server/)).toBeNull();
    expect(getText('LOG_LEVEL')).toBeTruthy();
    expect(queryText(/Environment it gets/)).toBeNull();
    expect(screen.getByRole('radio', { name: /Approve for This Project/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Deny/ })).toBeTruthy();
  });
});
