import { InboxKind, MCP_APPROVAL_DETAIL, McpApprovalChoice, McpTransport } from '@10db/contracts';
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { inboxItemDto } from '../test/fixtures';
import { notificationTitle, openAppPage, setWindowTheme } from './tauri';

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

describe('openAppPage', () => {
  afterEach(() => {
    clearMocks();
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  function recordOpened(): string[] {
    const opened: string[] = [];
    mockIPC((cmd, args) => {
      // The mocked IPC payload of the shell's open_app_page command.
      if (cmd === 'open_app_page') opened.push((args as { url: string }).url);
    });
    return opened;
  }

  it.each([
    [
      'localhost with a port',
      'http://localhost:8800',
      '/settings?tab=a',
      'http://localhost:8800/settings?tab=a',
    ],
    ['an IPv4 loopback address', 'http://127.0.0.1:3000/', '/', 'http://127.0.0.1:3000/'],
    ['an IPv6 loopback address', 'http://[::1]:5173', '/a/b', 'http://[::1]:5173/a/b'],
    ['a .localhost name', 'http://app.localhost:8800', '/x', 'http://app.localhost:8800/x'],
  ])('opens a route of %s', async (_name, appUrl, route, expected) => {
    const opened = recordOpened();
    await openAppPage(appUrl, route);
    expect(opened).toEqual([expected]);
  });

  it.each([
    ['an app address that is not loopback', 'http://example.com:8800', '/settings'],
    ['a look-alike host', 'http://localhost.example.com', '/settings'],
    ['an app address that is not http', 'ftp://localhost:21', '/settings'],
    ['an app address that is not a URL', 'localhost:8800', '/settings'],
    ['a route on another host', 'http://localhost:8800', '//evil.example/x'],
    [
      'a route that reads as credentials for another host',
      'http://localhost:8800',
      '@evil.example/x',
    ],
    ['a route that is an absolute URL', 'http://localhost:8800', 'https://github.com/x'],
    ['a route without a leading slash', 'http://localhost:8800', 'settings'],
  ])('refuses %s', async (_name, appUrl, route) => {
    const opened = recordOpened();
    await expect(openAppPage(appUrl, route)).rejects.toMatchObject({
      name: 'AppPageRefusedError',
    });
    expect(opened).toEqual([]);
  });
});
