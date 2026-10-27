import { InboxKind, MCP_APPROVAL_DETAIL, McpApprovalChoice, McpTransport } from '@10db/contracts';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { notificationTitle, setWindowTheme } from './tauri';

const mcpApproval = inboxItemDto({
  kind: InboxKind.Flag,
  title: 'Run the repo\'s MCP server "docs"?',
  options: [
    { label: McpApprovalChoice.Approve, description: '' },
    { label: McpApprovalChoice.Deny, description: '' },
  ],
  detail: {
    [MCP_APPROVAL_DETAIL]: {
      name: 'docs',
      configHash: 'a'.repeat(64),
      transport: McpTransport.Http,
      command: null,
      args: [],
      url: 'https://docs.example/mcp',
      env: [],
      headers: [],
      variables: [],
      sensitive: [],
    },
  },
});

describe('notificationTitle', () => {
  it.each([
    ['a question', inboxItemDto({ kind: InboxKind.Question }), '10db has a question'],
    ['a permission', inboxItemDto({ kind: InboxKind.Permission }), '10db needs a permission'],
    ['a proposal', inboxItemDto({ kind: InboxKind.Proposal }), '10db has a proposal'],
    ['a review', inboxItemDto({ kind: InboxKind.Review }), '10db has a review for you'],
    ['a flag', inboxItemDto({ kind: InboxKind.Flag, options: [] }), '10db flagged something'],
    ['an MCP server approval', mcpApproval, '10db needs an MCP server approval'],
  ])('titles %s by its kind', (_name, item, title) => {
    expect(notificationTitle(item)).toBe(title);
  });
});

describe('setWindowTheme', () => {
  afterEach(() => {
    clearMocks();
    // clearMocks empties the internals but leaves the object, which is what isTauri looks for.
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it.each(['dark', 'light'] as const)('gives the native window the %s theme', async (scheme) => {
    mockWindows('main');
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
    });
    await setWindowTheme(scheme);
    expect(calls.find((call) => call.cmd === 'plugin:window|set_theme')?.args).toMatchObject({
      value: scheme,
    });
  });

  it('does nothing in a plain browser', async () => {
    await expect(setWindowTheme('dark')).resolves.toBeUndefined();
  });
});
