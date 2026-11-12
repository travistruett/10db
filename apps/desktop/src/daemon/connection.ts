import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { isTauri } from '../desktop/tauri';
import { takenHandOff } from './dev-ui-handoff';

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  /** A screen being drawn for a session (Shape spec §5.5): the client sends reads only. */
  readonly readOnly?: boolean;
}

export type ConnectionResolver = () => Promise<DaemonConnection>;

/** What `daemon_connection` returns; extra fields (pid, protocolVersion) are dropped. */
const DaemonConnectionSchema = z.object({ url: z.url(), token: z.string().min(1) });

const DEV_DAEMON_URL = 'http://127.0.0.1:4317';
/** Where a dev UI tab keeps the connection Open Page handed it, for its reloads. */
const HANDED_KEY = 'tendb.connection';

/**
 * The connection Open Page handed this tab: taken from the fragment, kept in the tab's session
 * storage and removed from the address bar; on a reload, the kept one. Null when there is none.
 */
function handedConnection(): DaemonConnection | null {
  const handed = takenHandOff(window.location.hash);
  if (handed !== null) {
    try {
      sessionStorage.setItem(HANDED_KEY, JSON.stringify(handed));
    } catch {
      // Held for this load only.
    }
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
    return handed;
  }
  try {
    return takenHandOff(`#tendb=${encodeURIComponent(sessionStorage.getItem(HANDED_KEY) ?? '')}`);
  } catch {
    return null;
  }
}

/**
 * In the app, the shell reads the port and token the running daemon announced. In a browser
 * (Vite dev, Playwright), they come from VITE_DAEMON_URL and VITE_DAEMON_TOKEN.
 */
export const resolveConnection: ConnectionResolver = async () => {
  if (isTauri()) return DaemonConnectionSchema.parse(await invoke('daemon_connection'));
  if (import.meta.env.DEV) {
    const handed = handedConnection();
    if (handed !== null) return handed;
  }
  // Only a dev build reads the token, so one in the build environment never lands in dist/.
  const token = import.meta.env.DEV ? import.meta.env.VITE_DAEMON_TOKEN : undefined;
  if (!token)
    throw new Error(
      "Open this page from the UI Workbench's Open Page in 10db, or set VITE_DAEMON_TOKEN to the daemon UI token (TENDB_DEV_UI_TOKEN)",
    );
  return { url: import.meta.env.VITE_DAEMON_URL ?? DEV_DAEMON_URL, token };
};
