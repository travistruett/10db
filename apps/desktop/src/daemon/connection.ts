import { invoke } from '@tauri-apps/api/core';
import { z } from 'zod';
import { isTauri } from '../desktop/tauri';

export interface DaemonConnection {
  readonly url: string;
  readonly token: string;
}

export type ConnectionResolver = () => Promise<DaemonConnection>;

/** What `daemon_connection` returns; extra fields (pid, protocolVersion) are dropped. */
const DaemonConnectionSchema = z.object({ url: z.url(), token: z.string().min(1) });

const DEV_DAEMON_URL = 'http://127.0.0.1:4317';

/**
 * In the app, the shell reads the port and token the running daemon announced. In a browser
 * (Vite dev, Playwright), they come from VITE_DAEMON_URL and VITE_DAEMON_TOKEN.
 */
export const resolveConnection: ConnectionResolver = async () => {
  if (isTauri()) return DaemonConnectionSchema.parse(await invoke('daemon_connection'));
  // Only a dev build reads the token, so one in the build environment never lands in dist/.
  const token = import.meta.env.DEV ? import.meta.env.VITE_DAEMON_TOKEN : undefined;
  if (!token)
    throw new Error(
      'Set VITE_DAEMON_TOKEN to the daemon UI token (TENDB_DEV_UI_TOKEN) for browser development',
    );
  return { url: import.meta.env.VITE_DAEMON_URL ?? DEV_DAEMON_URL, token };
};
