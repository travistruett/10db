// The desktop shell's edge, for a flow that needs what only the Tauri window has (a Preview's picks):
// an init script standing in for Tauri's IPC, as `@tauri-apps/api/mocks` does in unit tests. It answers
// `daemon_connection` with the e2e daemon, so the UI still runs against the real daemon; it records
// every command the UI sends the shell and lets the spec emit an event the shell would.

/** What the stand-in records, read back by the spec. */
export interface TauriCall {
  readonly cmd: string;
  readonly args: unknown;
}

/** Installs the stand-in; run as an init script, with the e2e daemon's address and token. */
export function fakeTauriWindow(connection: {
  readonly url: string;
  readonly token: string;
}): void {
  const callbacks = new Map<number, (event: unknown) => void>();
  const listeners: { event: string; id: number }[] = [];
  const calls: TauriCall[] = [];
  let next = 1;
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      metadata: {
        currentWindow: { label: 'main' },
        currentWebview: { windowLabel: 'main', label: 'main' },
      },
      transformCallback(callback: (event: unknown) => void) {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      convertFileSrc: (path: string) => path,
      invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args });
        if (cmd === 'daemon_connection')
          return Promise.resolve({ ...connection, protocolVersion: 1, pid: 1 });
        if (cmd === 'plugin:event|listen') {
          listeners.push({ event: String(args['event']), id: Number(args['handler']) });
          return Promise.resolve(args['handler']);
        }
        if (cmd === 'plugin:notification|is_permission_granted') return Promise.resolve(false);
        if (cmd === 'plugin:notification|request_permission') return Promise.resolve('denied');
        return Promise.resolve(null);
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => undefined },
    tauriCalls: calls,
    emitTauri(event: string, payload: unknown) {
      for (const listener of listeners)
        if (listener.event === event)
          callbacks.get(listener.id)?.({ event, id: listener.id, payload });
    },
  });
}
