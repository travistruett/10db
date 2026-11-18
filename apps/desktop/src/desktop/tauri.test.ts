import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it } from 'vitest';
import { openAppPage } from './tauri';

describe('openAppPage', () => {
  afterEach(() => {
    clearMocks();
    // clearMocks empties the internals but leaves the object, which is what isTauri looks for.
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
