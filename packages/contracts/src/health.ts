import { z } from 'zod';
import { CommitSha } from './self-update';

/** `GET /health`: liveness plus the protocol version the UI checks before talking further. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  protocolVersion: z.int().positive(),
  startedAt: z.iso.datetime(),
  /** The commit this app was built from; null for a source run (dev, tests) and for an older daemon. */
  commit: CommitSha.nullable().default(null),
  /**
   * The browser origin the builder opted in as 10db's own dev UI (`TENDB_DEV_UI_ORIGIN`); Open Page
   * hands a page there the daemon's connection. Null when none is, and for an older daemon.
   */
  devUiOrigin: z.string().nullable().default(null),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * What Open Page hands 10db's own dev UI: the daemon's read-only dev UI token, minted at each start
 * when a dev UI origin is opted in. The app's full token never leaves the app.
 */
export const DevUiConnectionDto = z.object({ token: z.string().min(1) });
export type DevUiConnectionDto = z.infer<typeof DevUiConnectionDto>;
