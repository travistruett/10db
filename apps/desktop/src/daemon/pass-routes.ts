import type { PassJoinRequest, PassRename } from '@10db/contracts';
import type { Hono } from 'hono';
import type { BlankEnv, ToSchema } from 'hono/types';
import { hc } from 'hono/client';
import { clientOptions } from './client';
import type { DaemonConnection } from './connection';

// The Workbench's routes (spec §4) that the daemon's `AppType` does not declare: each is typed here by
// the request its contract names, and its answer is parsed with its contract by `readJson` as every
// other answer is. A route that `AppType` declares is called through `DaemonClient` instead; when
// `AppType` declares all of these, this file goes.

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

type PassRouteSchema = Route<'get', '/passes', { query: { live: string } }> &
  Route<'patch', '/passes/:passId', { json: PassRename }> &
  Route<'post', '/passes/:passId/pages', { json: PassJoinRequest }> &
  Route<'get', '/projects/:projectId/pass-start'> &
  Route<'post', '/projects/:projectId/propose-page-areas'> &
  Route<'get', '/goals/:goalId/pass-pages'> &
  Route<'get', '/tasks/:taskId/turns'> &
  Route<'post', '/tasks/:taskId/turns/:turnId/opened'> &
  Route<'delete', '/tasks/:taskId/kept-work'>;

/** The typed client for the Workbench's routes, sending what `DaemonClient` sends. */
export function createPassRoutesClient(conn: DaemonConnection) {
  return hc<Hono<BlankEnv, PassRouteSchema>>(conn.url, clientOptions(conn));
}
