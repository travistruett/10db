import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, eventStream, renderApp, server } from '../test/daemon';
import { daemonEvent, projectViewDto } from '../test/fixtures';
import { mintId } from '@10db/contracts';
import {
  pagesByStatus,
  passDto,
  passHandlers,
  passViewDto,
  readyItem,
} from '../test/pass-fixtures';

// Workbench spec §4.3: a page becoming Ready notifies "Settings is ready", and a click on it selects
// the page. The notification plugin is the native boundary: its IPC is mocked, and the window's
// Notification, which the plugin sends through, is recorded.

afterEach(() => {
  clearMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Sent {
  readonly title: string;
  readonly options: { readonly id?: number; readonly body?: string };
}

/** The native side: every IPC call in order, the click channel, and each notification sent. */
function mockNative() {
  const calls: string[] = [];
  let clicks: { onmessage: (message: unknown) => void } | null = null;
  const sent: Sent[] = [];
  mockWindows('main');
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === 'plugin:notification|register_listener') {
      // The mocked payload carries the Channel the plugin delivers clicks on.
      clicks = (args as { handler: { onmessage: (message: unknown) => void } }).handler;
    }
    return undefined;
  });
  // The plugin sends through the window's Notification, granted already so it asks nothing.
  const notify = vi.fn(function record(title: string, options: Sent['options']) {
    calls.push('notification');
    sent.push({ title, options });
  });
  vi.stubGlobal('Notification', Object.assign(notify, { permission: 'granted' }));
  vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  // What tauri-plugin-notification 2.8 sends on a click (desktop.rs `performed`): the action, and the
  // notification as it was shown.
  const click = (id: number) =>
    clicks?.onmessage({ actionId: 'tap', inputValue: null, notification: { id, title: '' } });
  return { calls, sent, click };
}

describe('a ready notification', () => {
  it('says which page is ready, and its click selects that page and brings the window forward', async () => {
    const native = mockNative();
    const project = projectViewDto({
      areas: [{ name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' }],
    });
    const { ready, working } = pagesByStatus();
    const view = passViewDto({ pass: passDto({ projectId: project.id }), pages: [working, ready] });
    const item = readyItem(view, ready);
    const sockets: { send(data: string): void }[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/inbox'), () => HttpResponse.json([item])),
      ...passHandlers({ live: [view] }),
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    const { router } = renderApp('/factory');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.send(
      JSON.stringify(
        daemonEvent({ seq: 1, type: 'inbox.opened', entityType: 'inbox', entityId: item.id }),
      ),
    );
    await waitFor(() => {
      expect(native.sent).toHaveLength(1);
    });
    const [notification] = native.sent;
    expect(notification?.title).toBe('Settings is ready');
    expect(typeof notification?.options.id).toBe('number');
    // The click listener was registered before anything was sent.
    expect(native.calls.indexOf('plugin:notification|register_listener')).toBeLessThan(
      native.calls.indexOf('notification'),
    );

    native.click(notification?.options.id ?? -1);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workbench');
    });
    expect(router.state.location.search).toEqual({ task: ready.taskId });
    await waitFor(() => {
      expect(native.calls).toEqual(
        expect.arrayContaining([
          'plugin:window|show',
          'plugin:window|unminimize',
          'plugin:window|set_focus',
        ]),
      );
    });
    const queue = await screen.findByRole('list', { name: 'Pages in this pass' });
    expect(
      within(queue)
        .getByRole('button', { name: /^Settings/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });

  it('a click on the older of two keeps its page when the window then gains focus', async () => {
    const native = mockNative();
    const project = projectViewDto({
      areas: [
        { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
        { name: 'people', globs: ['src/people/**'], role: 'page', route: '/people' },
      ],
    });
    const { ready } = pagesByStatus();
    const people = {
      ...ready,
      taskId: mintId('Task'),
      workstreamId: mintId('Workstream'),
      title: 'People: UI work',
      area: 'People',
      route: '/people',
    };
    const view = passViewDto({ pass: passDto({ projectId: project.id }), pages: [ready, people] });
    const items = [readyItem(view, ready), readyItem(view, people)];
    const sockets: { send(data: string): void }[] = [];
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      http.get(daemonUrl('/inbox'), () => HttpResponse.json(items)),
      ...passHandlers({ live: [view] }),
      ...baseHandlers(),
      eventStream.addEventListener('connection', ({ client }) => {
        sockets.push(client);
      }),
    );
    const { router } = renderApp('/factory');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    for (const [index, item] of items.entries()) {
      sockets[0]?.send(
        JSON.stringify(
          daemonEvent({
            seq: index + 1,
            type: 'inbox.opened',
            entityType: 'inbox',
            entityId: item.id,
          }),
        ),
      );
      await waitFor(() => {
        expect(native.sent).toHaveLength(index + 1);
      });
    }
    expect(native.sent.map((n) => n.title)).toEqual(['Settings is ready', 'People is ready']);
    native.click(native.sent[0]?.options.id ?? -1);
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ task: ready.taskId });
    });
    await screen.findByRole('list', { name: 'Pages in this pass' });
    fireEvent.focus(window);
    expect(router.state.location.search).toEqual({ task: ready.taskId });
  });
});
