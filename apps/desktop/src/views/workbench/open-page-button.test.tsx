import { mintId, type PassId, type TaskId } from '@10db/contracts';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { PROTOCOL_VERSION } from '@10db/contracts';
import { takenHandOff } from '@10db/contracts';
import {
  baseHandlers,
  daemonUrl,
  renderWithDaemon,
  server,
  TEST_CONNECTION,
} from '../../test/daemon';
import { useOpenPage, type OpenPageTarget } from './open-page';
import { OpenPageButton } from './open-page-button';

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

let opened: string[];
beforeEach(() => {
  server.use(...baseHandlers());
  opened = [];
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  localStorage.clear();
});

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  writeText.mockClear();
  vi.restoreAllMocks();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

/** The desktop shell: its open_app_page command records the page it opened. */
function inTauri(): void {
  mockIPC((cmd, args) => {
    // The mocked IPC payload of the shell's open_app_page command.
    if (cmd === 'open_app_page') opened.push((args as { url: string }).url);
  });
}

function Button({ target }: { readonly target: OpenPageTarget }) {
  return <OpenPageButton control={useOpenPage(target)} />;
}

/** The button inside a router, for the Settings link a refusal shows. */
async function renderButton(target: OpenPageTarget) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <Button target={target} /> }),
    history: createMemoryHistory(),
  });
  renderWithDaemon(<RouterProvider router={router} />);
  await screen.findByRole('button', { name: /Open Page|Copy Link/ });
}

function target(overrides: Partial<OpenPageTarget> = {}): OpenPageTarget {
  return {
    passId: mintId('Pass'),
    taskId: mintId('Task'),
    route: '/settings',
    appUrl: 'http://localhost:8800',
    ...overrides,
  };
}

async function click(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await Promise.resolve();
  });
}

describe('OpenPageButton', () => {
  it('opens the page once in the builder’s browser, then copies its link instead', async () => {
    inTauri();
    const page = target();
    await renderButton(page);
    await click('Open Page');
    expect(opened).toEqual(['http://localhost:8800/settings']);
    await click('Copy Link');
    expect(writeText).toHaveBeenCalledWith('http://localhost:8800/settings');
    expect(opened).toHaveLength(1);
  });

  it('remembers an opened page per pass and page across a reload', async () => {
    inTauri();
    const passId: PassId = mintId('Pass');
    const taskId: TaskId = mintId('Task');
    await renderButton(target({ passId, taskId }));
    await click('Open Page');
    cleanup();
    await renderButton(target({ passId, taskId }));
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
    cleanup();
    // Another page of the pass, and the same page in a later pass, open first.
    await renderButton(target({ passId }));
    expect(screen.getByRole('button', { name: 'Open Page' })).toBeTruthy();
    cleanup();
    await renderButton(target({ taskId }));
    expect(screen.getByRole('button', { name: 'Open Page' })).toBeTruthy();
  });

  it.each([
    ['an address that is not loopback', 'http://example.com:8800', /is not a loopback address/],
    ['no app address', null, /No app address is set for this project/],
  ])('refuses %s, says why and links to Settings', async (_name, appUrl, reason) => {
    inTauri();
    await renderButton(target({ appUrl }));
    await click('Open Page');
    expect(opened).toEqual([]);
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings › General' }).getAttribute('href')).toBe(
      '/settings/general',
    );
    expect(screen.getByRole('button', { name: 'Open Page' })).toBeTruthy();
  });

  it("hands 10db's own dev UI the daemon's read-only token, never the app's, on every click", async () => {
    server.use(
      http.get(daemonUrl('/dev-ui/connection'), () =>
        HttpResponse.json({ token: 'dev-ui-read-token' }),
      ),
      http.get(daemonUrl('/health'), () =>
        HttpResponse.json({
          status: 'ok',
          protocolVersion: PROTOCOL_VERSION,
          startedAt: '2026-10-13T12:00:00.000Z',
          devUiOrigin: 'http://localhost:1420',
        }),
      ),
    );
    inTauri();
    await renderButton(target({ appUrl: 'http://localhost:1420', route: '/factory' }));
    await click('Open Page');
    const [url] = opened;
    expect(url?.startsWith('http://localhost:1420/factory#tendb=')).toBe(true);
    expect(takenHandOff(new URL(url ?? '').hash)).toEqual({
      url: TEST_CONNECTION.url,
      token: 'dev-ui-read-token',
    });
    expect(url).not.toContain(TEST_CONNECTION.token);
    // The daemon's port moves at each start, so the dev UI is handed the connection again on every
    // click, never turned to Copy Link; ⌘L still copies the plain address.
    await click('Open Page');
    expect(opened).toHaveLength(2);
    expect(takenHandOff(new URL(opened[1] ?? '').hash)?.url).toBe(TEST_CONNECTION.url);
  });

  it('in a plain browser opens a tab', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(window);
    await renderButton(target());
    await click('Open Page');
    expect(open).toHaveBeenCalledWith('http://localhost:8800/settings', '_blank');
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
  });

  it('still opens and turns to Copy Link when the browser keeps nothing', async () => {
    inTauri();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage is off');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage is off');
    });
    await renderButton(target());
    await click('Open Page');
    expect(opened).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Copy Link' })).toBeTruthy();
  });
});
