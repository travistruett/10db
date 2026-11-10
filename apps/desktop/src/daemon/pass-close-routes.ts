import type { Hono } from 'hono';
import type { BlankEnv, ToSchema } from 'hono/types';
import { hc } from 'hono/client';
import { clientOptions } from './client';
import type { DaemonConnection } from './connection';

// The Workbench's sign-off, take-out preview, pull request, close and Send to Agent routes (spec §5.4,
// §8.3, §9.2), which the daemon's `AppType` does not declare yet: each is typed here by the request its
// contract names, and its answer is parsed with its contract by `readJson` as every other answer is.
// When `AppType` declares all of these, this file goes and its callers use `DaemonClient`.

/**
 * One route, built as Hono builds `AppType`'s: its method, its path (whose params Hono adds) and what it
 * takes besides; any answer, which `readJson` parses.
 */
type Route<Method extends string, Path extends string, In extends object = object> = ToSchema<
  Method,
  Path,
  { in: In },
  Response
>;

type PassCloseRouteSchema = Route<'post', '/passes/:passId/tasks/:taskId/sign-off'> &
  Route<'delete', '/passes/:passId/tasks/:taskId/sign-off'>;

/** The typed client for these routes, sending what `DaemonClient` sends. */
export function createPassCloseRoutesClient(conn: DaemonConnection) {
  return hc<Hono<BlankEnv, PassCloseRouteSchema>>(conn.url, clientOptions(conn));
}
