import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { vi } from 'vitest';

export interface Sent {
  readonly title: string;
  readonly options: { readonly id?: number; readonly body?: string };
}

/** The native side: every IPC call in order, the click channels (each listener has its own), and each notification sent. */
export function mockNative() {
  const calls: string[] = [];
  const clicks: { onmessage: (message: unknown) => void }[] = [];
  const sent: Sent[] = [];
  mockWindows('main');
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === 'plugin:notification|register_listener') {
      // The mocked payload carries the Channel the plugin delivers clicks on.
      clicks.push((args as { handler: { onmessage: (message: unknown) => void } }).handler);
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
  const click = (id: number): void => {
    for (const channel of clicks)
      channel.onmessage({ actionId: 'tap', inputValue: null, notification: { id, title: '' } });
  };
  return { calls, sent, click };
}
