import type { AppType } from '@10db/daemon';
import { hc } from 'hono/client';

/** Loopback address of the daemon; M1b replaces the default with the sidecar's announced port. */
export const DAEMON_URL = import.meta.env.VITE_DAEMON_URL ?? 'http://127.0.0.1:4317';

export const daemonClient = hc<AppType>(DAEMON_URL);
