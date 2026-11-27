import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { isTauri } from '../desktop/tauri';
import { DEV_UI_HANDOFF_KEY, takenHandOff } from '@10db/contracts';

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
  /** A screen being drawn for a session (Shape spec §5.5): the client sends reads only. */
  readonly readOnly?: boolean;
  /** The fetch every call of this connection goes through, when it is not the page's own (the phone's, which watches for a 401). */
  readonly fetch?: typeof fetch;
}

export type ConnectionResolver = () => Promise<DaemonConnection>;

/** What `daemon_connection` returns; extra fields (pid, protocolVersion) are dropped. */
const DaemonConnectionSchema = z.object({ url: z.url(), token: z.string().min(1) });

const DEV_DAEMON_URL = 'http://127.0.0.1:4317';
/** Where `pnpm dev:factory`'s Vite answers the factory daemon's connection (`scripts/factory-vite.ts`). */
const FACTORY_CONNECTION_PATH = '/__tendb/factory-connection';

/**
 * The factory daemon's address and token, read fresh by the dev server on every connect, so a restarted 10db is
 * followed without restarting Vite. A refusal throws, and the provider asks again on its next try.
 */
async function factoryConnection(): Promise<DaemonConnection> {
  const response = await fetch(FACTORY_CONNECTION_PATH, { cache: 'no-store' });
  if (!response.ok)
    throw new Error(`The dev server has no 10db daemon to offer (${String(response.status)})`);
  return DaemonConnectionSchema.parse(await response.json());
}
/** Where a dev UI tab keeps the connection Open in Browser handed it, for its reloads. */
const HANDED_KEY = 'tendb.connection';

/**
 * The connection Open in Browser hands in this load's fragment: kept in the tab's session storage, for
 * its reloads, and removed from the address bar. Null when the fragment carries none.
 */
function takeHandOff(): DaemonConnection | null {
  const handed = takenHandOff(window.location.hash);
  if (handed === null) return null;
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

/** The connection an earlier load of this tab was handed; null when none was. */
function keptHandOff(): DaemonConnection | null {
  try {
    return takenHandOff(
      `#${DEV_UI_HANDOFF_KEY}=${encodeURIComponent(sessionStorage.getItem(HANDED_KEY) ?? '')}`,
    );
  } catch {
    return null;
  }
}

/**
 * In the app, the shell reads the port and token the running daemon announced. In a browser
 * (Vite dev, Playwright), they come from the dev server under `pnpm dev:factory`, or from
 * VITE_DAEMON_URL and VITE_DAEMON_TOKEN.
 */
export const resolveConnection: ConnectionResolver = async () => {
  if (isTauri()) return DaemonConnectionSchema.parse(await invoke('daemon_connection'));
  // Only a dev build reads a token here, so one in the build environment never lands in dist/.
  if (!import.meta.env.DEV) throw new Error('A browser build has no daemon connection');
  // A fresh hand-off first, then the dev server's own token, then what this tab was handed before.
  const handed = takeHandOff();
  if (handed !== null) return handed;
  if (import.meta.env.VITE_DAEMON_FACTORY === '1') return factoryConnection();
  const token = import.meta.env.VITE_DAEMON_TOKEN;
  if (token) return { url: import.meta.env.VITE_DAEMON_URL ?? DEV_DAEMON_URL, token };
  const kept = keptHandOff();
  if (kept !== null) return kept;
  throw new Error(
    "Open this page from the UI Workbench's Open in Browser in 10db, or set VITE_DAEMON_TOKEN to the daemon UI token (TENDB_DEV_UI_TOKEN)",
  );
};
